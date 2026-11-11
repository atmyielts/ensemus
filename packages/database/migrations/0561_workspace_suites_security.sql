-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-038 D1, D4, D5). Changes here need human review, never agent
-- approval. Not yet reviewed by a person. Error codes: EN121 a consent attempt or a member's connection
-- that could not have started this way, EN122 a consent attempt moving in a way ADR-038 D1 does not
-- allow, EN123 a directory team changed by anything but its own directory sync.

-- Forced RLS and the tenant policy, as on every other integrations table. A test fails if one misses it.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['oauth_authorizations','directory_groups'] LOOP
    EXECUTE format('ALTER TABLE integrations.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE integrations.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_scoped ON integrations.%I TO ensemus_app '
      'USING (organization_id = app.current_organization_id()) '
      'WITH CHECK (organization_id = app.current_organization_id())',
      t);
  END LOOP;
END $$;
--> statement-breakpoint

-- An agent has no business with a consent attempt: it would be choosing whose account to attach, and the
-- row names the sealed verifier and code. The agent role is in ensemus_app, so it is shut out here.
CREATE POLICY agent_none ON integrations.oauth_authorizations AS RESTRICTIVE TO ensemus_agent
  USING (false) WITH CHECK (false);
--> statement-breakpoint

-- What a consent attempt is for, whose it is, and the state it answers to are fixed once written. Only its
-- progress moves: the code arriving, the status, the refusal code and the connection it made.
GRANT SELECT, INSERT ON integrations.oauth_authorizations TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (code_secret_id, status, error_code, connection_id, updated_at)
  ON integrations.oauth_authorizations TO ensemus_app;
--> statement-breakpoint

-- A group keeps its provider ID and its team. Its name and the last pass that saw it move.
GRANT SELECT, INSERT, DELETE ON integrations.directory_groups TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (display_name, seen_generation, updated_at) ON integrations.directory_groups TO ensemus_app;
--> statement-breakpoint

-- A consent attempt starts pending, with nothing yet received, for exactly ten minutes from now. The
-- database sets the times, so no caller can stretch the window. Only the signed-in member it names can
-- start one, and an organization's connection needs connection.manage (ADR-038 D1).
CREATE FUNCTION integrations.check_new_oauth_authorization() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.check_new_oauth_authorization() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER oauth_authorizations_check_new
  BEFORE INSERT ON integrations.oauth_authorizations
  FOR EACH ROW EXECUTE FUNCTION integrations.check_new_oauth_authorization();
--> statement-breakpoint

-- The state machine, here as well as in code, because the web and the worker share a role. The arrows
-- match OAUTH_TRANSITIONS in @ensemus/domain/workspace-suites, and a test holds the two together. On top
-- of the arrows: the code arrives only before expiry and only in the session of the member who started
-- it, which is what stops a forged callback attaching someone else's account; the exchange is the
-- worker's alone; and a connected attempt names a connection that is exactly what it asked for.
CREATE FUNCTION integrations.check_oauth_authorization_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  allowed boolean;
  service boolean;
  starter boolean;
  made record;
