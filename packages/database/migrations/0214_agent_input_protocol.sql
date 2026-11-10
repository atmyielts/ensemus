-- Content-free durable run inputs; v1 runtime admission, immutable history and a permanent DB fence.
CREATE TABLE ai.run_input_checkpoints (
  organization_id uuid NOT NULL, run_id uuid NOT NULL, history_complete boolean NOT NULL DEFAULT false,
  protocol_version text NOT NULL DEFAULT 'v1', fenced_at timestamptz, fence_generation bigint NOT NULL DEFAULT 0,
  payloads_purged_at timestamptz, purged_fence_generation bigint,
  CONSTRAINT run_input_checkpoints_pk PRIMARY KEY(organization_id,run_id), CONSTRAINT run_input_checkpoints_run_fk FOREIGN KEY(organization_id,run_id) REFERENCES ai.agent_runs(organization_id,id),
  CONSTRAINT run_input_checkpoint_protocol CHECK(protocol_version='v1'),
  CONSTRAINT run_input_checkpoint_receipt CHECK(((fenced_at IS NULL AND fence_generation=0) OR (fenced_at IS NOT NULL AND fence_generation=1))
    AND ((payloads_purged_at IS NULL AND purged_fence_generation IS NULL) OR (payloads_purged_at IS NOT NULL AND purged_fence_generation IS NOT NULL AND purged_fence_generation=fence_generation AND fence_generation=1)))
);
CREATE TABLE ai.run_input_observations (
  organization_id uuid NOT NULL, run_id uuid NOT NULL, input_kind text NOT NULL, input_id uuid NOT NULL,
  input_sha256 text NOT NULL, classification text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_input_observations_pk PRIMARY KEY(organization_id,run_id,input_kind,input_id,input_sha256),
  CONSTRAINT run_input_observations_checkpoint_fk FOREIGN KEY(organization_id,run_id) REFERENCES ai.run_input_checkpoints(organization_id,run_id),
  CONSTRAINT run_input_observation_shape CHECK(input_kind IN ('work_unit','project','client','artifact')
    AND input_sha256 ~ '^[0-9a-f]{64}$' AND classification IN ('public','internal','confidential','restricted'))
);
CREATE INDEX run_input_observations_input_idx ON ai.run_input_observations(organization_id,input_kind,input_id,run_id);
CREATE TABLE ai.run_output_writes (
  organization_id uuid NOT NULL, artifact_id uuid NOT NULL, run_id uuid NOT NULL, write_id uuid NOT NULL, generation bigint NOT NULL, state text NOT NULL,
  CONSTRAINT run_output_writes_pk PRIMARY KEY(organization_id,artifact_id),
  CONSTRAINT run_output_writes_lineage_fk FOREIGN KEY(organization_id,artifact_id) REFERENCES knowledge.artifact_lineage(organization_id,artifact_id),
  CONSTRAINT run_output_writes_checkpoint_fk FOREIGN KEY(organization_id,run_id) REFERENCES ai.run_input_checkpoints(organization_id,run_id),
  CONSTRAINT run_output_writes_state CHECK(state IN ('registered','started','settled') AND generation>0)
);
CREATE POLICY input_0214_backfill ON ai.agent_runs FOR SELECT TO ensemus_migrator USING(true);
INSERT INTO ai.run_input_checkpoints(organization_id,run_id,history_complete)
  SELECT organization_id,id,false FROM ai.agent_runs;
DROP POLICY input_0214_backfill ON ai.agent_runs;
--> statement-breakpoint
ALTER TABLE ai.run_input_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.run_input_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON ai.run_input_checkpoints FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY agent_fence ON ai.run_input_checkpoints FOR UPDATE TO ensemus_agent
  USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE POLICY fixed_writer ON ai.run_input_checkpoints TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND pg_trigger_depth()>0)
  WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()>0);
ALTER TABLE ai.run_input_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.run_input_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON ai.run_input_observations FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY own_append ON ai.run_input_observations FOR INSERT TO ensemus_agent WITH CHECK(
  organization_id=app.current_organization_id() AND app.current_actor_type()='agent'
  AND run_id::text=current_setting('app.agent_run_id',true));
