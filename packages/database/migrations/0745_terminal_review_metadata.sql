-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-027 D1, ADR-039 D2). Human review remains pending.
-- Terminal agents close only their own exact work.review records through fixed SQL metadata.
-- Review action bodies remain behind material_reader; no body-serving exception is introduced.
CREATE POLICY terminal_review_metadata ON work.approvals FOR SELECT TO ensemus_migrator USING(
 organization_id=app.current_organization_id() AND session_user='ensemus_agent' AND app.current_actor_type() IN('agent','service')
 AND tool_name='work.review' AND EXISTS(SELECT 1 FROM ai.agent_runs run WHERE run.organization_id=approvals.organization_id
   AND run.id::text=current_setting('app.terminal_work_control_run',true) AND run.work_unit_id=approvals.work_unit_id
   AND run.temporal_run_id=approvals.run_id));
CREATE POLICY terminal_review_cancel ON work.approvals FOR UPDATE TO ensemus_migrator USING(
 organization_id=app.current_organization_id() AND session_user='ensemus_agent' AND app.current_actor_type() IN('agent','service')
 AND tool_name='work.review' AND status='pending' AND EXISTS(SELECT 1 FROM ai.agent_runs run WHERE run.organization_id=approvals.organization_id
   AND run.id::text=current_setting('app.terminal_work_control_run',true) AND run.work_unit_id=approvals.work_unit_id
   AND run.temporal_run_id=approvals.run_id)) WITH CHECK(
 organization_id=app.current_organization_id() AND status='cancelled' AND decided_at IS NOT NULL);
--> statement-breakpoint
CREATE FUNCTION work.agent_terminal_close_reviews(p_run uuid,p_work uuid,p_version bigint,p_hash text)
RETURNS TABLE(id uuid,"requestedBy" uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_selector text:=current_setting('app.terminal_work_control_run',true);actual record;work_status text;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_agent' OR p_run IS NULL OR p_work IS NULL OR p_version IS NULL
   OR app.current_actor_type() IS NULL OR app.current_actor_type() NOT IN('agent','service')
   OR(app.current_actor_type()='agent' AND(p_run::text IS DISTINCT FROM current_setting('app.agent_run_id',true)
      OR app.current_membership_id() IS NULL)) THEN RAISE EXCEPTION 'TERMINAL_REVIEW_TARGET' USING ERRCODE='42501';END IF;
 PERFORM set_config('app.terminal_work_control_run',p_run::text,true);
 SELECT run.work_unit_id,run.temporal_run_id,run.status INTO actual FROM ai.agent_runs run
 JOIN ai.run_authority_checkpoints authority ON authority.organization_id=run.organization_id AND authority.run_id=run.id
 JOIN ai.run_input_checkpoints inputs ON inputs.organization_id=run.organization_id AND inputs.run_id=run.id
 WHERE run.organization_id=app.current_organization_id() AND run.id=p_run AND run.work_unit_id=p_work
   AND(app.current_actor_type()='service' OR run.initiator_membership_id=app.current_membership_id())
   AND run.status IN('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')
   AND authority.protocol_version='authority-v1' AND authority.history_complete
   AND ROW(authority.work_unit_id,authority.agent_version_id,authority.initiator_membership_id)=ROW(run.work_unit_id,run.agent_version_id,run.initiator_membership_id)
   AND inputs.fenced_at IS NOT NULL AND inputs.fence_generation=1 FOR SHARE OF run NOWAIT;
 IF NOT FOUND OR actual.temporal_run_id IS NULL THEN RAISE EXCEPTION 'TERMINAL_REVIEW_UNAVAILABLE' USING ERRCODE='42501';END IF;
 SELECT w.status INTO work_status FROM work.work_units w WHERE w.organization_id=app.current_organization_id()
   AND w.id=p_work AND w.version=p_version AND w.run_id IS NULL FOR SHARE OF w NOWAIT;
 IF NOT FOUND OR (CASE WHEN actual.status IN('completed','outcome_unverified') THEN
     work_status<>'verifying' OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
   ELSE work_status<>'failed' OR p_hash IS NOT NULL END) THEN
   RAISE EXCEPTION 'TERMINAL_REVIEW_STALE' USING ERRCODE='40001';END IF;
 RETURN QUERY UPDATE work.approvals review SET status='cancelled',decided_at=clock_timestamp()
   WHERE review.organization_id=app.current_organization_id() AND review.work_unit_id=p_work
     AND review.run_id=actual.temporal_run_id AND review.tool_name='work.review' AND review.status='pending'
     AND(p_hash IS NULL OR review.action_hash<>p_hash) RETURNING review.id,review.requested_by_membership_id;
 PERFORM set_config('app.terminal_work_control_run',coalesce(previous_selector,''),true);RETURN;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('app.terminal_work_control_run',coalesce(previous_selector,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION work.agent_terminal_close_reviews(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.agent_terminal_close_reviews(uuid,uuid,bigint,text) TO ensemus_agent;
