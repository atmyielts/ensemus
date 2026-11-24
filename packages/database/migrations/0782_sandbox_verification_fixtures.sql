-- FLAGGED FOR HUMAN SECURITY REVIEW
-- New verification fixtures pin the signer. Legacy rows without that binding
-- cannot run or qualify a version.
ALTER TABLE sandbox.runs
  ADD COLUMN fixture_signer_key_id text,
  ADD CONSTRAINT sandbox_fixture_signer_binding CHECK (
    fixture_signer_key_id IS NULL OR (purpose='skill_test'
      AND fixture_signer_key_id ~ '^[0-9a-f]{64}$' AND test_fixture BETWEEN 0 AND 49)
  );
CREATE UNIQUE INDEX sandbox_bound_fixture_once
  ON sandbox.runs (organization_id,skill_version_id,test_fixture)
  WHERE fixture_signer_key_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION sandbox.guard_fixture_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP='INSERT' AND NEW.purpose='skill_test' THEN
    IF NOT sandbox.worker_actor() OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR NEW.fixture_signer_key_id IS NULL OR NEW.classification<>'internal'
      OR NEW.requested_by_membership_id IS NOT NULL OR NEW.work_unit_id IS NOT NULL
      OR NEW.agent_run_id IS NOT NULL OR NEW.execution_step_id IS NOT NULL THEN
      RAISE EXCEPTION 'SANDBOX_VERIFICATION_FIXTURE_AUTHORITY_REQUIRED' USING ERRCODE='42501';
    END IF;
  ELSIF TG_OP='UPDATE' THEN
    IF NEW.fixture_signer_key_id IS DISTINCT FROM OLD.fixture_signer_key_id THEN
      RAISE EXCEPTION 'SANDBOX_VERIFICATION_FIXTURE_IMMUTABLE' USING ERRCODE='ES002';
    END IF;
    IF NEW.purpose='skill_test' AND NEW.status='running' AND OLD.status<>'running'
      AND (NEW.fixture_signer_key_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM skills.package_versions v
        WHERE v.organization_id=NEW.organization_id AND v.id=NEW.skill_version_id AND v.state='verifying'
      )) THEN
      RAISE EXCEPTION 'SANDBOX_VERIFICATION_FIXTURE_NOT_ADMITTED' USING ERRCODE='ES003';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION sandbox.guard_fixture_authority() FROM PUBLIC;
CREATE TRIGGER sandbox_runs_fixture_authority BEFORE INSERT OR UPDATE ON sandbox.runs
  FOR EACH ROW EXECUTE FUNCTION sandbox.guard_fixture_authority();
--> statement-breakpoint
CREATE FUNCTION skills.guard_verified_fixture_set() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE fixture_count integer;
BEGIN
  IF OLD.state='verifying' AND NEW.state='verified' AND NEW.execution_kind='sandbox' THEN
    IF jsonb_typeof(NEW.manifest->'tests') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'SANDBOX_VERIFICATION_FIXTURES_REQUIRED' USING ERRCODE='ES003';
    END IF;
    fixture_count:=jsonb_array_length(NEW.manifest->'tests');
    IF fixture_count NOT BETWEEN 1 AND 50 OR (SELECT count(*) FROM sandbox.runs run
      WHERE run.organization_id=NEW.organization_id AND run.skill_version_id=NEW.id
        AND run.purpose='skill_test' AND run.fixture_signer_key_id=NEW.signer_key_id
        AND run.digest=NEW.digest AND run.test_fixture>=0 AND run.test_fixture<fixture_count
        AND run.status='succeeded' AND run.execution_ever_admitted AND run.output_sha256 IS NOT NULL
    )<>fixture_count OR NOT EXISTS (
      SELECT 1 FROM skills.test_runs test
      WHERE test.organization_id=NEW.organization_id AND test.skill_version_id=NEW.id
        AND test.digest=NEW.digest AND test.mode='sandbox' AND test.outcome='passed'
        AND test.fixtures_total=fixture_count AND test.fixtures_passed=fixture_count
    ) THEN
      RAISE EXCEPTION 'SANDBOX_VERIFICATION_FIXTURES_REQUIRED' USING ERRCODE='ES003';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION skills.guard_verified_fixture_set() FROM PUBLIC;
CREATE TRIGGER skill_versions_verified_fixture_set BEFORE UPDATE ON skills.package_versions
  FOR EACH ROW EXECUTE FUNCTION skills.guard_verified_fixture_set();