BEGIN
  IF TG_RELID<>'integrations.oauth_authorizations'::regclass OR TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'OAUTH_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user='ensemus_agent' THEN
    RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_TRANSITION' USING ERRCODE='EN122';END IF;
  -- Column grants hold this for the application role. This holds it for every role.
  IF ROW(NEW.organization_id, NEW.id, NEW.connector_type, NEW.display_name, NEW.config, NEW.client_kind,
         NEW.client_id, NEW.customer_client_secret_id, NEW.requested_capabilities, NEW.requested_scopes,
         NEW.owner_membership_id, NEW.started_by_membership_id, NEW.state_sha256, NEW.verifier_secret_id,
         NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.organization_id, OLD.id, OLD.connector_type, OLD.display_name, OLD.config, OLD.client_kind,
         OLD.client_id, OLD.customer_client_secret_id, OLD.requested_capabilities, OLD.requested_scopes,
         OLD.owner_membership_id, OLD.started_by_membership_id, OLD.state_sha256, OLD.verifier_secret_id,
         OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_TRANSITION' USING ERRCODE='EN122';END IF;

  IF NEW.status=OLD.status THEN
    IF ROW(NEW.code_secret_id, NEW.error_code, NEW.connection_id)
       IS DISTINCT FROM ROW(OLD.code_secret_id, OLD.error_code, OLD.connection_id) THEN
      RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_TRANSITION' USING ERRCODE='EN122';END IF;
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'pending' THEN NEW.status IN ('code_received', 'denied', 'expired', 'failed')
    WHEN 'code_received' THEN NEW.status IN ('exchanging', 'failed', 'expired')
    WHEN 'exchanging' THEN NEW.status IN ('connected', 'failed')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_TRANSITION' USING ERRCODE='EN122';END IF;

  -- The code is written by the move that says it came, and by nothing else. A refusal code and a
  -- connection are held to their statuses by 0560's checks.
  IF (NEW.code_secret_id IS DISTINCT FROM OLD.code_secret_id) <> (NEW.status='code_received')
    OR (NEW.connection_id IS DISTINCT FROM OLD.connection_id) <> (NEW.status='connected') THEN
    RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_TRANSITION' USING ERRCODE='EN122';END IF;
  IF (NEW.status='code_received' AND now()>=OLD.expires_at)
    OR (NEW.status='expired' AND now()<OLD.expires_at) THEN
    RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_TRANSITION' USING ERRCODE='EN122';END IF;

  IF current_user='ensemus_app' THEN
    service := knowledge.is_service_actor();
    starter := coalesce(app.current_actor_type()='user'
      AND app.current_membership_id()=OLD.started_by_membership_id, false);
    IF (NEW.status IN ('code_received', 'denied') AND NOT starter)
      OR (NEW.status IN ('exchanging', 'connected') AND NOT service)
      OR (NEW.status='failed' AND NOT (service OR (OLD.status='pending' AND starter)))
      OR (NEW.status='expired' AND NOT (service OR starter)) THEN
      RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_TRANSITION' USING ERRCODE='EN122';END IF;
  END IF;

  IF NEW.status='connected' THEN
    SELECT c.connector_type, c.owner_membership_id, c.created_by_membership_id, c.granted_scopes, c.config
      INTO made
      FROM integrations.connections c
     WHERE c.organization_id=NEW.organization_id AND c.id=NEW.connection_id;
    IF NOT FOUND
      OR made.connector_type<>NEW.connector_type
      OR made.owner_membership_id IS DISTINCT FROM NEW.owner_membership_id
      OR made.created_by_membership_id IS DISTINCT FROM NEW.started_by_membership_id
      OR made.config IS DISTINCT FROM NEW.config
      OR NOT (made.granted_scopes <@ NEW.requested_scopes) THEN
      RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_TRANSITION' USING ERRCODE='EN122';END IF;
  END IF;

  NEW.updated_at:=now();
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.check_oauth_authorization_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER oauth_authorizations_check_change
  BEFORE UPDATE ON integrations.oauth_authorizations
  FOR EACH ROW EXECUTE FUNCTION integrations.check_oauth_authorization_change();
--> statement-breakpoint
-- A consent attempt is a record of who attached which account. Only erasure removes one.
CREATE TRIGGER oauth_authorizations_keep
  BEFORE TRUNCATE ON integrations.oauth_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- A group row is the directory sync's own, written only in a transaction that names its connection in
-- ensemus.directory_sync, as the worker's service context. A new link takes a team nobody is in yet and
-- that has no teams under it, so every member a directory team has came from the provider.
CREATE FUNCTION integrations.guard_directory_group() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  sync text := nullif(current_setting('ensemus.directory_sync', true), '');
  target_connection uuid;
BEGIN
  IF TG_RELID<>'integrations.directory_groups'::regclass OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'DIRECTORY_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user NOT IN ('ensemus_app', 'ensemus_agent') THEN
    IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
  END IF;
  target_connection := CASE WHEN TG_OP='DELETE' THEN OLD.connection_id ELSE NEW.connection_id END;
  IF current_user='ensemus_agent' OR NOT knowledge.is_service_actor()
    OR sync IS DISTINCT FROM target_connection::text THEN
    RAISE EXCEPTION 'DIRECTORY_TEAM_SYNC_ONLY' USING ERRCODE='EN123';END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.organization_id, NEW.connection_id, NEW.external_id, NEW.team_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.organization_id, OLD.connection_id, OLD.external_id, OLD.team_id, OLD.created_at) THEN
    RAISE EXCEPTION 'DIRECTORY_TEAM_SYNC_ONLY' USING ERRCODE='EN123';END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM integrations.connections c
                    WHERE c.organization_id=NEW.organization_id AND c.id=NEW.connection_id AND c.state='active')
      OR NOT EXISTS (SELECT 1 FROM org.teams t
                      WHERE t.organization_id=NEW.organization_id AND t.id=NEW.team_id AND t.parent_id IS NULL)
      OR EXISTS (SELECT 1 FROM org.teams t WHERE t.organization_id=NEW.organization_id AND t.parent_id=NEW.team_id)
      OR EXISTS (SELECT 1 FROM org.team_memberships m
                  WHERE m.organization_id=NEW.organization_id AND m.team_id=NEW.team_id) THEN
      RAISE EXCEPTION 'DIRECTORY_TEAM_SYNC_ONLY' USING ERRCODE='EN123';END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.guard_directory_group() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER directory_groups_sync_only
  BEFORE INSERT OR UPDATE OR DELETE ON integrations.directory_groups
  FOR EACH ROW EXECUTE FUNCTION integrations.guard_directory_group();
