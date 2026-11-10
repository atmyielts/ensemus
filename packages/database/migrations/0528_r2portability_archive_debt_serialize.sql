-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-030 D8). Changes here need human review, never agent approval.
-- Additive repair for 0508, which is registered and pushed, so it is not edited. 0415 is unchanged.
--
-- When restored storage still holds archive bytes whose header recorded a physical purge,
-- sovereign.block_restored_archive_file reopens that header (physical_purged_at -> NULL). Two AFTER
-- UPDATE row triggers on sovereign.imported_archive_files then invalidate the tenant's completed
-- source-purge certificates, in trigger-name order:
--   archive_0508_restore_debt (0508) inserts lifecycle.object_restore_debts, whose AFTER INSERT
--     trigger lifecycle.invalidate_source_delete_completion locks every purge job FOR UPDATE NOWAIT;
--   archive_file_proof_lost (0415) calls sovereign.invalidate_archive_source_completions, which
--     locks the same jobs FOR UPDATE and waits, documented there as safe because source completion
--     reads archive metadata without row locks, so this header -> job order has no inverse.
-- The 0508 trigger fires first, so a source completion that is still uncommitted made the NOWAIT
-- fail with 55P03 and rolled back the whole reopening: the restored bytes stayed recorded as purged,
-- no restore debt was kept, and the completion committed as a certificate the bytes contradict.
-- 0415's serialization could never run.
--
-- For an 'archive' restore debt only, the lock below now waits, which is the exact lock and order
-- 0415's trigger takes in the same statement. Deletion claims and 'derived' restore debts keep
-- 0508's NOWAIT unchanged, since their callers may already hold a source or job lock. The demotion
-- itself, its tenant check, its private selector and its restoration are 0508's text.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR to_regprocedure('lifecycle.invalidate_source_delete_completion()') IS NULL
  OR to_regprocedure('sovereign.invalidate_archive_source_completions()') IS NULL
  OR to_regclass('lifecycle.object_restore_debts') IS NULL
  OR to_regclass('lifecycle.object_deletion_claims') IS NULL THEN
  RAISE EXCEPTION 'ARCHIVE_DEBT_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle.invalidate_source_delete_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior_scope text;
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID NOT IN('lifecycle.object_deletion_claims'::regclass,'lifecycle.object_restore_debts'::regclass)
  OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'INVALID_DELETE_DEBT_TARGET' USING ERRCODE='42501';END IF;
 prior_scope:=current_setting('sovereign.archive_source_proof',true);
 PERFORM set_config('sovereign.archive_source_proof','v1',true);
 BEGIN
  IF TG_RELID='lifecycle.object_restore_debts'::regclass AND NEW.kind='archive' THEN
   -- 0415's header -> job order: completion reads archive metadata without row locks, so waiting
   -- here cannot invert it, and an uncommitted completion is invalidated once it commits.
   PERFORM j.id FROM knowledge.purge_jobs j WHERE j.organization_id=NEW.organization_id ORDER BY j.id FOR UPDATE;
  ELSE
   -- Final source confirmation already owns its source/job. Do not reverse that order by waiting.
   PERFORM j.id FROM knowledge.purge_jobs j WHERE j.organization_id=NEW.organization_id ORDER BY j.id FOR UPDATE NOWAIT;
  END IF;
  UPDATE knowledge.purge_jobs SET state='failed',completed_at=NULL,last_error_code='ARTIFACT_PURGE_UNCONFIRMED'
   WHERE organization_id=NEW.organization_id AND state='completed';
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('sovereign.archive_source_proof',coalesce(prior_scope,''),true);RAISE;END;
 PERFORM set_config('sovereign.archive_source_proof',coalesce(prior_scope,''),true);RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.invalidate_source_delete_completion() FROM PUBLIC;
