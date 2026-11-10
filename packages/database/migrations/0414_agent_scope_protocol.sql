-- Trusted bundled-runtime version fence for immutable company-data/Knowledge scope admission.
-- Requires 0214 + 0216 + 0411 metadata-only Work authority. No journal or body grant here.
-- A GUC is a runtime-version claim, never user authentication or a substitute for fresh ACL.
-- Run writers are fenced until the actual old-child inventory and new-birth guard commit together.
LOCK TABLE ai.agent_runs IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE ai.unproven_child_work_inputs (
  organization_id uuid NOT NULL,work_unit_id uuid NOT NULL,child_run_id uuid NOT NULL,parent_run_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unproven_child_work_inputs_pk PRIMARY KEY(organization_id,work_unit_id,child_run_id),
  CONSTRAINT unproven_child_work_inputs_org_fk FOREIGN KEY(organization_id) REFERENCES org.organizations(id),
  CONSTRAINT unproven_child_work_inputs_parent CHECK(child_run_id<>parent_run_id)
);
ALTER TABLE ai.unproven_child_work_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.unproven_child_work_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY child_input_read ON ai.unproven_child_work_inputs FOR SELECT TO ensemus_app
  USING(organization_id=app.current_organization_id());
GRANT SELECT(organization_id,work_unit_id) ON ai.unproven_child_work_inputs TO ensemus_app;
-- No runtime INSERT grant: these are actual pre-existing child identities, not backfilled inputs.
CREATE POLICY child_0414_backfill_read ON ai.agent_runs FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY child_0414_backfill_write ON ai.unproven_child_work_inputs FOR INSERT TO ensemus_migrator WITH CHECK(true);
INSERT INTO ai.unproven_child_work_inputs(organization_id,work_unit_id,child_run_id,parent_run_id)
  SELECT organization_id,work_unit_id,id,parent_run_id FROM ai.agent_runs WHERE parent_run_id IS NOT NULL;
DROP POLICY child_0414_backfill_write ON ai.unproven_child_work_inputs;
DROP POLICY child_0414_backfill_read ON ai.agent_runs;
CREATE FUNCTION ai.keep_unproven_child_inputs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'ai.unproven_child_work_inputs'::regclass OR TG_OP NOT IN('UPDATE','DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'CHILD_INPUT_INVENTORY_TARGET' USING ERRCODE='42501';END IF;
  RAISE EXCEPTION 'CHILD_INPUT_PROOF_UNAVAILABLE' USING ERRCODE='EN119';
END $$;
REVOKE ALL ON FUNCTION ai.keep_unproven_child_inputs() FROM PUBLIC;
CREATE TRIGGER unproven_child_inputs_keep BEFORE UPDATE OR DELETE ON ai.unproven_child_work_inputs FOR EACH ROW EXECUTE FUNCTION ai.keep_unproven_child_inputs();
CREATE TRIGGER unproven_child_inputs_no_truncate BEFORE TRUNCATE ON ai.unproven_child_work_inputs FOR EACH STATEMENT EXECUTE FUNCTION ai.keep_unproven_child_inputs();
--> statement-breakpoint
CREATE FUNCTION ai.run_scope_preflight(p_run uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_user='ensemus_agent' AND app.current_actor_type()='agent'
    AND current_setting('app.agent_input_protocol',true)='v1'
    AND current_setting('app.agent_run_id',true)=p_run::text AND EXISTS(
      SELECT 1 FROM ai.run_input_checkpoints c JOIN ai.agent_runs r ON r.organization_id=c.organization_id AND r.id=c.run_id
      JOIN org.memberships m ON m.organization_id=r.organization_id AND m.id=r.initiator_membership_id AND m.status='active'
      WHERE c.organization_id=app.current_organization_id() AND c.run_id=p_run AND c.history_complete
        AND c.protocol_version='v1' AND c.fenced_at IS NULL AND r.initiator_membership_id=app.current_membership_id()
        -- Every existing child is unavailable until 0416 supplies the actual inherited receipt.
        -- This also fences cached old-bundle prompts, independently of current Work body serving.
        AND r.parent_run_id IS NULL
        AND r.status IN ('queued','preparing','running','paused','waiting_for_approval','waiting_for_child','verifying')),false)
$$;
CREATE FUNCTION ai.run_scope_required(p_run uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE current_run uuid:=p_run;seen uuid[]:=ARRAY[]::uuid[];r record;previous_depth integer;
BEGIN
  -- Unknown lineage fails closed; no absent/hidden ancestor is treated as an empty grant list.
  LOOP
    IF current_run IS NULL OR current_run=ANY(seen) OR cardinality(seen)>=6 THEN RETURN true;END IF;
    seen:=array_append(seen,current_run);
    SELECT a.parent_run_id,a.depth,v.spec INTO r FROM ai.agent_runs a JOIN ai.agent_versions v
      ON v.organization_id=a.organization_id AND v.id=a.agent_version_id
      WHERE a.organization_id=app.current_organization_id() AND a.id=current_run AND a.initiator_membership_id=app.current_membership_id();
    IF NOT FOUND OR r.depth NOT BETWEEN 0 AND 5 OR(previous_depth IS NOT NULL AND r.depth<>previous_depth-1)
      OR jsonb_typeof(r.spec->'context'->'allowed_scopes') IS DISTINCT FROM 'array' THEN RETURN true;END IF;
    IF r.parent_run_id IS NOT NULL THEN RETURN true;END IF;
    IF jsonb_array_length(r.spec->'context'->'allowed_scopes')>1000 OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(r.spec->'context'->'allowed_scopes') x(value) WHERE jsonb_typeof(x.value)<>'string'
    ) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.spec->'context'->'allowed_scopes') x(value)
      WHERE lower(btrim(x.value)) IN('data','knowledge') OR lower(btrim(x.value)) LIKE 'data.%' OR lower(btrim(x.value)) LIKE 'knowledge.%') THEN RETURN true;END IF;
    IF r.parent_run_id IS NULL THEN RETURN r.depth<>0;END IF;
    previous_depth:=r.depth;current_run:=r.parent_run_id;
  END LOOP;
