-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- 0531 (saas): additive repair for registered 0508, which is pushed, so it is not edited.
--
-- lifecycle.prepare_erasure_artifacts is SECURITY DEFINER, so its INSERT INTO platform.tombstones
-- runs as ensemus_migrator, which obeys FORCE RLS. 0508 gave the migrator SELECT policies on
-- tombstones but no INSERT policy for an artifact tombstone (0407's only migrator INSERT policy is
-- for object_record tombstones written from a trigger), so every erasure preparation failed with
-- "new row violates row-level security policy for table tombstones" (saas-erasure CI, run
-- 42587577445) and no tenant could ever be erased.
--
-- The policy below admits exactly the row that function writes: the current tenant's own artifact
-- tombstone with reason TENANT_ERASURE, from the application's service actor, while the tenant's
-- erasure is open (an erasing offboarding and no active legal hold). The function's own checks
-- (lock_delete_tenant, the admitted erasing intent, the fixed loop) are unchanged, and the runtime
-- roles gain nothing: they never act as ensemus_migrator outside reviewed fixed functions. Every
-- tombstone trigger (hold refusal, archive and record barriers, export epoch) still applies.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'ERASURE_TOMBSTONE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('lifecycle.prepare_erasure_artifacts(uuid,integer)') IS NULL OR to_regprocedure('lifecycle.erasure_open(uuid)') IS NULL
  OR to_regprocedure('knowledge.is_service_actor()') IS NULL OR to_regclass('platform.tombstones') IS NULL
  OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='platform.tombstones'::regclass AND p.polname='erasure_artifact_tombstone_birth') THEN
  RAISE EXCEPTION 'ERASURE_TOMBSTONE_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE POLICY erasure_artifact_tombstone_birth ON platform.tombstones FOR INSERT TO ensemus_migrator
 WITH CHECK(organization_id=app.current_organization_id() AND target_type='artifact' AND reason_code='TENANT_ERASURE'
  AND session_user='ensemus_app' AND knowledge.is_service_actor() AND lifecycle.erasure_open(organization_id) IS TRUE);