GRANT SELECT ON ai.run_input_checkpoints,ai.run_input_observations TO ensemus_app;
GRANT UPDATE(fenced_at,fence_generation,payloads_purged_at,purged_fence_generation) ON ai.run_input_checkpoints TO ensemus_agent;
GRANT INSERT ON ai.run_input_observations TO ensemus_agent;
ALTER TABLE ai.run_output_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.run_output_writes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON ai.run_output_writes FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY own_writer ON ai.run_output_writes TO ensemus_agent
  USING(organization_id=app.current_organization_id() AND app.current_actor_type()='agent' AND run_id::text=current_setting('app.agent_run_id',true))
  WITH CHECK(organization_id=app.current_organization_id() AND app.current_actor_type()='agent' AND run_id::text=current_setting('app.agent_run_id',true));
GRANT SELECT ON ai.run_output_writes TO ensemus_app;
GRANT INSERT,UPDATE(state) ON ai.run_output_writes TO ensemus_agent;
--> statement-breakpoint
CREATE FUNCTION ai.track_run_input_checkpoint() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'ai.agent_runs'::regclass OR TG_OP NOT IN ('INSERT','UPDATE')
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'RUN_INPUT_CHECKPOINT_TARGET' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    INSERT INTO ai.run_input_checkpoints(organization_id,run_id,history_complete) VALUES(NEW.organization_id,NEW.id,true);
  ELSIF NEW.status IN ('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified') THEN
    UPDATE ai.run_input_checkpoints SET fenced_at=coalesce(fenced_at,clock_timestamp()),fence_generation=1
      WHERE organization_id=NEW.organization_id AND run_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.track_run_input_checkpoint() FROM PUBLIC;
CREATE TRIGGER run_input_checkpoint_birth AFTER INSERT ON ai.agent_runs FOR EACH ROW EXECUTE FUNCTION ai.track_run_input_checkpoint();
CREATE TRIGGER run_input_checkpoint_terminal AFTER UPDATE OF status ON ai.agent_runs FOR EACH ROW EXECUTE FUNCTION ai.track_run_input_checkpoint();
CREATE FUNCTION ai.guard_run_input_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'ai.run_input_checkpoints'::regclass OR TG_OP<>'UPDATE'
    OR ROW(NEW.organization_id,NEW.run_id,NEW.history_complete,NEW.protocol_version)
      IS DISTINCT FROM ROW(OLD.organization_id,OLD.run_id,OLD.history_complete,OLD.protocol_version)
    OR (OLD.fenced_at IS NOT NULL AND NEW.fenced_at IS DISTINCT FROM OLD.fenced_at)
    OR (OLD.fence_generation=1 AND NEW.fence_generation<>1)
    OR (OLD.payloads_purged_at IS NOT NULL AND ROW(NEW.payloads_purged_at,NEW.purged_fence_generation) IS DISTINCT FROM ROW(OLD.payloads_purged_at,OLD.purged_fence_generation))
    OR (current_user<>'ensemus_migrator' AND (current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'service')) THEN
    RAISE EXCEPTION 'RUN_INPUT_CHECKPOINT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF NEW.payloads_purged_at IS NOT NULL AND OLD.payloads_purged_at IS NULL THEN
    IF current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'service'
      OR NEW.fenced_at IS NULL OR NEW.fence_generation<>1 OR NEW.purged_fence_generation IS DISTINCT FROM NEW.fence_generation
      OR NOT EXISTS(SELECT 1 FROM ai.agent_runs r WHERE r.organization_id=NEW.organization_id AND r.id=NEW.run_id)
      OR EXISTS(SELECT 1 FROM ai.step_payloads p JOIN ai.execution_steps s ON s.organization_id=p.organization_id AND s.id=p.step_id
        WHERE s.organization_id=NEW.organization_id AND s.run_id=NEW.run_id) THEN
      RAISE EXCEPTION 'RUN_PAYLOAD_ERASURE_UNCONFIRMED' USING ERRCODE='EN119'; END IF;
    NEW.payloads_purged_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_run_input_checkpoint() FROM PUBLIC;
