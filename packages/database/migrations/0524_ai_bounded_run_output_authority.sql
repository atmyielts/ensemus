-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-029). Changes here need human review, never agent approval.
-- Additive: 0417 and 0419 are registered and pushed, so they are not edited.
--
-- 0417's guard_authority_protocol_write refused every generated-file lineage write of an
-- authority-v1 run with RUN_OUTPUT_AUTHORITY_UNBOUND. Its comment says 0419 lifts that gate once
-- actual read authority is retained by the file sink. 0419 built that sink
-- (knowledge.artifact_authority_receipts/refs captured at lineage birth from
-- ai.current_main_input_inventory, artifact_authority_bindings_complete at commit,
-- guard_artifact_authority_publication on pending->bound and guard_output_authority_proof on every
-- PUT claim) but never lifted the gate, so no agent on any run born after 0417 could write a file.
--
-- This lifts it for one bounded case only. A lineage INSERT, or a pending->bound publication, of
-- execution_kind 'agent_run' for an authority-v1 run is admitted only when ALL of these hold:
--   * the writer is the native agent role (current_user and session_user ensemus_agent) acting as
--     the agent actor for exactly that run (app.agent_run_id), as its initiator (the row's viewer is
--     app.current_membership_id(), which is the run's initiator);
--   * the row names the run's own Work (its lineage) and a valid class at least the run's current
--     effective class (its class: a run can never write below what it has read);
--   * the run is still 'running' and has no committed stop;
--   * a publication does not change the execution, Work, viewer or class it was born with;
--   * and then, unchanged from 0417, this transaction holds the run's own authority-v1 admission
--     (run_authority_read_admitted) and the run's retained read authority is complete and unfenced
--     (run_authority_ready), else RUN_AUTHORITY_PROTOCOL_REQUIRED.
-- Everything else about the row stays with the independent 0208/0211/0214/0419 guards, which still
-- run: inventory shape and viewer access (0208), structured inventory (0211), the content fence
-- (0214), the frozen read-time closure, its completeness and its class ceiling (0419). Legacy runs
-- are unchanged. Other agent-run lineage updates (blocking, settlement, erasure) are unchanged.
-- No table, policy or grant changes. The trigger bindings from 0417 are kept; only the function
-- body is replaced, with the same signature, owner and attributes.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR to_regprocedure('ai.guard_authority_protocol_write()') IS NULL
  OR to_regprocedure('knowledge.capture_artifact_authority_birth()') IS NULL
  OR to_regprocedure('knowledge.guard_artifact_authority_publication()') IS NULL
  OR to_regprocedure('ai.guard_output_authority_proof()') IS NULL
  OR to_regprocedure('knowledge.class_rank(text)') IS NULL THEN
  RAISE EXCEPTION 'RUN_OUTPUT_AUTHORITY_PREREQUISITE_REQUIRED' USING ERRCODE='EN119';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ai.guard_authority_protocol_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_key uuid;needed boolean:=false;require_ready boolean:=true;
BEGIN
  IF TG_OP NOT IN('INSERT','UPDATE') OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'AUTHORITY_WRITE_TARGET' USING ERRCODE='42501';END IF;
  IF TG_RELID='ai.run_input_observations'::regclass THEN run_key:=NEW.run_id;needed:=TG_OP='INSERT';require_ready:=false;
  ELSIF TG_RELID='ai.execution_steps'::regclass THEN
    run_key:=NEW.run_id;needed:=TG_OP='INSERT' OR NEW.attempt IS DISTINCT FROM OLD.attempt OR NEW.state='in_flight';
  ELSIF TG_RELID IN('ai.step_payloads'::regclass,'ai.tool_proposals'::regclass) THEN
    SELECT run_id INTO run_key FROM ai.execution_steps WHERE organization_id=NEW.organization_id AND id=NEW.step_id;needed:=TG_OP='INSERT';
  ELSIF TG_RELID='platform.budget_reservations'::regclass THEN run_key:=NEW.run_id;needed:=NEW.status='held';
  ELSIF TG_RELID='ai.model_call_attempts'::regclass THEN run_key:=NEW.run_id;needed:=NEW.state IN('prepared','dispatched','accepted');
  ELSIF TG_RELID='governance.egress_decisions'::regclass THEN run_key:=NEW.run_id;needed:=NEW.decision='allow';
  ELSIF TG_RELID='knowledge.artifact_lineage'::regclass THEN
    IF NEW.execution_kind='agent_run' THEN run_key:=NEW.execution_id;
      needed:=TG_OP='INSERT';
      IF TG_OP='UPDATE' THEN needed:=OLD.state='pending' AND NEW.state='bound';END IF;
      -- 0524: the run's own output, at its own lineage and at least its own class, or nothing.
      -- Nested so the outer test is 0417's own expression: PostgreSQL checks EXECUTE/SELECT on
      -- every callee of an expression when it initializes it, and other roles reach this branch.
      IF needed AND ai.run_authority_required(run_key) THEN
        IF NOT coalesce(
        ai.run_authority_protocol_version(run_key)='authority-v1'
        AND current_user='ensemus_agent' AND session_user='ensemus_agent'
        AND app.current_actor_type()='agent'
        AND run_key::text=current_setting('app.agent_run_id',true)
        AND NEW.viewer_membership_id=app.current_membership_id()
        AND NEW.classification IN('public','internal','confidential','restricted')
        AND(TG_OP='INSERT' OR ROW(NEW.execution_id,NEW.work_unit_id,NEW.viewer_membership_id,NEW.classification)
          IS NOT DISTINCT FROM ROW(OLD.execution_id,OLD.work_unit_id,OLD.viewer_membership_id,OLD.classification))
        AND EXISTS(SELECT 1 FROM ai.agent_runs run WHERE run.organization_id=NEW.organization_id AND run.id=run_key
          AND run.work_unit_id=NEW.work_unit_id AND run.initiator_membership_id=NEW.viewer_membership_id
          AND run.status='running'
          AND knowledge.class_rank(NEW.classification)>=knowledge.class_rank(run.effective_classification)
          AND NOT EXISTS(SELECT 1 FROM ai.run_controls stop WHERE stop.organization_id=run.organization_id
            AND stop.run_id=run.id AND stop.kind='stop')),false) THEN
          RAISE EXCEPTION 'RUN_OUTPUT_AUTHORITY_UNBOUND' USING ERRCODE='EN119';END IF;
      END IF;
    END IF;
  ELSIF TG_RELID='ai.main_input_snapshots'::regclass THEN run_key:=NEW.run_id;needed:=true;
  ELSE RAISE EXCEPTION 'AUTHORITY_WRITE_TARGET' USING ERRCODE='42501';END IF;
  IF needed AND run_key IS NOT NULL AND ai.run_authority_required(run_key) THEN
    PERFORM 1 FROM ai.run_input_checkpoints WHERE organization_id=NEW.organization_id AND run_id=run_key FOR SHARE;
    IF NOT ai.run_authority_read_admitted(run_key) OR(require_ready AND NOT ai.run_authority_ready(run_key,app.current_membership_id())) THEN
      RAISE EXCEPTION 'RUN_AUTHORITY_PROTOCOL_REQUIRED' USING ERRCODE='EN119';END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ai.guard_authority_protocol_write() FROM PUBLIC;
