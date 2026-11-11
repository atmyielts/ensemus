-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-038 D5, D6). Changes here need human review, never agent approval. Not yet
-- reviewed by a person. Two additions to 0563, and nothing else changes:
-- 1. The suite upkeep may delete a suite read nobody will collect: one whose run has ended, or one older
--    than an hour. Only the connector worker's service context, and only those rows. Until now nothing but
--    the tenant eraser deleted one, so provider content an agent never collected stayed in the row.
-- 2. The member who owns a connection may revoke it themselves (ADR-038 D5), and change nothing else.

-- 1. Uncollected suite reads. A read is collected while its run is live, in seconds, so an hour is far
-- past any collect. The run statuses below are the ended ones, `isTerminalAgentRun` in
-- packages/domain/src/ai.ts, and a unit test holds the two lists equal.
GRANT DELETE ON integrations.suite_reads TO ensemus_app;
--> statement-breakpoint
CREATE POLICY suite_reads_sweep ON integrations.suite_reads AS RESTRICTIVE FOR DELETE TO ensemus_app
  USING (
    current_user = 'ensemus_app' AND knowledge.is_service_actor()
    AND (
      created_at < now() - interval '1 hour'
      OR NOT EXISTS (
        SELECT 1 FROM ai.agent_runs r
         WHERE r.organization_id = suite_reads.organization_id AND r.id = suite_reads.run_id
           AND r.status NOT IN ('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified'))
    ));
--> statement-breakpoint

-- 2. 0561's connection guard, with one addition: the member who owns a connection may revoke it
-- themselves. Exactly one change is allowed: state from anything else to revoked, the version moved on by
-- one, and revoked_at and updated_at stamped now here, whatever the caller sent. Nothing else about the
-- row may change with it, not even its last error, and only the owner's own membership, signed in as a
-- person, may do it. Revoking takes access away and never adds it, so it needs no privilege beyond owning
-- the connection. Anyone else's change still needs connection.manage, as before. Everything else is 0561's
-- text unchanged.
CREATE OR REPLACE FUNCTION integrations.guard_connection_management() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE expected jsonb;exchange text;
BEGIN
  IF TG_RELID<>'integrations.connections'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user NOT IN('ensemus_app','ensemus_agent') THEN RETURN NEW;END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  exchange:=nullif(current_setting('ensemus.oauth_exchange',true),'');
  IF TG_OP='INSERT' AND exchange IS NOT NULL AND current_user='ensemus_app' AND knowledge.is_service_actor()
    AND NEW.state='active' AND NEW.credential_secret_id IS NOT NULL AND cardinality(NEW.granted_scopes)>0
    AND NEW.revoked_at IS NULL AND NEW.version=1 AND NEW.last_error_code IS NULL AND NEW.last_error_at IS NULL
    AND EXISTS(SELECT 1 FROM integrations.oauth_authorizations a
      WHERE a.organization_id=NEW.organization_id AND a.id::text=exchange AND a.status='exchanging'
        AND a.connector_type=NEW.connector_type AND a.config=NEW.config
        AND a.owner_membership_id IS NOT DISTINCT FROM NEW.owner_membership_id
        AND a.started_by_membership_id IS NOT DISTINCT FROM NEW.created_by_membership_id
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
  IF TG_OP='UPDATE' AND current_user='ensemus_app' AND knowledge.is_service_actor()
    AND NEW.granted_scopes <@ OLD.granted_scopes
    AND (to_jsonb(NEW)-ARRAY['granted_scopes','last_error_code','last_error_at','updated_at','version'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['granted_scopes','last_error_code','last_error_at','updated_at','version']) THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' AND current_user='ensemus_app' AND app.current_actor_type()='user'
    AND OLD.owner_membership_id IS NOT NULL AND OLD.owner_membership_id=app.current_membership_id()
    AND OLD.state<>'revoked' AND NEW.state='revoked' AND NEW.version=OLD.version+1
    AND (to_jsonb(NEW)-ARRAY['state','revoked_at','updated_at','version'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revoked_at','updated_at','version']) THEN
    NEW.revoked_at:=now();NEW.updated_at:=now();RETURN NEW;END IF;
  IF NOT app.interactive_privilege_allowed('connection.manage') THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
