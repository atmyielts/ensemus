-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-026, ADR-029). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person
-- Written by an agent in CI repair round 8 (restore-sql group, check finding 1). It adds no function,
-- table, grant or policy: it is a postcondition only, and a failed one refuses the migration.
--
-- 0549 (r8 restore entry refusal): additive. 0545 and 0547 are registered and pushed, so neither is
-- edited. Written as 0548 and renumbered to 0549 at merge (journal idx 109), because
-- 0548_delegation_birth_readiness_deleg took 0548 first.
--
-- The defect (check finding 1): 0545's postcondition (0545:350-357) and 0547's (0547:287-288) assert
-- that each service-only restore entry point is SECURITY DEFINER and contains the session_user
-- refusal, but they test that with strpos(prosrc,...)>0: anywhere in the body. Their comments say
-- what refuses the agent login (a member of ensemus_app, so it inherits EXECUTE by design) is the
-- function's OPENING refusal, before anything is read or locked. A redefinition that read, locked
-- or wrote first and refused later still passed both.
--
-- This asserts what those comments say, for 0545's lifecycle.requalify_archive_restore_debt(uuid,uuid,
-- text), lifecycle.archive_restore_requalification_key(uuid,uuid) and
-- lifecycle.requalify_raw_restore_org(), and 0547's lifecycle.raw_restore_survivor_delete_target(uuid,
-- uuid) (body opening at 0547:100):
--   * PL/pgSQL, SECURITY DEFINER, owned by ensemus_migrator, search_path=pg_catalog;
--   * the body is, from its first character: DECLARE, then exactly
--     "tenant uuid:=app.current_organization_id();", then optionally exactly
--     "previous text:=current_setting('lifecycle.raw_object_org',true);", then only plain declarations
--     with no initializer ("name type;", type one of uuid, text, record, jsonb, boolean, bigint,
--     integer, optionally an array), then the outermost BEGIN;
--   * the first statement after that BEGIN is
--     IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL
--     followed only by "OR p_<argument> IS NULL" clauses (or 0545's own
--     "OR p_observed NOT IN('present','absent')"), THEN RAISE EXCEPTION '<CODE>' USING
--     ERRCODE='42501'; END IF;
-- The two DECLARE initializers run before that statement, so they are pinned to these exact texts.
-- Both are side-effect-free: current_setting only reads a setting. app.current_organization_id()
-- (0422) calls app.assert_restore_admitted(), which for any login but the migrator reads the 0422
-- control row (identity.auth_restore_control: one SELECT, and a transaction-local set_config of its
-- own scope setting that it puts back) and raises RESTORE_PENDING while a restore is not admitted,
-- then reads the app.organization_id setting. Neither writes a row, takes a row lock or calls out:
-- a caller refused by one of them is refused before anything else, exactly as by the refusal itself.
-- Any other initializer, statement or condition before the refusal fails this postcondition.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'RESTORE_ENTRY_REFUSAL_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('lifecycle.requalify_archive_restore_debt(uuid,uuid,text)') IS NULL
  OR to_regprocedure('lifecycle.archive_restore_requalification_key(uuid,uuid)') IS NULL
  OR to_regprocedure('lifecycle.requalify_raw_restore_org()') IS NULL
  OR to_regprocedure('lifecycle.raw_restore_survivor_delete_target(uuid,uuid)') IS NULL
  OR to_regprocedure('knowledge.is_service_actor()') IS NULL
  OR to_regprocedure('app.current_organization_id()') IS NULL THEN
  RAISE EXCEPTION 'RESTORE_ENTRY_REFUSAL_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint

-- Postcondition: each entry point opens with the refusal, as above. The DETAIL names only the
-- signatures that failed, never a tenant or a value.
DO $$ DECLARE opening text:='^[[:space:]]*DECLARE[[:space:]]+tenant uuid:=app\.current_organization_id\(\);'
  ||'([[:space:]]*previous text:=current_setting\(''lifecycle\.raw_object_org'',true\);)?'
  ||'([[:space:]]*[a-z_][a-z0-9_]* (uuid|text|record|jsonb|boolean|bigint|integer)(\[\])?;)*'
  ||'[[:space:]]*BEGIN[[:space:]]+IF session_user<>''ensemus_app'' OR NOT knowledge\.is_service_actor\(\) OR tenant IS NULL'
  ||'([[:space:]]+OR[[:space:]]+(p_[a-z0-9_]+ IS NULL|p_observed NOT IN\(''present'',''absent''\)))*'
  ||'[[:space:]]+THEN[[:space:]]+RAISE EXCEPTION ''[A-Z0-9_]+'' USING ERRCODE=''42501'';[[:space:]]*END IF;';
 failed text;
BEGIN
 SELECT string_agg(f.signature,',' ORDER BY f.signature) INTO failed FROM(VALUES
  ('lifecycle.requalify_archive_restore_debt(uuid,uuid,text)'),
  ('lifecycle.archive_restore_requalification_key(uuid,uuid)'),
  ('lifecycle.requalify_raw_restore_org()'),
  ('lifecycle.raw_restore_survivor_delete_target(uuid,uuid)')
 ) f(signature)
 WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(f.signature)
  AND p.prolang=(SELECT l.oid FROM pg_language l WHERE l.lanname='plpgsql')
  AND p.prosecdef AND p.proowner='ensemus_migrator'::regrole::oid
  AND p.proconfig IS NOT NULL AND 'search_path=pg_catalog'=ANY(p.proconfig)
  AND p.prosrc ~ opening);
 IF failed IS NOT NULL THEN
  RAISE EXCEPTION 'RESTORE_ENTRY_REFUSAL_FIRST_POSTCONDITION' USING ERRCODE='EN850',DETAIL=failed;END IF;
END $$;
