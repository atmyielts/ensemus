-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-039 D2 and D3, ADR-038 "Known gaps", LIFE-04). Changes here need human review,
-- never agent approval. Not yet reviewed by a person, and not yet run.
--
-- With the workers on their own logins (0700), the rules only one worker should pass now ask for that
-- worker by its login, and no longer for the actor type, which any session sets for itself:
-- 1. Suite reads (0563, 0564). Only the connector worker answers a suite read, reads its arguments or
--    sweeps one nobody collected. ensemus_app loses every grant on the table, so the web tier, which shares
--    that role, can neither see a model's arguments nor write provider content back, whatever it binds.
-- 2. The connection guard (0565). Only the connector worker's code exchange makes a connection from a
--    consent, and only it narrows a connection's scopes. And one new branch, for LIFE-04: the platform
--    worker revokes a connection as a service once its tenant's offboarding transition has ended and its
--    connections are not yet recorded as revoked. Everything else is 0565's text, read through 0700's tier
--    functions.

-- 1. Suite reads.
REVOKE ALL ON integrations.suite_reads FROM ensemus_app;
--> statement-breakpoint
GRANT SELECT (organization_id, proposal_id, run_id, step_id, connection_id, tool_id, tool_version, args,
              resource_external_id, status, result_code, output_media_type, output_classification,
              created_at, updated_at)
  ON integrations.suite_reads TO ensemus_connector, ensemus_agent;
--> statement-breakpoint
GRANT UPDATE (status, result_code, output, output_media_type, output_classification, updated_at)
  ON integrations.suite_reads TO ensemus_connector, ensemus_agent;
--> statement-breakpoint
GRANT DELETE ON integrations.suite_reads TO ensemus_connector;
--> statement-breakpoint
-- 0563's INSERT and SELECT (output) to ensemus_agent stand. Before this they reached the agent's other
-- columns through ensemus_app, which no longer holds them, so the agent gets them above by name.
ALTER POLICY suite_reads_actor ON integrations.suite_reads
  USING (current_user = 'ensemus_agent'
    OR (current_user = 'ensemus_connector' AND session_user = 'ensemus_connector'
        AND knowledge.is_service_actor()))
  WITH CHECK (current_user = 'ensemus_agent'
    OR (current_user = 'ensemus_connector' AND session_user = 'ensemus_connector'
        AND knowledge.is_service_actor()));
--> statement-breakpoint
ALTER POLICY suite_reads_sweep ON integrations.suite_reads
  USING (
    current_user = 'ensemus_connector' AND session_user = 'ensemus_connector'
    AND knowledge.is_service_actor()
    AND (
      created_at < now() - interval '1 hour'
      OR NOT EXISTS (
        SELECT 1 FROM ai.agent_runs r
         WHERE r.organization_id = suite_reads.organization_id AND r.id = suite_reads.run_id
           AND r.status NOT IN ('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified'))
    ));
--> statement-breakpoint
-- 0563's text, with `service` meaning the connector worker's login.
CREATE OR REPLACE FUNCTION integrations.check_suite_read() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  service boolean;
  agent boolean;
BEGIN
  IF TG_RELID<>'integrations.suite_reads'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'SUITE_READ_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  service := current_user='ensemus_connector' AND session_user='ensemus_connector' AND knowledge.is_service_actor();
  agent := current_user='ensemus_agent' AND app.current_actor_type()='agent';
  IF TG_OP='INSERT' THEN
    IF NOT agent OR NEW.status<>'requested' OR NEW.result_code IS NOT NULL OR NEW.output IS NOT NULL
      OR NEW.output_media_type IS NOT NULL OR NEW.output_classification IS NOT NULL
      OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR NOT EXISTS (
        SELECT 1 FROM ai.tool_proposals p
         WHERE p.organization_id=NEW.organization_id AND p.id=NEW.proposal_id AND p.run_id=NEW.run_id
           AND p.tool_id=NEW.tool_id AND p.tool_version=NEW.tool_version AND p.status='running'
           AND p.external_action_id IS NULL)
      OR NOT EXISTS (
        SELECT 1 FROM ai.execution_steps e
         WHERE e.organization_id=NEW.organization_id AND e.id=NEW.step_id AND e.run_id=NEW.run_id) THEN
      RAISE EXCEPTION 'SUITE_READ_INVALID_START' USING ERRCODE='EN125';END IF;
    NEW.created_at:=now();
    NEW.updated_at:=now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['status','result_code','output','output_media_type','output_classification','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','result_code','output','output_media_type','output_classification','updated_at']) THEN
    RAISE EXCEPTION 'SUITE_READ_IMMUTABLE' USING ERRCODE='EN125';END IF;
  IF NEW.status=OLD.status THEN
    IF (to_jsonb(NEW)-ARRAY['updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at']) THEN
      RAISE EXCEPTION 'SUITE_READ_INVALID_CHANGE' USING ERRCODE='EN125';END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status='requested' AND NEW.status='read' AND service AND NEW.result_code IS NULL
      AND NEW.output IS NOT NULL AND NEW.output_media_type IS NOT NULL AND NEW.output_classification IS NOT NULL)
    OR (OLD.status='requested' AND NEW.status='refused' AND (service OR agent) AND NEW.result_code IS NOT NULL
      AND NEW.output IS NULL AND NEW.output_media_type IS NULL AND NEW.output_classification IS NULL)
    OR (OLD.status IN ('read','refused') AND NEW.status='collected' AND agent AND NEW.output IS NULL)
  ) THEN
    RAISE EXCEPTION 'SUITE_READ_INVALID_CHANGE' USING ERRCODE='EN125';END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.check_suite_read() FROM PUBLIC;
