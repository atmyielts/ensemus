-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-029). Changes here need human review, never agent approval.
-- 0542 (r4 knowledge): additive repair for registered 0516, which is pushed, so it is not edited. 0515,
-- 0419, 0517 and 0527 are unchanged.
--
-- 0515's sovereign.rotate_material_restore_generation (called by 0422 identity.begin_auth_restore)
-- first updates org.organizations.material_restore_generation and then, in its next statement,
-- demotes the tenant's completed knowledge.purge_jobs with RESTORE_MATERIAL_REQUALIFICATION_REQUIRED
-- and records prior_completed_at. 0419's knowledge.guard_delegated_work_purge_proof lets that column
-- change only in this migrator requalification, and only once the new generation is current, so the
-- demotion cannot move before the generation UPDATE.
--
-- 0516 added raw_org_restore_proof_lost, an AFTER UPDATE OF material_restore_generation row trigger.
-- It fires at the end of that generation UPDATE, before the rotation's next statement: it marks every
-- raw inventory restore_debt and, through lifecycle.invalidate_raw_source_completion, demotes those
-- same completed jobs first, as RAW_SOURCE_UNCONFIRMED and without prior_completed_at (which 0527
-- stopped it writing, because 0419 refuses a runtime write). The rotation's own demotion then finds no
-- completed job. Every restore therefore lost 0515's requalification marker and the date of the
-- completion certificate it invalidated (CI run 42608913914, agent-material-generation "invalidates
-- restored certificates": lastErrorCode RAW_SOURCE_UNCONFIRMED and priorCompletedAt null, where 0515
-- requires RESTORE_MATERIAL_REQUALIFICATION_REQUIRED and the prior completion time).
--
-- The repair recreates that one trigger as a deferred constraint trigger on the same row event, so
-- 0516's proof-loss handling of a generation rotation runs at the rotating transaction's commit, after
-- the rotation has recorded its requalification. Same function, same column, same effects, same
-- transaction: before anything outside the transaction can see the new generation, every raw inventory
-- is still restore_debt and any job still completed is still demoted RAW_SOURCE_UNCONFIRMED. Nothing
-- can complete a job in between: completion requires an ensemus_app service session
-- (0516 knowledge.guard_raw_purge_completion) and a raw inventory sealed in the current generation,
-- while the rotation runs only in an ensemus_migrator session (0517) whose inventories still carry the
-- previous generation. raw_material_proof_lost already binds the rotated tenant itself when it runs
-- unbound in a migrator session, which is how it runs at commit. The other three proof-loss triggers
-- (raw writes, inventories, legal holds) stay immediate. No function, grant or policy changes.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR to_regprocedure('lifecycle.raw_material_proof_lost()') IS NULL
  OR to_regprocedure('sovereign.rotate_material_restore_generation()') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='org.organizations'::regclass
   AND t.tgname='raw_org_restore_proof_lost' AND NOT t.tgisinternal AND NOT t.tgdeferrable
   AND t.tgfoid=to_regprocedure('lifecycle.raw_material_proof_lost()')) THEN
  RAISE EXCEPTION 'RAW_RESTORE_PROOF_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER raw_org_restore_proof_lost ON org.organizations;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER raw_org_restore_proof_lost AFTER UPDATE OF material_restore_generation ON org.organizations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lifecycle.raw_material_proof_lost();