CREATE TRIGGER run_input_checkpoint_immutable BEFORE UPDATE ON ai.run_input_checkpoints FOR EACH ROW EXECUTE FUNCTION ai.guard_run_input_checkpoint();
--> statement-breakpoint
-- This is trusted bundled-runtime version admission, not authentication by a user-supplied string.
CREATE FUNCTION ai.run_input_admitted(p_run uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_user='ensemus_agent' AND app.current_actor_type()='agent'
    AND current_setting('app.agent_input_protocol',true)='v1'
    AND current_setting('app.agent_run_id',true)=p_run::text AND EXISTS(
      SELECT 1 FROM ai.run_input_checkpoints c JOIN ai.agent_runs r ON r.organization_id=c.organization_id AND r.id=c.run_id
      JOIN org.memberships m ON m.organization_id=r.organization_id AND m.id=r.initiator_membership_id AND m.status='active'
      WHERE c.organization_id=app.current_organization_id() AND c.run_id=p_run AND c.history_complete
        AND c.protocol_version='v1' AND c.fenced_at IS NULL AND r.initiator_membership_id=app.current_membership_id()
        AND r.status IN ('queued','preparing','running','paused','waiting_for_approval','waiting_for_child','verifying')),false)
$$;
CREATE FUNCTION ai.run_inputs_readable(p_run uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM ai.agent_runs r JOIN org.memberships m ON m.organization_id=r.organization_id AND m.id=p_viewer AND m.status='active'
      WHERE r.organization_id=app.current_organization_id() AND r.id=p_run AND r.initiator_membership_id=p_viewer
        AND EXISTS(SELECT 1 FROM ai.run_input_observations o WHERE o.organization_id=r.organization_id AND o.run_id=r.id AND o.input_kind='work_unit' AND o.input_id=r.work_unit_id)
        AND NOT EXISTS(SELECT 1 FROM ai.run_input_observations o WHERE o.organization_id=r.organization_id AND o.run_id=r.id AND (
          knowledge.class_rank(o.classification)>knowledge.class_rank(r.effective_classification)
          OR CASE WHEN o.input_kind='artifact' THEN NOT knowledge.artifact_readable(o.input_id,p_viewer) OR NOT EXISTS(
            SELECT 1 FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=o.organization_id AND a.artifact_id=o.input_id
              AND a.sha256=o.input_sha256 AND knowledge.class_rank(a.classification)<=knowledge.class_rank(r.effective_classification))
          ELSE NOT knowledge.structured_record_readable(o.input_kind,o.input_id,p_viewer)
            OR knowledge.structured_record_class(o.input_kind,o.input_id) IS NULL
            OR knowledge.class_rank(knowledge.structured_record_class(o.input_kind,o.input_id))>knowledge.class_rank(r.effective_classification) END))
        AND NOT EXISTS(SELECT 1 FROM knowledge.evidence_packages p JOIN knowledge.evidence_items i ON i.organization_id=p.organization_id AND i.package_id=p.id
          LEFT JOIN knowledge.sources s ON s.organization_id=i.organization_id AND s.id=i.source_id
          WHERE p.organization_id=r.organization_id AND p.run_id=r.id AND (s.id IS NULL OR s.state<>'active'
            OR s.id NOT IN(SELECT knowledge.readable_source_ids(p_viewer))
            OR knowledge.class_rank(s.classification)>knowledge.class_rank(r.effective_classification)
            OR EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=s.organization_id AND t.target_type='knowledge_source' AND t.target_id=s.id)))),false)
