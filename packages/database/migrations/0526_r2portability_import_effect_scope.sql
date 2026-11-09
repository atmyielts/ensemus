-- REVIEWED SECURITY SQL (ADR-030 D8, D9). Changes here need human review, never agent approval.
-- Additive repair for 0409, which is registered and pushed, so it is not edited.
--
-- 0409's sovereign.consume_import_effect declared a PL/pgSQL variable named import_id and compared
-- it as e.import_id=import_id inside its UPDATE of sovereign.organization_import_effects, which has an
-- import_id column. PostgreSQL rejects that reference as ambiguous (42702, plpgsql.variable_conflict
-- = error) on every call. org.guard_team_management and integrations.guard_connection_management call
-- it for every app-role team, team membership and connection write, so every import holding a team,
-- a team membership or a disabled connection failed with STORE_UNAVAILABLE, and an ordinary team
-- write never reached its own interactive-privilege check through this branch either.
--
-- The body below is 0409's text with that variable renamed to running_import and nothing else
-- changed: the same running-import lock, exact tenant, part path and part hash, operation, target,
-- expected-row digest and single unconsumed effect. CREATE OR REPLACE keeps the function's OID, owner
-- and 0409's ACL (EXECUTE for ensemus_app only).
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR to_regprocedure('sovereign.consume_import_effect(text,text,jsonb)') IS NULL
  OR to_regprocedure('sovereign.lock_running_import(uuid)') IS NULL
  OR to_regclass('sovereign.organization_import_effects') IS NULL
  OR to_regclass('sovereign.organization_import_manifests') IS NULL THEN
  RAISE EXCEPTION 'IMPORT_EFFECT_PREREQUISITE_REQUIRED' USING ERRCODE='EN409';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sovereign.consume_import_effect(p_operation text,p_target text,p_expected jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE running_import uuid;applied integer;
BEGIN
  running_import:=nullif(current_setting('app.portability_import_id',true),'')::uuid;
  IF NOT sovereign.lock_running_import(running_import) THEN RETURN false;END IF;
  UPDATE sovereign.organization_import_effects e SET consumed_at=clock_timestamp()
    WHERE e.organization_id=app.current_organization_id() AND e.import_id=running_import
      AND e.part_path=current_setting('app.portability_part_path',true) AND e.operation=p_operation AND e.target_key=p_target
      AND e.expected_sha256=encode(pg_catalog.sha256(convert_to(p_expected::text,'UTF8')),'hex') AND e.consumed_at IS NULL
      AND EXISTS(SELECT 1 FROM sovereign.organization_import_manifests p WHERE p.organization_id=e.organization_id
        AND p.import_id=e.import_id AND p.path=e.part_path AND p.plaintext_sha256=current_setting('app.portability_part_sha256',true));
  GET DIAGNOSTICS applied=ROW_COUNT;RETURN applied=1;
END $$;
REVOKE ALL ON FUNCTION sovereign.consume_import_effect(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.consume_import_effect(text,text,jsonb) TO ensemus_app;