END $$;
CREATE FUNCTION ai.run_company_ceiling(p_run uuid) RETURNS integer LANGUAGE plpgsql STABLE AS $$
DECLARE current_run uuid:=p_run;seen uuid[]:=ARRAY[]::uuid[];r record;previous_depth integer;scope text;node_ceiling integer;ceiling integer;rank integer;
BEGIN
  LOOP
    IF current_run IS NULL OR current_run=ANY(seen) OR cardinality(seen)>=6 THEN RAISE EXCEPTION 'AGENT_SCOPE_INVALID' USING ERRCODE='EN119';END IF;
    seen:=array_append(seen,current_run);
    SELECT a.parent_run_id,a.depth,v.spec INTO r FROM ai.agent_runs a JOIN ai.agent_versions v
      ON v.organization_id=a.organization_id AND v.id=a.agent_version_id
      WHERE a.organization_id=app.current_organization_id() AND a.id=current_run AND a.initiator_membership_id=app.current_membership_id();
    IF NOT FOUND OR r.depth NOT BETWEEN 0 AND 5 OR(previous_depth IS NOT NULL AND r.depth<>previous_depth-1)
      OR jsonb_typeof(r.spec->'context'->'allowed_scopes') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'AGENT_SCOPE_INVALID' USING ERRCODE='EN119';END IF;
    IF jsonb_array_length(r.spec->'context'->'allowed_scopes')>1000 OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(r.spec->'context'->'allowed_scopes') x(value) WHERE jsonb_typeof(x.value)<>'string'
    ) THEN RAISE EXCEPTION 'AGENT_SCOPE_INVALID' USING ERRCODE='EN119';END IF;
    node_ceiling:=NULL;
    FOR scope IN SELECT value FROM jsonb_array_elements_text(r.spec->'context'->'allowed_scopes') x(value) LOOP
      IF lower(btrim(scope))='data' OR lower(btrim(scope)) LIKE 'data.%' THEN
        IF scope !~ '^data\.(public|internal|confidential|restricted)\.read$' THEN RAISE EXCEPTION 'AGENT_SCOPE_INVALID' USING ERRCODE='EN119';END IF;
        rank:=knowledge.class_rank(split_part(scope,'.',2));
        node_ceiling:=CASE WHEN node_ceiling IS NULL THEN rank ELSE greatest(node_ceiling,rank) END;
      END IF;
    END LOOP;
    IF node_ceiling IS NOT NULL THEN ceiling:=CASE WHEN ceiling IS NULL THEN node_ceiling ELSE least(ceiling,node_ceiling) END;END IF;
    IF r.parent_run_id IS NULL THEN
      IF r.depth<>0 THEN RAISE EXCEPTION 'AGENT_SCOPE_INVALID' USING ERRCODE='EN119';END IF;
      RETURN ceiling;
    END IF;
    previous_depth:=r.depth;current_run:=r.parent_run_id;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION ai.run_scope_preflight(uuid),ai.run_scope_required(uuid),ai.run_company_ceiling(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.run_scope_preflight(uuid),ai.run_scope_required(uuid),ai.run_company_ceiling(uuid) TO ensemus_agent;
--> statement-breakpoint
-- Preserve the public function OID used by existing input/payload/lineage/egress guards.
CREATE OR REPLACE FUNCTION ai.run_input_admitted(p_run uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(ai.run_scope_preflight(p_run) AND (NOT ai.run_scope_required(p_run)
    OR current_setting('app.agent_scope_protocol',true)=('scoped-v1:'||p_run::text)),false)
$$;
-- 0411's authority/class/closure helpers use catalogs, not this body table, so admission cannot
-- recurse through this policy. Metadata maintenance/service actors keep their existing rights.
CREATE POLICY agent_scope_protocol_read ON work.work_units AS RESTRICTIVE FOR SELECT TO ensemus_agent
  USING(CASE WHEN app.current_actor_type()='agent' THEN
    NOT ai.run_scope_required(nullif(current_setting('app.agent_run_id',true),'')::uuid)
    OR(ai.run_input_admitted(nullif(current_setting('app.agent_run_id',true),'')::uuid)
      AND knowledge.work_scope_class(work_units.id) IS NOT NULL
      AND knowledge.class_rank(knowledge.work_scope_class(work_units.id))<=coalesce(ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid),3))
    ELSE true END);
CREATE OR REPLACE FUNCTION ai.main_reservation_admitted(p_run uuid,p_step uuid,p_attempt integer,p_amount bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_user='ensemus_agent' AND app.current_actor_type()='agent' AND p_run::text=current_setting('app.agent_run_id',true) AND(
    (NOT ai.run_scope_required(p_run) AND NOT EXISTS(SELECT 1 FROM ai.model_call_attempts c WHERE c.organization_id=app.current_organization_id() AND c.run_id=p_run))
    OR(current_setting('app.knowledge_model_protocol',true)=('main-v1:'||p_run::text||':'||p_step::text||':'||p_attempt::text||':'||p_amount::text)
      AND ai.run_input_admitted(p_run) AND EXISTS(SELECT 1 FROM ai.agent_runs r JOIN ai.execution_steps s ON s.organization_id=r.organization_id AND s.run_id=r.id
        WHERE r.organization_id=app.current_organization_id() AND r.id=p_run AND r.status='running' AND r.initiator_membership_id=app.current_membership_id()
          AND s.id=p_step AND s.kind='model_turn' AND s.state='in_flight' AND p_attempt>=s.attempt AND(p_attempt-s.attempt)%1000=0))),false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ai.guard_auxiliary_main_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'ai.execution_steps'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN RAISE EXCEPTION 'MAIN_RUNTIME_TARGET' USING ERRCODE='42501';END IF;
  IF NEW.kind='model_turn' AND NEW.state='in_flight' AND(ai.run_scope_required(NEW.run_id) OR EXISTS(SELECT 1 FROM ai.model_call_attempts c WHERE c.organization_id=NEW.organization_id AND c.run_id=NEW.run_id)) THEN
    IF TG_OP='UPDATE' THEN IF NEW.attempt IS NOT DISTINCT FROM OLD.attempt THEN RETURN NEW;END IF;END IF;
    IF current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR NEW.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true)
      OR current_setting('app.knowledge_model_protocol',true) IS DISTINCT FROM 'main-runtime-v1' OR NOT ai.run_input_admitted(NEW.run_id) THEN
      RAISE EXCEPTION 'MAIN_MODEL_RUNTIME_REQUIRED' USING ERRCODE='EN119';END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION ai.guard_auxiliary_model_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  IF TG_OP<>'INSERT' OR TG_RELID NOT IN('ai.step_payloads'::regclass,'ai.tool_proposals'::regclass) THEN RAISE EXCEPTION 'MODEL_RESULT_TARGET' USING ERRCODE='42501';END IF;
  SELECT id,run_id,kind,state,attempt INTO s FROM ai.execution_steps WHERE organization_id=NEW.organization_id AND id=NEW.step_id FOR SHARE NOWAIT;
  IF s.kind='model_turn' AND(ai.run_scope_required(s.run_id) OR EXISTS(SELECT 1 FROM ai.model_call_attempts c WHERE c.organization_id=NEW.organization_id AND c.run_id=s.run_id)) THEN
    IF current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR s.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR s.state<>'in_flight'
      OR current_setting('app.knowledge_model_protocol',true) IS DISTINCT FROM('model-result-v1:'||s.run_id::text||':'||s.id::text||':'||s.attempt::text)
      OR NOT ai.run_input_admitted(s.run_id) THEN RAISE EXCEPTION 'MODEL_RESULT_ATTEMPT_STALE' USING ERRCODE='EN119';END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Held/upsert writes need current admission even without auxiliary calls. Closing or settling a
-- hold, and unknown/paid result accounting, remain possible after a terminal content fence.
CREATE FUNCTION ai.guard_scoped_model_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_key uuid;
BEGIN
  IF TG_OP NOT IN('INSERT','UPDATE') OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'SCOPE_WRITE_TARGET' USING ERRCODE='42501';END IF;
  IF TG_RELID='platform.budget_reservations'::regclass THEN
    IF NEW.run_id IS NULL OR NEW.status<>'held' THEN RETURN NEW;END IF;
    run_key:=NEW.run_id;
    IF NOT ai.run_scope_required(run_key) THEN RETURN NEW;END IF;
    PERFORM 1 FROM ai.run_input_checkpoints WHERE organization_id=NEW.organization_id AND run_id=run_key FOR SHARE;
    IF NOT ai.run_input_admitted(run_key) THEN RAISE EXCEPTION 'AGENT_SCOPE_REQUIRED' USING ERRCODE='EN119';END IF;
    IF NEW.model_call_id IS NULL AND NOT ai.main_reservation_admitted(run_key,NEW.step_id,NEW.attempt,NEW.amount_micros) THEN
      RAISE EXCEPTION 'MAIN_MODEL_ADMISSION_REQUIRED' USING ERRCODE='EN119';END IF;
  ELSIF TG_RELID='ai.model_call_attempts'::regclass THEN
    IF NEW.run_id IS NULL OR(TG_OP='UPDATE' AND NEW.state NOT IN('prepared','dispatched','accepted')) THEN RETURN NEW;END IF;
    run_key:=NEW.run_id;
    IF NOT ai.run_scope_required(run_key) THEN RETURN NEW;END IF;
    PERFORM 1 FROM ai.run_input_checkpoints WHERE organization_id=NEW.organization_id AND run_id=run_key FOR SHARE;
    IF NOT ai.run_input_admitted(run_key) THEN RAISE EXCEPTION 'AGENT_SCOPE_REQUIRED' USING ERRCODE='EN119';END IF;
  ELSE RAISE EXCEPTION 'SCOPE_WRITE_TARGET' USING ERRCODE='42501';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_scoped_model_write() FROM PUBLIC;
CREATE TRIGGER scoped_model_reservation BEFORE INSERT OR UPDATE ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION ai.guard_scoped_model_write();
CREATE TRIGGER scoped_model_attempt BEFORE INSERT OR UPDATE ON ai.model_call_attempts FOR EACH ROW EXECUTE FUNCTION ai.guard_scoped_model_write();
--> statement-breakpoint
-- Interim fail-closed capability. 0416 replaces this OID only when a real immutable delegation-birth
-- dependency is available; parent/child scope strings are never fabricated read observations.
CREATE FUNCTION ai.delegation_influence_ready(p_parent uuid,p_child uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT false
$$;
REVOKE ALL ON FUNCTION ai.delegation_influence_ready(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.delegation_influence_ready(uuid,uuid) TO ensemus_agent;
CREATE FUNCTION ai.guard_delegation_input_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'ai.agent_runs'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'DELEGATION_INPUT_TARGET' USING ERRCODE='42501';END IF;
  IF NEW.parent_run_id IS NOT NULL THEN
    IF current_user<>'ensemus_agent' OR NOT ai.delegation_influence_ready(NEW.parent_run_id,NEW.id) THEN
      RAISE EXCEPTION 'DELEGATION_INPUT_PROOF_UNAVAILABLE' USING ERRCODE='EN119';END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_delegation_input_birth() FROM PUBLIC;
CREATE TRIGGER delegation_input_birth BEFORE INSERT ON ai.agent_runs FOR EACH ROW EXECUTE FUNCTION ai.guard_delegation_input_birth();
--> statement-breakpoint
-- Existing child rows may already contain copied parent-derived text. Agent-only fences would leave
-- human Work/file serving open. ai.agent_runs uses tenant-only metadata RLS (0101), not Work bodies.
CREATE FUNCTION knowledge.inherited_work_inputs_readable(p_work uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM ai.unproven_child_work_inputs r
    WHERE r.organization_id=app.current_organization_id() AND r.work_unit_id=p_work)
$$;
REVOKE ALL ON FUNCTION knowledge.inherited_work_inputs_readable(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.inherited_work_inputs_readable(uuid,uuid) TO ensemus_app;
-- Exact 0411 metadata predicate, with inherited-input closure appended. Preserve its public OID.
CREATE OR REPLACE FUNCTION knowledge.work_scope_readable(p_work uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c JOIN org.memberships m
    ON m.organization_id=c.organization_id AND m.id=p_viewer AND m.status='active'
    WHERE c.organization_id=app.current_organization_id() AND c.record_kind='work_unit' AND c.record_id=p_work AND c.alive
      AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=c.organization_id
        AND t.target_type='work_unit' AND t.target_id=c.record_id)
      AND (c.classification IN ('public','internal') OR c.owner_membership_id=p_viewer
        OR (c.classification='confidential' AND m.role IN ('owner','admin'))
        OR EXISTS(SELECT 1 FROM knowledge.structured_work_assignments a WHERE a.organization_id=c.organization_id
          AND a.work_unit_id=c.record_id AND a.membership_id=p_viewer))
      AND (c.parent_record_id IS NULL OR knowledge.structured_record_readable('project',c.parent_record_id,p_viewer))
      AND knowledge.inherited_work_inputs_readable(p_work,p_viewer))
$$;
CREATE POLICY inherited_work_body_read ON work.work_units AS RESTRICTIVE FOR SELECT TO ensemus_app
  USING(knowledge.inherited_work_inputs_readable(work_units.id,app.current_membership_id()));
--> statement-breakpoint
CREATE FUNCTION knowledge.guard_unproven_child_purge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'knowledge.purge_jobs'::regclass OR TG_OP NOT IN('INSERT','UPDATE') OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'CHILD_PURGE_TARGET' USING ERRCODE='42501';END IF;
  -- Unknown parent-source association cannot be guessed. Any actual unproven delegated sink in
  -- this tenant blocks a positive source-erasure certificate until 0416 provides real disposition.
  IF NEW.state='completed' AND EXISTS(SELECT 1 FROM ai.unproven_child_work_inputs r WHERE r.organization_id=NEW.organization_id) THEN
    RAISE EXCEPTION 'CHILD_DERIVED_MATERIAL_UNPROVEN' USING ERRCODE='EN119';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_unproven_child_purge() FROM PUBLIC;
CREATE TRIGGER source_purge_child_proof BEFORE INSERT OR UPDATE ON knowledge.purge_jobs FOR EACH ROW EXECUTE FUNCTION knowledge.guard_unproven_child_purge();
