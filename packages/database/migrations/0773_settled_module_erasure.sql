-- FLAGGED FOR HUMAN SECURITY REVIEW
-- LIFE-04, ADR-032, ADR-034 and ADR-035. Human security review remains pending.
-- Standalone federation settings and sandbox metadata with a positive never-admitted proof
-- now join the restricted eraser. All shared references and attempted sandbox jobs still block.
ALTER TABLE sandbox.runs ADD COLUMN execution_ever_admitted boolean NOT NULL DEFAULT true;
CREATE FUNCTION sandbox.capture_run_execution_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    -- The existing birth trigger requires a clean queued row. Legacy/restored rows without
    -- this field keep the conservative true default instead of qualifying from mutable status.
    NEW.execution_ever_admitted:=false;
  ELSE
    IF OLD.status NOT IN('queued','running') THEN
      RAISE EXCEPTION 'SANDBOX_SETTLED_IMMUTABLE' USING ERRCODE='42501';
    END IF;
    NEW.execution_ever_admitted:=OLD.execution_ever_admitted OR NEW.status='running'
      OR NEW.attempts>0 OR NEW.started_at IS NOT NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sandbox.capture_run_execution_admission() FROM PUBLIC;
CREATE TRIGGER sandbox_runs_capture_execution BEFORE INSERT OR UPDATE ON sandbox.runs
  FOR EACH ROW EXECUTE FUNCTION sandbox.capture_run_execution_admission();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle.erasure_requires_empty(p_schema text,p_table text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (p_schema,p_table) IN (
    ('federation','grants'),('federation','outbound_items'),('federation','inbound_items'),('federation','crossings'),
    ('marketplace','installations'),('marketplace','listings'),('marketplace','publishers'),
    ('marketplace','security_reviews'),('marketplace','submissions')
  )
$$;
CREATE FUNCTION lifecycle.sandbox_unstarted_run_erasable(p_admitted boolean,p_status text,
  p_attempts integer,p_started timestamptz,p_finished timestamptz,p_outcome text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT p_admitted IS FALSE AND p_status IN('denied','cancelled','runner_unavailable')
    AND p_attempts=0 AND p_started IS NULL AND p_finished IS NOT NULL AND p_outcome IS NOT NULL
$$;
REVOKE ALL ON FUNCTION lifecycle.sandbox_unstarted_run_erasable(boolean,text,integer,timestamptz,timestamptz,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.sandbox_unstarted_run_erasable(boolean,text,integer,timestamptz,timestamptz,text) TO ensemus_eraser;
CREATE OR REPLACE FUNCTION lifecycle.deferred_erasure_tables_empty() RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();
BEGIN
  RETURN tenant IS NOT NULL AND NOT (
    EXISTS(SELECT 1 FROM federation.grants WHERE sharing_organization_id=tenant OR receiving_organization_id=tenant OR ended_by_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM federation.outbound_items WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM federation.inbound_items WHERE organization_id=tenant OR sender_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM federation.crossings WHERE sender_organization_id=tenant OR receiver_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.installations WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.listings WHERE publisher_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.publishers WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.security_reviews WHERE submission_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.submissions WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM sandbox.runs
      WHERE organization_id=tenant AND lifecycle.sandbox_unstarted_run_erasable(
        execution_ever_admitted,status,attempts,started_at,finished_at,outcome_code) IS DISTINCT FROM true)
  );
END $$;
CREATE FUNCTION lifecycle.guard_sandbox_run_erase() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF current_user<>'ensemus_eraser' OR session_user<>'ensemus_eraser'
    OR OLD.organization_id IS DISTINCT FROM app.current_organization_id()
    OR lifecycle.sandbox_unstarted_run_erasable(OLD.execution_ever_admitted,OLD.status,OLD.attempts,
      OLD.started_at,OLD.finished_at,OLD.outcome_code) IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'SANDBOX_RUN_ERASURE_PROOF_MISSING' USING ERRCODE='42501';END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION lifecycle.guard_sandbox_run_erase() FROM PUBLIC;
CREATE TRIGGER sandbox_runs_erasure_proof BEFORE DELETE ON sandbox.runs
  FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_sandbox_run_erase();
--> statement-breakpoint
DO $migration$
DECLARE ref text; definition text; strict_inventory text;
  append_anchor constant text:='''work.work_transitions''::regclass)';
  inventory_anchor constant text:='''work.work_units''';
  filter_anchor constant text:='AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text) ORDER BY';
  role_anchor constant text:='IF NOT target.schema_name=ANY(schemas) OR NOT target.relrowsecurity';
  write_scope_anchor constant text:='OR lifecycle.erasure_requires_empty(TG_TABLE_SCHEMA,TG_TABLE_NAME) IS DISTINCT FROM true';
  write_case_anchor constant text:='    ELSE
      tenants:=ARRAY[NEW.organization_id];';
BEGIN
  IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator'
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  THEN RAISE EXCEPTION 'EXPANSION_ERASURE_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;

  GRANT USAGE ON SCHEMA federation,sandbox TO ensemus_eraser;
  FOREACH ref IN ARRAY ARRAY['federation.org_settings','sandbox.runs'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(ref) AND relrowsecurity AND relforcerowsecurity)
    THEN RAISE EXCEPTION 'EXPANSION_ERASURE_TABLE_CHANGED' USING ERRCODE='EN850';END IF;
    EXECUTE format('GRANT SELECT(organization_id), DELETE ON %s TO ensemus_eraser',ref);
    EXECUTE format('CREATE POLICY eraser_delete ON %s TO ensemus_eraser
      USING(organization_id=app.current_organization_id() AND lifecycle.erasure_open(organization_id))',ref);
    EXECUTE format('CREATE TRIGGER expansion_erasure_lock BEFORE DELETE ON %s
      FOR EACH STATEMENT EXECUTE FUNCTION lifecycle.lock_expansion_erase()',ref);
  END LOOP;

  definition:=pg_get_functiondef('lifecycle.fence_deferred_module_write()'::regprocedure);
  IF (length(definition)-length(replace(definition,write_scope_anchor,'')))/length(write_scope_anchor)<>1
    OR (length(definition)-length(replace(definition,write_case_anchor,'')))/length(write_case_anchor)<>1
  THEN RAISE EXCEPTION 'EXPANSION_ERASURE_WRITE_GUARD_CHANGED' USING ERRCODE='EN850';END IF;
  EXECUTE replace(replace(definition,write_scope_anchor,$scope$
    OR (lifecycle.erasure_requires_empty(TG_TABLE_SCHEMA,TG_TABLE_NAME) IS DISTINCT FROM true
      AND TG_RELID NOT IN('federation.org_settings'::regclass,'sandbox.runs'::regclass))$scope$),
    write_case_anchor,$sandbox$
    WHEN 'sandbox.runs'::regclass THEN
      tenants:=ARRAY[NEW.organization_id];
      -- A worker that wants to admit a new execution must pass the tenant fence, even though
      -- the run's organization was already attached. Existing attempts may still settle.
      IF TG_OP='UPDATE' AND (OLD.status='running' OR NEW.status<>'running') THEN
        previous:=ARRAY[OLD.organization_id];
      END IF;
    ELSE
      tenants:=ARRAY[NEW.organization_id];$sandbox$);
  ALTER TRIGGER lifecycle_deferred_erasure_write ON federation.org_settings RENAME TO lifecycle_erasure_birth_fence;
  DROP TRIGGER lifecycle_deferred_erasure_write ON sandbox.runs;
  CREATE TRIGGER lifecycle_erasure_birth_fence BEFORE INSERT OR UPDATE OF organization_id,status ON sandbox.runs
    FOR EACH ROW EXECUTE FUNCTION lifecycle.fence_deferred_module_write();

  definition:=pg_get_functiondef('app.reject_change()'::regprocedure);
  IF (length(definition)-length(replace(definition,append_anchor,'')))/length(append_anchor)<>1
  THEN RAISE EXCEPTION 'EXPANSION_ERASURE_APPEND_GUARD_CHANGED' USING ERRCODE='EN850';END IF;
  EXECUTE replace(definition,append_anchor,'''sandbox.runs''::regclass,'||append_anchor);

  definition:=pg_get_functiondef('lifecycle.install_erasure_count_projection()'::regprocedure);
  IF (length(definition)-length(replace(definition,inventory_anchor,'')))/length(inventory_anchor)<>1
    OR (length(definition)-length(replace(definition,filter_anchor,'')))/length(filter_anchor)<>1
  THEN RAISE EXCEPTION 'EXPANSION_ERASURE_COUNT_GUARD_CHANGED' USING ERRCODE='EN850';END IF;
  strict_inventory:=replace(definition,inventory_anchor,'''federation.org_settings'',''sandbox.runs'','||inventory_anchor);
  EXECUTE replace(strict_inventory,filter_anchor,
    'AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text) AND NOT lifecycle.erasure_requires_empty(n.nspname::text,c.relname::text) ORDER BY');
  PERFORM lifecycle.install_erasure_count_projection();
  EXECUTE strict_inventory;

  definition:=pg_get_functiondef('identity.extend_auth_restore_admission()'::regprocedure);
  IF (length(definition)-length(replace(definition,role_anchor,'')))/length(role_anchor)<>1
  THEN RAISE EXCEPTION 'EXPANSION_ERASURE_RESTORE_GUARD_CHANGED' USING ERRCODE='EN850';END IF;
  EXECUTE replace(definition,role_anchor,$scope$
    IF (NOT target.schema_name=ANY(schemas)
      AND (target.schema_name,target.table_name) NOT IN(('federation','org_settings'),('sandbox','runs')))
      OR NOT target.relrowsecurity$scope$);
  PERFORM identity.extend_auth_restore_admission();
END $migration$;
