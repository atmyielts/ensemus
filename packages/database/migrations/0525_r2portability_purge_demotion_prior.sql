-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-029). Changes here need human review, never agent approval.
-- Additive repair for 0516, which is registered and pushed, so it is not edited. 0419 is unchanged.
--
-- 0516's knowledge.guard_raw_purge_completion (BEFORE trigger purge_jobs_raw_completion) wrote
-- NEW.prior_completed_at:=coalesce(OLD.prior_completed_at,OLD.completed_at) on every completed ->
-- failed demotion of knowledge.purge_jobs. 0419's knowledge.guard_delegated_work_purge_proof (BEFORE
-- trigger source_purge_delegated_work_proof, which fires after it by name) protects that column: it
-- may change only in the two migrator-session requalifications (0419 WORK_CONTROL_PROOF_REQUIRED and
-- 0515 RESTORE_MATERIAL_REQUALIFICATION_REQUIRED), each of which already sets it explicitly to the
-- same value. Every runtime demotion of a first completion therefore became a prior_completed_at
-- change from an ensemus_app session and was refused with PURGE_PRIOR_COMPLETION_IMMUTABLE (42501):
-- 0508 lifecycle.invalidate_source_delete_completion (restored archive bytes, new deletion claims),
-- 0516 lifecycle.invalidate_raw_source_completion and lifecycle.reconcile_raw_source_completions.
-- The invalidation that must win (a completion certificate is no longer true) could not happen, and
-- the statement that reported the lost proof failed with it.
--
-- The body below is 0516's text without that one assignment. Demotion still clears completed_at,
-- and every completion check is unchanged. prior_completed_at stays exactly as 0419 protects it:
-- written only by the migrator requalifications, and preserved across later demotions because no
-- runtime path can change it. No grant, policy or other trigger changes.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR to_regprocedure('knowledge.guard_raw_purge_completion()') IS NULL
  OR to_regprocedure('knowledge.guard_delegated_work_purge_proof()') IS NULL
  OR to_regprocedure('lifecycle.raw_source_material_complete(uuid,bigint,uuid,uuid)') IS NULL THEN
  RAISE EXCEPTION 'RAW_PURGE_DEMOTION_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION knowledge.guard_raw_purge_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE source_version bigint;previous text:=current_setting('lifecycle.raw_object_org',true);
BEGIN
 IF TG_RELID<>'knowledge.purge_jobs'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN RAISE EXCEPTION 'INVALID_RAW_PURGE_TARGET' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND OLD.state='completed' AND NEW.state='failed' THEN
  NEW.completed_at:=NULL;
 END IF;
 IF NEW.state='completed' THEN
  IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
   RAISE EXCEPTION 'RAW_NATIVE_COMPLETION_REQUIRED' USING ERRCODE='42501';END IF;
  PERFORM set_config('lifecycle.raw_object_org',NEW.organization_id::text,true);
  SELECT s.version INTO source_version FROM knowledge.sources s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.source_id;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR source_version IS NULL
   OR lifecycle.raw_source_material_complete(NEW.source_id,source_version,NEW.id,ai.current_material_restore_generation()) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'RAW_SOURCE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_raw_purge_completion() FROM PUBLIC;
