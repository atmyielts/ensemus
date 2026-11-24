-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-031 D7/D9, ADR-039 D1). Human review remains pending.
-- Native worker credentials are not a human reader, even after copying user bindings or SET ROLE.
DO $$ BEGIN
  IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles
    WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'HUMAN_READER_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;
END $$;
--> statement-breakpoint
-- This answers only the native login. Each caller must still check actor, active membership and ACL.
-- session_user survives SET ROLE and calls through a fixed security-definer effect.
CREATE FUNCTION app.is_web_login() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT session_user='ensemus_app'
$$;
REVOKE ALL ON FUNCTION app.is_web_login() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_web_login() TO ensemus_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION objects.active_person(p_manage boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(app.is_web_login() AND app.current_actor_type()='user'
    AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=app.current_organization_id()
      AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active'
      AND (CASE WHEN p_manage THEN m.role IN ('owner','admin') ELSE m.role IN ('owner','admin','member') END)),false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION studio.current_author() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(app.is_web_login() AND (app.current_actor_type()='user' AND EXISTS(SELECT 1 FROM org.memberships m
   WHERE m.organization_id=app.current_organization_id() AND m.id=app.current_membership_id()
     AND m.user_id=app.current_user_id() AND m.status='active' AND m.role IN ('owner','admin'))),false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION experience.current_person(p_manage boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(app.is_web_login() AND (app.current_actor_type()='user' AND EXISTS(SELECT 1 FROM org.memberships m
 WHERE m.organization_id=app.current_organization_id() AND m.id=app.current_membership_id()
 AND m.user_id=app.current_user_id() AND m.status='active'
 AND (NOT p_manage OR m.role IN ('owner','admin')))),false)
$$;
--> statement-breakpoint
-- Preserve the immutable-input, request/outbox and active-author witnesses. A native role check
-- narrows this existing service intent; neither a web process nor an agent can borrow its selector.
CREATE OR REPLACE FUNCTION studio.simulation_worker(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(session_user='ensemus_worker' AND current_user='ensemus_worker' AND app.current_membership_id() IS NULL AND (app.current_actor_type()='service' AND current_setting('app.studio_simulation_id',true)=p_id::text
 AND EXISTS(SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o
   ON o.organization_id=e.organization_id AND o.event_id=e.id JOIN org.memberships m
   ON m.organization_id=e.organization_id AND m.id=e.actor_id AND m.status='active' AND m.role IN ('owner','admin')
   WHERE e.organization_id=app.current_organization_id() AND e.aggregate_type='simulation_run' AND e.aggregate_id=p_id
     AND e.event_type='simulation.requested' AND e.actor_type='membership')),false)
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    WHERE p.oid IN ('app.is_web_login()'::regprocedure,'objects.active_person(boolean)'::regprocedure,
      'studio.current_author()'::regprocedure,'experience.current_person(boolean)'::regprocedure,
      'studio.simulation_worker(uuid)'::regprocedure)
      AND (p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
        OR r.rolname<>'ensemus_migrator' OR has_function_privilege('public',p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'NATIVE_READER_POSTCONDITION' USING ERRCODE='42501';
  END IF;
END $$;