--> statement-breakpoint

-- 2. 0565's connection guard. The exchange and the scope narrowing ask for the connector worker's login;
-- a worker login otherwise reads as ensemus_app, as 0700 made it; and the offboarding revoke is new.
CREATE OR REPLACE FUNCTION integrations.guard_connection_management() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE expected jsonb;exchange text;
BEGIN
  IF TG_RELID<>'integrations.connections'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF app.tier_current_user() NOT IN('ensemus_app','ensemus_agent') THEN RETURN NEW;END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  exchange:=nullif(current_setting('ensemus.oauth_exchange',true),'');
  IF TG_OP='INSERT' AND exchange IS NOT NULL
    AND current_user='ensemus_connector' AND session_user='ensemus_connector' AND knowledge.is_service_actor()
    AND NEW.state='active' AND NEW.credential_secret_id IS NOT NULL AND cardinality(NEW.granted_scopes)>0
    AND NEW.revoked_at IS NULL AND NEW.version=1 AND NEW.last_error_code IS NULL AND NEW.last_error_at IS NULL
    AND EXISTS(SELECT 1 FROM integrations.oauth_authorizations a
      WHERE a.organization_id=NEW.organization_id AND a.id::text=exchange AND a.status='exchanging'
        AND a.connector_type=NEW.connector_type AND a.config=NEW.config
        AND a.owner_membership_id IS NOT DISTINCT FROM NEW.owner_membership_id
        AND a.started_by_membership_id IS NOT DISTINCT FROM NEW.created_by_membership_id
        AND (NEW.owner_membership_id IS NULL OR NEW.owner_membership_id=NEW.created_by_membership_id)
        AND NEW.granted_scopes <@ a.requested_scopes) THEN RETURN NEW;END IF;
  IF TG_OP='INSERT' AND NEW.owner_membership_id IS NOT NULL THEN
    RAISE EXCEPTION 'CONNECTION_OWNER_NEEDS_CONSENT' USING ERRCODE='EN121';END IF;
  IF TG_OP='INSERT' AND NEW.state='disabled' AND NEW.credential_secret_id IS NULL AND NEW.config='{}'::jsonb
    AND cardinality(NEW.granted_scopes)=0 AND NEW.revoked_at IS NULL AND NEW.version=1 AND NEW.last_error_code IS NULL AND NEW.last_error_at IS NULL THEN
    expected:=jsonb_build_object('id',NEW.id,'connector_type',NEW.connector_type,'display_name',NEW.display_name,'state',NEW.state,
      'credential_secret_id',NEW.credential_secret_id,'config',NEW.config,'granted_scopes',to_jsonb(NEW.granted_scopes),
      'created_by_membership_id',NEW.created_by_membership_id,'created_at',NEW.created_at);
    IF sovereign.consume_import_effect('connection_insert',NEW.id::text,expected) THEN RETURN NEW;END IF;
  END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['last_error_code','last_error_at','updated_at','version'])
    IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['last_error_code','last_error_at','updated_at','version']) THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE'
    AND current_user='ensemus_connector' AND session_user='ensemus_connector' AND knowledge.is_service_actor()
    AND NEW.granted_scopes <@ OLD.granted_scopes
    AND (to_jsonb(NEW)-ARRAY['granted_scopes','last_error_code','last_error_at','updated_at','version'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['granted_scopes','last_error_code','last_error_at','updated_at','version']) THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' AND app.tier_current_user()='ensemus_app' AND app.current_actor_type()='user'
    AND OLD.owner_membership_id IS NOT NULL AND OLD.owner_membership_id=app.current_membership_id()
    AND OLD.state<>'revoked' AND NEW.state='revoked' AND NEW.version=OLD.version+1
    AND (to_jsonb(NEW)-ARRAY['state','revoked_at','updated_at','version'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revoked_at','updated_at','version']) THEN
    NEW.revoked_at:=now();NEW.updated_at:=now();RETURN NEW;END IF;
  -- LIFE-04: the offboarding revoke. One change only, the same as a member's own revoke, by the platform
  -- worker's service context, for a tenant in offboarding whose transition has ended and whose
  -- connections are not yet recorded as revoked. Revoking takes access away and never adds it.
  IF TG_OP='UPDATE'
    AND current_user='ensemus_worker' AND session_user='ensemus_worker' AND knowledge.is_service_actor()
    AND OLD.state<>'revoked' AND NEW.state='revoked' AND NEW.version=OLD.version+1
    AND (to_jsonb(NEW)-ARRAY['state','revoked_at','updated_at','version'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revoked_at','updated_at','version'])
    AND EXISTS(SELECT 1 FROM org.organizations o WHERE o.id=NEW.organization_id AND o.lifecycle='offboarding')
    AND EXISTS(SELECT 1 FROM lifecycle.offboardings f WHERE f.organization_id=NEW.organization_id
      AND f.state='in_transition' AND f.connections_revoked_at IS NULL
      AND f.transition_ends_at IS NOT NULL AND f.transition_ends_at<=now()) THEN
    NEW.revoked_at:=now();NEW.updated_at:=now();RETURN NEW;END IF;
  IF NOT app.interactive_privilege_allowed('connection.manage') THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.guard_connection_management() FROM PUBLIC;