--> statement-breakpoint

-- A directory team changes only with the provider (ADR-038 D4). A person cannot add themselves to
-- "Finance" here to read Finance's files, rename it, delete it, move it, or hang another team under it.
-- Only a transaction whose ensemus.directory_sync names the connection that owns the team may. Rows
-- removed by a cascade run as the table's owner, so removing a person or a team elsewhere still works.
CREATE FUNCTION integrations.guard_directory_team() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  sync text := nullif(current_setting('ensemus.directory_sync', true), '');
  row_org uuid;
  touched uuid[];
  owner_connection uuid;
BEGIN
  IF TG_RELID NOT IN ('org.teams'::regclass, 'org.team_memberships'::regclass)
    OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'DIRECTORY_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user NOT IN ('ensemus_app', 'ensemus_agent') THEN
    IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
  END IF;
  row_org := CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF TG_RELID='org.team_memberships'::regclass THEN
    touched := CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.team_id] WHEN 'DELETE' THEN ARRAY[OLD.team_id]
                          ELSE ARRAY[OLD.team_id, NEW.team_id] END;
  ELSE
    -- The team itself when it is renamed, moved or deleted, and its parent when one is set.
    touched := CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.parent_id] WHEN 'DELETE' THEN ARRAY[OLD.id]
                          ELSE ARRAY[OLD.id, NEW.parent_id] END;
  END IF;
  FOR owner_connection IN
    SELECT g.connection_id FROM integrations.directory_groups g
     WHERE g.organization_id=row_org AND g.team_id=ANY(touched)
  LOOP
    -- Web and workers share ensemus_app, so the setting alone is not enough: only the sync's service
    -- context may change these. A revoked connection's teams are removed by the worker's cleanup.
    IF current_user='ensemus_agent' OR sync IS DISTINCT FROM owner_connection::text
      OR NOT knowledge.is_service_actor() THEN
      RAISE EXCEPTION 'DIRECTORY_TEAM_SYNC_ONLY' USING ERRCODE='EN123';END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.guard_directory_team() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teams_directory_sync_only
  BEFORE INSERT OR UPDATE OR DELETE ON org.teams
  FOR EACH ROW EXECUTE FUNCTION integrations.guard_directory_team();
--> statement-breakpoint
CREATE TRIGGER team_memberships_directory_sync_only
  BEFORE INSERT OR UPDATE OR DELETE ON org.team_memberships
  FOR EACH ROW EXECUTE FUNCTION integrations.guard_directory_team();
--> statement-breakpoint

