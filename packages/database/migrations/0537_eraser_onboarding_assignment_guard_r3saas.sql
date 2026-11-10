-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- 0537 (r3-saas-lifecycle): additive repair for registered 0215, which is pushed, so not edited.
--
-- 0215's work.lock_onboarding_reviewer_assignment() meant to exempt the restricted whole-tenant eraser
-- ("has its own closed-tenant RLS/proof path"), but wrote the exemption and the onboarding lookup as
-- one PL/pgSQL condition: current_user<>'ensemus_eraser' AND EXISTS(SELECT 1 FROM
-- work.client_onboardings ...). PL/pgSQL runs that condition as one SQL query, and PostgreSQL checks
-- table privileges for every relation in a query when it starts, before any short-circuit. The eraser
-- holds no SELECT on work.client_onboardings, so every eraser DELETE of a work.work_assignments row
-- failed with 42501 "permission denied for table client_onboardings": tenant erasure could not
-- remove assignments at all (CI run 42597281023, saas-erasure 0522 epoch case).
--
-- The replacement splits the condition into a nested IF, so the onboarding lookup is planned only for a
-- caller that is not the eraser. Every other caller keeps 0215's exact check, lock and error codes.
-- The eraser gains no grant; its own 0508 receipts trigger (require_erasure_object_receipts and the
-- closed-tenant RLS) still governs its DELETE. Not SECURITY DEFINER, as before; the PUBLIC revoke and
-- the assignment_00_onboarding_lock trigger are kept (checked below).
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'ONBOARDING_ASSIGNMENT_GUARD_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('work.lock_onboarding_reviewer_assignment()') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_trigger t
  WHERE t.tgrelid='work.work_assignments'::regclass AND t.tgname='assignment_00_onboarding_lock' AND NOT t.tgisinternal
   AND t.tgfoid='work.lock_onboarding_reviewer_assignment()'::regprocedure) THEN
  RAISE EXCEPTION 'ONBOARDING_ASSIGNMENT_GUARD_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION work.lock_onboarding_reviewer_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_org uuid; target_work uuid;
BEGIN
  IF TG_RELID<>'work.work_assignments'::regclass OR TG_OP NOT IN ('INSERT','DELETE') THEN
    RAISE EXCEPTION 'ONBOARDING_ASSIGNMENT_TARGET_INVALID' USING ERRCODE='42501'; END IF;
  row_org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  target_work:=CASE WHEN TG_OP='DELETE' THEN OLD.work_unit_id ELSE NEW.work_unit_id END;
  IF row_org IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'ONBOARDING_ASSIGNMENT_TENANT_INVALID' USING ERRCODE='42501'; END IF;
  -- The restricted whole-tenant eraser has its own closed-tenant RLS/proof path, no UPDATE grant.
  -- 0537: a separate statement, so the eraser never plans the onboarding lookup it may not read.
  IF current_user<>'ensemus_eraser' THEN
    IF EXISTS(SELECT 1 FROM work.client_onboardings o WHERE o.organization_id=row_org
      AND target_work IN (o.brief_work_unit_id,o.review_work_unit_id) AND o.state NOT IN ('completed','failed','unknown')) THEN
      PERFORM 1 FROM work.work_units WHERE organization_id=row_org AND id=target_work FOR SHARE NOWAIT;
      IF NOT FOUND THEN RAISE EXCEPTION 'ONBOARDING_ASSIGNMENT_WORK_CLOSED' USING ERRCODE='EN215'; END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION work.lock_onboarding_reviewer_assignment() FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='work.lock_onboarding_reviewer_assignment()'::regprocedure AND p.prosecdef)
  OR has_function_privilege('public','work.lock_onboarding_reviewer_assignment()','EXECUTE')
  OR has_table_privilege('ensemus_eraser','work.client_onboardings','SELECT')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='work.work_assignments'::regclass
   AND t.tgname='assignment_00_onboarding_lock' AND NOT t.tgisinternal AND t.tgenabled='O'
   AND t.tgfoid='work.lock_onboarding_reviewer_assignment()'::regprocedure) THEN
  RAISE EXCEPTION 'ONBOARDING_ASSIGNMENT_GUARD_POSTCONDITION' USING ERRCODE='EN850';END IF;
END $$;