$$;
REVOKE ALL ON FUNCTION ai.run_input_admitted(uuid),ai.run_inputs_readable(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.run_input_admitted(uuid),ai.run_inputs_readable(uuid,uuid) TO ensemus_agent;
--> statement-breakpoint
CREATE FUNCTION ai.guard_run_input_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE viewer uuid; current_class text;
BEGIN
  IF TG_RELID<>'ai.run_input_observations'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'RUN_INPUT_TARGET' USING ERRCODE='42501'; END IF;
  -- A source-close transaction holds sources before checkpoints; preserve that order for file reads.
  IF NEW.input_kind='artifact' THEN
    PERFORM s.id FROM knowledge.sources s WHERE s.organization_id=NEW.organization_id
      AND s.id IN(SELECT knowledge.artifact_required_sources(NEW.input_id)) ORDER BY s.id FOR SHARE NOWAIT;
  END IF;
  PERFORM 1 FROM ai.run_input_checkpoints c WHERE c.organization_id=NEW.organization_id AND c.run_id=NEW.run_id FOR UPDATE;
  IF NOT ai.run_input_admitted(NEW.run_id) THEN RAISE EXCEPTION 'RUN_INPUT_FENCED' USING ERRCODE='EN119'; END IF;
  SELECT r.initiator_membership_id INTO viewer FROM ai.agent_runs r WHERE r.organization_id=NEW.organization_id AND r.id=NEW.run_id;
  IF NEW.input_kind='artifact' THEN
    SELECT a.classification INTO current_class FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=NEW.organization_id
      AND a.artifact_id=NEW.input_id AND a.alive AND a.sha256=NEW.input_sha256;
    IF NOT knowledge.artifact_readable(NEW.input_id,viewer) THEN RAISE EXCEPTION 'RUN_INPUT_UNREADABLE' USING ERRCODE='EN119'; END IF;
  ELSE
    IF NOT knowledge.lock_structured_record(NEW.input_kind,NEW.input_id) THEN RAISE EXCEPTION 'RUN_INPUT_UNREADABLE' USING ERRCODE='EN119'; END IF;
    current_class:=knowledge.structured_record_class(NEW.input_kind,NEW.input_id);
    IF NOT knowledge.structured_record_readable(NEW.input_kind,NEW.input_id,viewer) THEN RAISE EXCEPTION 'RUN_INPUT_UNREADABLE' USING ERRCODE='EN119'; END IF;
  END IF;
  IF current_class IS NULL OR knowledge.class_rank(current_class)>knowledge.class_rank(NEW.classification)
    OR ((SELECT count(*) FROM ai.run_input_observations o WHERE o.organization_id=NEW.organization_id AND o.run_id=NEW.run_id)>=1000
      AND NOT EXISTS(SELECT 1 FROM ai.run_input_observations o WHERE o.organization_id=NEW.organization_id AND o.run_id=NEW.run_id
        AND o.input_kind=NEW.input_kind AND o.input_id=NEW.input_id AND o.input_sha256=NEW.input_sha256)) THEN
    RAISE EXCEPTION 'RUN_INPUT_INVENTORY_INVALID' USING ERRCODE='EN119'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_run_input_observation() FROM PUBLIC;
CREATE TRIGGER run_input_observation_guard BEFORE INSERT ON ai.run_input_observations FOR EACH ROW EXECUTE FUNCTION ai.guard_run_input_observation();
CREATE TRIGGER run_input_observations_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.run_input_observations FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION ai.fence_run_inputs(p_run uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'service' OR app.current_organization_id() IS NULL THEN
    RAISE EXCEPTION 'RUN_INPUT_FENCE_AUTHORITY' USING ERRCODE='42501'; END IF;
  UPDATE ai.run_input_checkpoints SET fenced_at=coalesce(fenced_at,clock_timestamp()),fence_generation=1 WHERE organization_id=app.current_organization_id() AND run_id=p_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUN_INPUT_FENCE_MISSING' USING ERRCODE='EN119'; END IF;
END $$;
REVOKE ALL ON FUNCTION ai.fence_run_inputs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.fence_run_inputs(uuid) TO ensemus_agent;
--> statement-breakpoint
CREATE FUNCTION ai.guard_run_content_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_key uuid;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'RUN_CONTENT_TENANT' USING ERRCODE='42501'; END IF;
  IF TG_RELID='ai.step_payloads'::regclass AND TG_OP='INSERT' THEN
    SELECT s.run_id INTO run_key FROM ai.execution_steps s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.step_id;
  ELSIF TG_RELID='ai.execution_steps'::regclass AND TG_OP IN ('INSERT','UPDATE') THEN
    IF NEW.kind NOT IN ('model_turn','tool_call') OR (TG_OP='UPDATE' AND NEW.state<>'in_flight' AND NEW.attempt=OLD.attempt) THEN RETURN NEW; END IF;
    run_key:=NEW.run_id;
  ELSIF TG_RELID='knowledge.artifact_lineage'::regclass AND TG_OP IN ('INSERT','UPDATE') THEN
    IF NEW.execution_kind<>'agent_run' OR (TG_OP='UPDATE' AND NEW.state='blocked') THEN RETURN NEW; END IF;
    run_key:=NEW.execution_id;
  ELSIF TG_RELID='governance.egress_decisions'::regclass AND TG_OP='INSERT' THEN
    IF NEW.run_id IS NULL OR NEW.decision<>'allow' THEN RETURN NEW; END IF;
    run_key:=NEW.run_id;
  ELSE RAISE EXCEPTION 'RUN_CONTENT_TARGET' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM ai.run_input_checkpoints c WHERE c.organization_id=NEW.organization_id AND c.run_id=run_key FOR SHARE;
  IF run_key IS NULL OR NOT ai.run_input_admitted(run_key) THEN RAISE EXCEPTION 'RUN_INPUT_FENCED' USING ERRCODE='EN119'; END IF;
  IF TG_RELID='knowledge.artifact_lineage'::regclass THEN
    IF TG_OP='UPDATE' THEN
      IF NEW.state='bound' AND OLD.state='pending' AND NOT EXISTS(SELECT 1 FROM ai.run_output_writes w
        WHERE w.organization_id=NEW.organization_id AND w.artifact_id=NEW.artifact_id AND w.run_id=NEW.execution_id
          AND w.write_id=NEW.write_id AND w.generation=NEW.generation AND w.state='settled') THEN
        RAISE EXCEPTION 'RUN_OUTPUT_PUT_UNCONFIRMED' USING ERRCODE='EN119'; END IF;
    END IF;
  END IF;
  IF TG_RELID IN ('ai.step_payloads'::regclass,'knowledge.artifact_lineage'::regclass,'governance.egress_decisions'::regclass)
    AND NOT ai.run_inputs_readable(run_key,app.current_membership_id()) THEN RAISE EXCEPTION 'RUN_INPUT_UNREADABLE' USING ERRCODE='EN119'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_run_content_write() FROM PUBLIC;
CREATE TRIGGER step_payloads_input_fence BEFORE INSERT ON ai.step_payloads FOR EACH ROW EXECUTE FUNCTION ai.guard_run_content_write();
CREATE TRIGGER execution_steps_input_protocol BEFORE INSERT OR UPDATE ON ai.execution_steps FOR EACH ROW EXECUTE FUNCTION ai.guard_run_content_write();
CREATE TRIGGER artifact_lineage_04_run_fence BEFORE INSERT OR UPDATE ON knowledge.artifact_lineage FOR EACH ROW EXECUTE FUNCTION ai.guard_run_content_write();
CREATE TRIGGER egress_run_input_protocol BEFORE INSERT ON governance.egress_decisions FOR EACH ROW EXECUTE FUNCTION ai.guard_run_content_write();
--> statement-breakpoint
-- IDs only, including legacy unknown history; a package-only query misses uncited file tool reads.
CREATE FUNCTION ai.source_input_runs(p_source uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
  SELECT p.run_id FROM knowledge.evidence_packages p JOIN knowledge.evidence_items i
    ON i.organization_id=p.organization_id AND i.package_id=p.id
    WHERE p.organization_id=app.current_organization_id() AND p.run_id IS NOT NULL AND i.source_id=p_source
  UNION
  SELECT c.run_id FROM ai.run_input_checkpoints c WHERE c.organization_id=app.current_organization_id() AND (
    NOT c.history_complete
    OR EXISTS(SELECT 1 FROM ai.run_input_observations o WHERE o.organization_id=c.organization_id AND o.run_id=c.run_id
      AND o.input_kind='artifact' AND p_source IN(SELECT knowledge.artifact_required_sources(o.input_id))))
$$;
REVOKE ALL ON FUNCTION ai.source_input_runs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.source_input_runs(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION ai.guard_run_output_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header knowledge.artifact_lineage%ROWTYPE;
BEGIN
  IF TG_RELID<>'ai.run_output_writes'::regclass OR TG_OP NOT IN ('INSERT','UPDATE')
    OR current_user<>'ensemus_agent' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_type() IS DISTINCT FROM 'agent' OR NEW.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true)
    OR current_setting('app.agent_input_protocol',true) IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'RUN_OUTPUT_TARGET' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO header FROM knowledge.artifact_lineage l WHERE l.organization_id=NEW.organization_id AND l.artifact_id=NEW.artifact_id;
    IF NOT FOUND OR header.execution_kind<>'agent_run' OR header.execution_id<>NEW.run_id OR header.write_id<>NEW.write_id OR header.generation<>NEW.generation
      OR header.state<>'pending' OR header.write_state<>'active' OR NEW.state<>'registered' OR NOT ai.run_input_admitted(NEW.run_id) THEN
      RAISE EXCEPTION 'RUN_OUTPUT_INVENTORY_REQUIRED' USING ERRCODE='EN119'; END IF;
  ELSE
    IF ROW(NEW.organization_id,NEW.artifact_id,NEW.run_id,NEW.write_id,NEW.generation) IS DISTINCT FROM ROW(OLD.organization_id,OLD.artifact_id,OLD.run_id,OLD.write_id,OLD.generation)
      OR NOT ((OLD.state='registered' AND NEW.state='started') OR (OLD.state='started' AND NEW.state='settled')) THEN
      RAISE EXCEPTION 'RUN_OUTPUT_WRITE_IMMUTABLE' USING ERRCODE='42501'; END IF;
    IF NEW.state='started' THEN
      PERFORM 1 FROM ai.run_input_checkpoints c WHERE c.organization_id=NEW.organization_id AND c.run_id=NEW.run_id FOR SHARE;
      IF NOT ai.run_input_admitted(NEW.run_id) OR NOT ai.run_inputs_readable(NEW.run_id,app.current_membership_id()) THEN
        RAISE EXCEPTION 'RUN_INPUT_FENCED' USING ERRCODE='EN119'; END IF;
    END IF;
    -- started->settled records an actually fulfilled old request even after its run was fenced.
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_run_output_write() FROM PUBLIC;
CREATE TRIGGER run_output_write_guard BEFORE INSERT OR UPDATE ON ai.run_output_writes FOR EACH ROW EXECUTE FUNCTION ai.guard_run_output_write();
CREATE TRIGGER run_output_write_keep BEFORE DELETE OR TRUNCATE ON ai.run_output_writes FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE FUNCTION ai.guard_run_output_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'ai.run_output_writes'::regclass OR TG_OP<>'DELETE' OR current_user<>'ensemus_eraser'
    OR OLD.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'RETAIN_RUN_OUTPUT_PROOF' USING ERRCODE='42501'; END IF;
  IF NOT knowledge.certify_artifact_erasure(OLD.artifact_id,true) THEN RAISE EXCEPTION 'ARTIFACT_ERASURE_UNCONFIRMED' USING ERRCODE='EN118'; END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION ai.guard_run_output_erasure() FROM PUBLIC;
CREATE TRIGGER run_output_write_physical_proof BEFORE DELETE ON ai.run_output_writes FOR EACH ROW EXECUTE FUNCTION ai.guard_run_output_erasure();
--> statement-breakpoint
-- The restricted eraser sees only immutable receipt metadata. It never receives prompt SELECT.
CREATE FUNCTION ai.certify_run_payload_erasure(p_run uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_user='ensemus_eraser' AND EXISTS(SELECT 1 FROM ai.run_input_checkpoints c
    WHERE c.organization_id=app.current_organization_id() AND c.run_id=p_run AND c.fenced_at IS NOT NULL
      AND c.fence_generation=1 AND c.payloads_purged_at IS NOT NULL AND c.purged_fence_generation=c.fence_generation)
$$;
REVOKE ALL ON FUNCTION ai.certify_run_payload_erasure(uuid) FROM PUBLIC;
CREATE FUNCTION ai.guard_run_input_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID NOT IN ('ai.run_input_observations'::regclass,'ai.run_input_checkpoints'::regclass) OR TG_OP<>'DELETE'
    OR current_user<>'ensemus_eraser' OR OLD.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'RETAIN_RUN_INPUT_PROOF' USING ERRCODE='42501'; END IF;
  IF NOT ai.certify_run_payload_erasure(OLD.run_id) THEN RAISE EXCEPTION 'RUN_PAYLOAD_ERASURE_UNCONFIRMED' USING ERRCODE='EN119'; END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION ai.guard_run_input_erasure() FROM PUBLIC;
CREATE TRIGGER run_input_observations_payload_proof BEFORE DELETE ON ai.run_input_observations FOR EACH ROW EXECUTE FUNCTION ai.guard_run_input_erasure();
CREATE TRIGGER run_input_checkpoint_payload_proof BEFORE DELETE ON ai.run_input_checkpoints FOR EACH ROW EXECUTE FUNCTION ai.guard_run_input_erasure();
CREATE TRIGGER run_input_checkpoint_keep BEFORE DELETE OR TRUNCATE ON ai.run_input_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
-- 0999 repeats these exact grants/policy if its role is provisioned after this migration.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ensemus_eraser') THEN
  GRANT SELECT(organization_id,run_id,fenced_at,fence_generation,payloads_purged_at,purged_fence_generation) ON ai.run_input_checkpoints TO ensemus_eraser;
  GRANT EXECUTE ON FUNCTION ai.certify_run_payload_erasure(uuid) TO ensemus_eraser;
  CREATE POLICY receipt_eraser_read ON ai.run_input_checkpoints FOR SELECT TO ensemus_eraser USING(organization_id=app.current_organization_id());
END IF; END $$;
