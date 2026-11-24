-- FLAGGED FOR HUMAN SECURITY REVIEW
-- EXP-05, ADR-034 D3. Browser trials and native execution have distinct authority.
CREATE FUNCTION sandbox.worker_actor() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT session_user='ensemus_worker' AND current_user='ensemus_worker'
    AND knowledge.is_service_actor()
$$;
CREATE FUNCTION sandbox.operator_actor(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(app.is_web_login() AND app.current_actor_type()='user'
    AND p_org=app.current_organization_id() AND EXISTS(
      SELECT 1 FROM org.memberships person WHERE person.organization_id=p_org
        AND person.id=app.current_membership_id() AND person.user_id=app.current_user_id()
        AND person.status='active' AND person.role IN('owner','admin')),false)
$$;
REVOKE ALL ON FUNCTION sandbox.worker_actor(),sandbox.operator_actor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sandbox.worker_actor(),sandbox.operator_actor(uuid) TO ensemus_app;
CREATE POLICY native_sandbox_read ON sandbox.runs AS RESTRICTIVE FOR SELECT TO ensemus_app
  USING(sandbox.worker_actor() OR (sandbox.operator_actor(organization_id)
    AND purpose='operator_test' AND requested_by_membership_id=app.current_membership_id()));
CREATE POLICY native_sandbox_birth ON sandbox.runs AS RESTRICTIVE FOR INSERT TO ensemus_app
  WITH CHECK((sandbox.worker_actor() AND purpose IN('skill_test','agent_tool'))
    OR (sandbox.operator_actor(organization_id) AND purpose='operator_test'
      AND requested_by_membership_id=app.current_membership_id()
      AND test_fixture IS NULL AND agent_run_id IS NULL AND execution_step_id IS NULL AND work_unit_id IS NULL));
CREATE POLICY native_sandbox_update ON sandbox.runs AS RESTRICTIVE FOR UPDATE TO ensemus_app
  USING(sandbox.worker_actor() OR (sandbox.operator_actor(organization_id)
    AND purpose='operator_test' AND requested_by_membership_id=app.current_membership_id()))
  WITH CHECK(sandbox.worker_actor() OR (sandbox.operator_actor(organization_id)
    AND purpose='operator_test' AND requested_by_membership_id=app.current_membership_id()));
--> statement-breakpoint
CREATE FUNCTION sandbox.guard_native_run_state() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE allowed_columns text[]:=ARRAY['cancel_requested_at','version','updated_at'];
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.isolation_probe_passed_at IS NOT NULL OR NEW.runtime_name IS NOT NULL OR NEW.runtime_version IS NOT NULL
      OR NEW.cancel_requested_at IS NOT NULL OR NEW.exit_code IS NOT NULL OR NEW.wall_ms IS NOT NULL
      OR NEW.cpu_ms IS NOT NULL OR NEW.peak_memory_kb IS NOT NULL OR NEW.stdout_bytes IS NOT NULL
      OR NEW.stderr_bytes IS NOT NULL OR NEW.output_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'SANDBOX_RUN_PROGRESS_AT_BIRTH' USING ERRCODE='ES001';
    END IF;
    RETURN NEW;
  END IF;
  IF sandbox.worker_actor() THEN RETURN NEW; END IF;
  IF OLD.status='queued' AND NEW.status='cancelled'
    AND NEW.outcome_code='CANCELLED_BY_REQUEST' AND NEW.finished_at IS NOT NULL THEN
    allowed_columns:=allowed_columns||ARRAY['status','finished_at','outcome_code'];
  ELSIF OLD.status<>'running' OR NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'SANDBOX_OPERATOR_CANCELLATION_ONLY' USING ERRCODE='42501';
  END IF;
  IF NOT sandbox.operator_actor(OLD.organization_id) OR OLD.purpose<>'operator_test'
    OR OLD.requested_by_membership_id IS DISTINCT FROM app.current_membership_id()
    OR OLD.cancel_requested_at IS NOT NULL OR NEW.cancel_requested_at IS NULL
    OR NEW.version<>OLD.version+1
    OR (to_jsonb(NEW)-allowed_columns) IS DISTINCT FROM (to_jsonb(OLD)-allowed_columns) THEN
    RAISE EXCEPTION 'SANDBOX_OPERATOR_CANCELLATION_ONLY' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sandbox.guard_native_run_state() FROM PUBLIC;
CREATE TRIGGER sandbox_native_run_state BEFORE INSERT OR UPDATE ON sandbox.runs
  FOR EACH ROW EXECUTE FUNCTION sandbox.guard_native_run_state();
--> statement-breakpoint
-- Status has a single body-free projection so personal run output cannot appear in tenant status.
CREATE POLICY sandbox_probe_member ON org.memberships FOR SELECT TO ensemus_migrator
  USING(app.is_web_login() AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
    AND organization_id::text=current_setting('sandbox.probe_tenant',true)
    AND id=app.current_membership_id() AND user_id=app.current_user_id());
CREATE POLICY sandbox_probe_metadata ON sandbox.runs FOR SELECT TO ensemus_migrator
  USING(organization_id::text=current_setting('sandbox.probe_tenant',true)
    AND sandbox.operator_actor(organization_id) AND isolation_probe_passed_at IS NOT NULL);
CREATE FUNCTION sandbox.latest_tenant_probe() RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id(); observed timestamptz;
  previous text:=current_setting('sandbox.probe_tenant',true);
BEGIN
  IF current_user<>'ensemus_migrator' OR NOT app.is_web_login()
    OR app.current_actor_type() IS DISTINCT FROM 'user' OR tenant IS NULL THEN RETURN NULL; END IF;
  PERFORM set_config('sandbox.probe_tenant',tenant::text,true);
  IF sandbox.operator_actor(tenant) THEN
    SELECT max(run.isolation_probe_passed_at) INTO observed FROM sandbox.runs run
      WHERE run.organization_id=tenant AND run.isolation_probe_passed_at IS NOT NULL;
  END IF;
  PERFORM set_config('sandbox.probe_tenant',coalesce(previous,''),true);
  RETURN observed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('sandbox.probe_tenant',coalesce(previous,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION sandbox.latest_tenant_probe() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sandbox.latest_tenant_probe() TO ensemus_app;
