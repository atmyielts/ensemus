-- FLAGGED FOR HUMAN SECURITY REVIEW
-- The platform worker owns test receipts and verification results. Publication and revocation
-- keep their separate transition and policy checks.
CREATE FUNCTION skills.guard_verifier() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_RELID='skills.package_versions'::regclass AND TG_OP='UPDATE' THEN
    IF NEW.state IS NOT DISTINCT FROM OLD.state
      OR NEW.state NOT IN ('verifying','verified','rejected') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_RELID<>'skills.test_runs'::regclass OR TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'SKILL_VERIFICATION_TARGET_INVALID' USING ERRCODE='42501';
  END IF;

  IF session_user<>'ensemus_worker' OR current_user<>session_user
    OR app.current_actor_type() IS DISTINCT FROM 'service'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'SKILL_VERIFICATION_WORKER_REQUIRED' USING ERRCODE='42501';
  END IF;

  IF TG_RELID='skills.test_runs'::regclass THEN
    PERFORM skills.lock_trust();
    IF NOT EXISTS (
      SELECT 1 FROM skills.package_versions
      WHERE organization_id=NEW.organization_id AND id=NEW.skill_version_id AND state='verifying'
    ) THEN
      RAISE EXCEPTION 'SKILL_VERIFICATION_NOT_RUNNING' USING ERRCODE='ES001';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION skills.guard_verifier() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER skill_versions_native_verifier BEFORE UPDATE ON skills.package_versions
FOR EACH ROW EXECUTE FUNCTION skills.guard_verifier();
--> statement-breakpoint
CREATE TRIGGER skill_test_runs_native_verifier BEFORE INSERT ON skills.test_runs
FOR EACH ROW EXECUTE FUNCTION skills.guard_verifier();
