-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (EXP-01, KNOW-07, ADR-031 D10). Human review remains pending.
-- A user-shaped GUC binding is not a native human login. Agents inherit ensemus_app, so SET ROLE
-- cannot authorize the human branch of custom-record RLS, including restricted values and relations.
CREATE OR REPLACE FUNCTION objects.active_person(p_manage boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(session_user='ensemus_app' AND app.current_actor_type()='user'
    AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=app.current_organization_id()
      AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active'
      AND (CASE WHEN p_manage THEN m.role IN ('owner','admin') ELSE m.role IN ('owner','admin','member') END)),false)
$$;
--> statement-breakpoint
-- Migration is a separately admitted durable intent. Only the native platform worker may use the
-- service branch; an agent/connector/web login cannot borrow it while a migration is queued.
CREATE FUNCTION objects.migration_worker() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(session_user='ensemus_worker' AND current_user='ensemus_worker'
    AND app.current_actor_type()='service' AND app.current_membership_id() IS NULL,false)
$$;
REVOKE ALL ON FUNCTION objects.migration_worker() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION objects.migration_worker() TO ensemus_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION objects.pending_migration(p_type uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT objects.migration_worker() AND EXISTS(SELECT 1 FROM objects.migrations m
    WHERE m.organization_id=app.current_organization_id() AND m.type_id=p_type AND m.status IN ('queued','running'))
$$;
--> statement-breakpoint
ALTER POLICY object_migrations_update ON objects.migrations
  USING(objects.active_person(true) OR objects.migration_worker()) WITH CHECK(objects.migration_worker());
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN ('objects.active_person(boolean)'::regprocedure,
    'objects.pending_migration(uuid)'::regprocedure,'objects.migration_worker()'::regprocedure)
    AND (p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']))
    OR has_function_privilege('public','objects.migration_worker()','EXECUTE') THEN
    RAISE EXCEPTION 'OBJECT_NATIVE_ACTOR_POSTCONDITION' USING ERRCODE='42501';
  END IF;
END $$;