-- 0409's team guard asks for a person with member.manage, which the directory sync never is. This is
-- 0409's text with one addition: the sync's service context, in a transaction naming its connection,
-- may create a top-level team for a new group, and may change or delete a team and its members only
-- where that connection's group owns the team. Everything else reaches 0409's checks unchanged.
CREATE OR REPLACE FUNCTION org.guard_team_management() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE row_org uuid;operation text;expected jsonb;target text;sync text;team uuid;
BEGIN
  IF TG_RELID NOT IN('org.teams'::regclass,'org.team_memberships'::regclass) OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user IN('ensemus_app','ensemus_agent') THEN
    row_org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
    IF row_org IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
    sync:=nullif(current_setting('ensemus.directory_sync',true),'');
    IF sync IS NOT NULL AND current_user='ensemus_app' AND knowledge.is_service_actor() THEN
      IF TG_RELID='org.teams'::regclass THEN
        IF TG_OP='INSERT' AND NEW.parent_id IS NULL AND EXISTS(SELECT 1 FROM integrations.connections c
          WHERE c.organization_id=row_org AND c.id::text=sync AND c.state='active') THEN RETURN NEW;END IF;
        IF TG_OP IN('UPDATE','DELETE') AND (TG_OP='DELETE' OR NEW.parent_id IS NULL) AND EXISTS(SELECT 1 FROM integrations.directory_groups g
          WHERE g.organization_id=row_org AND g.team_id=OLD.id AND g.connection_id::text=sync) THEN
          IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
        END IF;
      ELSE
        team:=CASE WHEN TG_OP='DELETE' THEN OLD.team_id ELSE NEW.team_id END;
        IF EXISTS(SELECT 1 FROM integrations.directory_groups g
          WHERE g.organization_id=row_org AND g.team_id=team AND g.connection_id::text=sync) THEN
          IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
        END IF;
      END IF;
    END IF;
    IF TG_RELID='org.teams'::regclass THEN
      IF TG_OP='INSERT' AND NEW.parent_id IS NULL THEN
        operation:='team_insert';target:=NEW.id::text;
        expected:=jsonb_build_object('id',NEW.id,'name',NEW.name,'parent_id',NEW.parent_id,'created_at',NEW.created_at);
      ELSIF TG_OP='UPDATE' AND (to_jsonb(NEW)-'parent_id')=(to_jsonb(OLD)-'parent_id') THEN
        operation:='team_parent';target:=NEW.id::text;expected:=jsonb_build_object('id',NEW.id,'parent_id',NEW.parent_id);
      END IF;
    ELSIF TG_OP='INSERT' THEN
      operation:='team_member';target:=NEW.team_id::text||':'||NEW.membership_id::text;
      expected:=jsonb_build_object('team_id',NEW.team_id,'membership_id',NEW.membership_id);
    END IF;
    IF operation IS NOT NULL AND sovereign.consume_import_effect(operation,target,expected) THEN RETURN NEW;END IF;
    IF NOT app.interactive_privilege_allowed('member.manage') THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
--> statement-breakpoint

-- 0409's connection guard asks for a person with connection.manage, which the exchange worker never is.
-- This is 0409's text with three additions. A member's own connection is born only of that member's
-- consent. The worker's service context, in a transaction naming the attempt in ensemus.oauth_exchange,
-- may create exactly the connection that attempt asked for, while it is exchanging, with at most the
-- scopes it requested. And the worker may narrow a connection's granted scopes when a refresh reports
-- fewer, which takes access away and never adds it (ADR-038 D3).
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
  IF NOT app.interactive_privilege_allowed('connection.manage') THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- The two new tables are tenant content, so the eraser reaches them (0501), the counts-only erasure
-- projection knows them and fences their birth while a tenant is erasing (0518), and restore admission
-- covers the eraser's reach (0422). 0518's installer lists every tenant table it accepts and refuses any
-- other, so its reviewed list gains exactly these two names and nothing else changes.
SELECT lifecycle.extend_eraser_reach();
--> statement-breakpoint
DO $$
DECLARE
  definition text;
  header constant text := 'CREATE OR REPLACE FUNCTION lifecycle.install_erasure_count_projection(';
  anchor constant text := '''integrations.mcp_tools'',';
  widened constant text := '''integrations.directory_groups'',''integrations.mcp_tools'',''integrations.oauth_authorizations'',';
BEGIN
  definition := pg_get_functiondef('lifecycle.install_erasure_count_projection()'::regprocedure);
  IF strpos(definition, header)<>1
    OR (length(definition)-length(replace(definition, anchor, '')))/length(anchor)<>1
    OR strpos(definition, '''integrations.oauth_authorizations''')<>0
    OR strpos(definition, '''integrations.directory_groups''')<>0 THEN
    RAISE EXCEPTION 'ERASURE_INVENTORY_DEFINITION_CHANGED' USING ERRCODE='EN850';END IF;
  EXECUTE replace(definition, anchor, widened);
END $$;
--> statement-breakpoint
SELECT lifecycle.install_erasure_count_projection();
--> statement-breakpoint
SELECT identity.extend_auth_restore_admission();
