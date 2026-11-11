-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-038 D5). Changes here need human review, never agent approval. Not yet
-- reviewed by a person. Defence in depth from the stage 2 security review, and nothing else changes:
-- 1. 0563's consent start: a member's own consent must be owned by the member who starts it. 0563 checked
--    that the starter is the person signed in, and never that the owner is the starter, so the
--    application alone kept a member from starting a consent for someone else's own account.
-- 2. 0564's connection guard: the code exchange may create a member's own connection only for the member
--    who started the consent, so the connection it makes is owned by the same person as the attempt.
-- Each function below is the earlier migration's text exactly, with the one condition added.

-- 1. 0563's text, with `NEW.owner_membership_id IS DISTINCT FROM NEW.started_by_membership_id` added to
-- the member branch. EN121 as before.
CREATE OR REPLACE FUNCTION integrations.check_new_oauth_authorization() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE allowed text[];
BEGIN
  IF TG_RELID<>'integrations.oauth_authorizations'::regclass OR TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'OAUTH_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user='ensemus_agent' THEN
    RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_START' USING ERRCODE='EN121';END IF;
  IF NEW.status<>'pending' OR NEW.code_secret_id IS NOT NULL OR NEW.connection_id IS NOT NULL
    OR NEW.error_code IS NOT NULL THEN
    RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_START' USING ERRCODE='EN121';END IF;
  NEW.created_at:=now();
  NEW.updated_at:=now();
  NEW.expires_at:=now()+interval '10 minutes';
  IF current_user='ensemus_app' THEN
    IF app.current_actor_type() IS DISTINCT FROM 'user'
      OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR NEW.started_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
      RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_START' USING ERRCODE='EN121';END IF;
    IF NEW.owner_membership_id IS NULL AND NOT app.interactive_privilege_allowed('connection.manage') THEN
      RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
    IF NEW.owner_membership_id IS NOT NULL THEN
      SELECT s.member_capabilities INTO allowed FROM integrations.suite_settings s
       WHERE s.organization_id=NEW.organization_id;
      IF NOT FOUND THEN allowed:=ARRAY['mail','calendar']::text[];END IF;
      IF NEW.owner_membership_id IS DISTINCT FROM NEW.started_by_membership_id
        OR cardinality(NEW.requested_capabilities)=0
        OR NOT (NEW.requested_capabilities <@ allowed)
        OR NOT (NEW.requested_capabilities <@ ARRAY['mail','calendar','documents','chat']::text[]) THEN
        RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_START' USING ERRCODE='EN121';END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.check_new_oauth_authorization() FROM PUBLIC;
--> statement-breakpoint

-- 2. 0564's text, with the exchange branch also requiring a member's own connection to be owned by the
-- member who created it, who is the member who started the consent. Anything else falls through to the
-- branches after it: a member-owned insert outside the exchange is refused with EN121, as before.
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.guard_connection_management() FROM PUBLIC;
