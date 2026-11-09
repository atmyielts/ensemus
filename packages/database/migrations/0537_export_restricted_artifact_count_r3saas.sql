-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- 0537 (r3-saas-lifecycle): an export's count of restricted files it cannot see (ADR-030 D10).
--
-- An organization export runs as the tenant's service actor, and 0208/0419's restrictive
-- artifact_input_fence lets a viewerless service read only public and internal ordinary files. A file
-- whose own class is restricted is therefore never in the export reader's rows, so it was neither
-- exported (correct) nor counted in manifest.excluded.restricted_artifacts (wrong: "nothing is missing
-- silently"). This fixed function returns only that count, for the running export's snapshot. It
-- returns no ID, name, hash, key or byte, and does not relax any SELECT policy: callers still cannot
-- read a restricted file's row. Only the native app login acting as the tenant's service may call it.
--
-- SECURITY DEFINER as ensemus_migrator, whose existing 0208 maintenance policies already confine
-- work.artifacts and platform.tombstones reads to app.current_organization_id(). search_path is
-- pg_catalog, PUBLIC has no EXECUTE, ensemus_app alone is granted it (checked below).
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'EXPORT_RESTRICTED_COUNT_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regclass('work.artifacts') IS NULL OR to_regclass('platform.tombstones') IS NULL
  OR to_regprocedure('knowledge.is_service_actor()') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='work.artifacts'::regclass AND p.polname='artifact_0208_maintenance_read')
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='platform.tombstones'::regclass AND p.polname='artifact_0208_tombstone_control') THEN
  RAISE EXCEPTION 'EXPORT_RESTRICTED_COUNT_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION sovereign.export_restricted_class_artifacts(p_snapshot timestamptz) RETURNS integer
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();found_count integer;
BEGIN
 IF session_user<>'ensemus_app' OR tenant IS NULL OR knowledge.is_service_actor() IS NOT TRUE THEN
  RAISE EXCEPTION 'EXPORT_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 -- A deleted file is not a restricted one: it goes in the tombstones, as the reader also rules.
 SELECT count(*)::integer INTO found_count FROM work.artifacts a
  WHERE a.organization_id=tenant AND a.classification='restricted'
   AND(p_snapshot IS NULL OR a.created_at<=p_snapshot)
   AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=tenant
    AND t.target_type='artifact' AND t.target_id=a.id);
 RETURN found_count;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sovereign.export_restricted_class_artifacts(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sovereign.export_restricted_class_artifacts(timestamptz) TO ensemus_app;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='sovereign.export_restricted_class_artifacts(timestamptz)'::regprocedure
   AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'] AND p.proowner='ensemus_migrator'::regrole)
  OR has_function_privilege('public','sovereign.export_restricted_class_artifacts(timestamptz)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','sovereign.export_restricted_class_artifacts(timestamptz)','EXECUTE')
  -- ensemus_agent is a member of ensemus_app, so it holds EXECUTE through it; the session_user gate
  -- above refuses it. The eraser is no member and gets nothing.
  OR has_function_privilege('ensemus_eraser','sovereign.export_restricted_class_artifacts(timestamptz)','EXECUTE') THEN
  RAISE EXCEPTION 'EXPORT_RESTRICTED_COUNT_POSTCONDITION' USING ERRCODE='EN850';END IF;
END $$;
