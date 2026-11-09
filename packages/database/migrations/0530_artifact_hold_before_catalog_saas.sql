-- REVIEWED SECURITY SQL (ADR-032 D6). Changes here need human review, never agent approval.
-- 0530 (saas): additive repair for registered 0501 and 0208, which are pushed, so they are not edited.
--
-- A legal hold on a file's work unit, project or client did not stop that file being deleted.
-- PostgreSQL fires same-event row triggers in name order. On DELETE FROM work.artifacts, 0208's
-- artifacts_02_catalog ran first and marked the file's catalog entry dead (alive=false). 0501's
-- artifacts_refuse_held ran after it and asks lifecycle.target_is_held, an invoker function, for the
-- file's work_unit/project/client through work.work_artifacts, whose 0208 restrictive read fence
-- (knowledge.artifact_readable) hides every link of a dead catalog entry. The hold check therefore
-- saw only the 'artifact' and 'organization' scopes and the DELETE went through
-- (saas-legal-holds CI, run 42587577445: no LEGAL_HOLD_ACTIVE on a held work unit). The tombstone
-- hold check could not catch it either: the link rows cascade with the file.
--
-- Renaming the hold trigger so it sorts before artifacts_02_catalog makes the hold decision on the
-- file as it stands, before any other trigger of this DELETE changes what its deleter can read.
-- The function, its arguments, its eraser rule and every other trigger are unchanged.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'HOLD_TRIGGER_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid='work.artifacts'::regclass AND g.tgname='artifacts_refuse_held'
  AND g.tgfoid='lifecycle.refuse_held_delete()'::regprocedure AND g.tgenabled IN('O','A') AND NOT g.tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid='work.artifacts'::regclass AND g.tgname='artifacts_02_catalog' AND NOT g.tgisinternal)
  OR EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid='work.artifacts'::regclass AND g.tgname='artifacts_00_refuse_held') THEN
  RAISE EXCEPTION 'HOLD_TRIGGER_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
ALTER TRIGGER artifacts_refuse_held ON work.artifacts RENAME TO artifacts_00_refuse_held;
