-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-039 D2). Human review remains pending.
-- 0700 preserved the old shared-login control projection for every application-tier login. It returns
-- candidate artifact IDs for an exact held review, not bytes, but the web tier must not claim service
-- authority to call it. Only the native platform worker may use it; SET ROLE does not acquire it.
-- Retains 0419's exact Work/version/run/requester checks, bounded ID projection and selector cleanup.
ALTER POLICY held_review_control_work_read ON work.work_units TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND organization_id=nullif(current_setting('work.review_control_org',true),'')::uuid
    AND id=nullif(current_setting('work.review_control_work',true),'')::uuid AND app.current_actor_type()='service' AND session_user='ensemus_worker');
ALTER POLICY held_review_control_work_lock ON work.work_units TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND organization_id=nullif(current_setting('work.review_control_org',true),'')::uuid
    AND id=nullif(current_setting('work.review_control_work',true),'')::uuid AND app.current_actor_type()='service' AND session_user='ensemus_worker') WITH CHECK(false);
ALTER POLICY held_review_control_approval_read ON work.approvals TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND organization_id=nullif(current_setting('work.review_control_org',true),'')::uuid
    AND work_unit_id=nullif(current_setting('work.review_control_work',true),'')::uuid AND app.current_actor_type()='service' AND session_user='ensemus_worker');
CREATE OR REPLACE FUNCTION work.held_review_artifact_ids(p_work uuid,p_version bigint,p_run text,p_requester uuid)
RETURNS TABLE(id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_org text:=current_setting('work.review_control_org',true);previous_work text:=current_setting('work.review_control_work',true);
  actual record;review_runs bigint;
BEGIN
  IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_worker'
    OR current_setting('role',true) NOT IN('none','ensemus_worker') OR app.current_actor_type() IS DISTINCT FROM 'service'
    OR app.current_organization_id() IS NULL OR p_work IS NULL OR p_requester IS NULL OR p_version IS NULL THEN
    RAISE EXCEPTION 'HELD_REVIEW_CONTROL_TARGET' USING ERRCODE='42501';END IF;
  BEGIN
    PERFORM set_config('work.review_control_org',app.current_organization_id()::text,true);
    PERFORM set_config('work.review_control_work',p_work::text,true);
    SELECT work.id,work.version,work.status,work.run_id,work.run_requested_by_membership_id,work.execution_plan INTO actual
      FROM work.work_units work WHERE work.organization_id=app.current_organization_id() AND work.id=p_work FOR SHARE NOWAIT;
    IF NOT FOUND OR actual.version<>p_version OR actual.execution_plan IS DISTINCT FROM 'checklist'
      OR actual.run_requested_by_membership_id IS DISTINCT FROM p_requester THEN
      RAISE EXCEPTION 'HELD_REVIEW_CONTROL_STALE' USING ERRCODE='42501';END IF;
    IF actual.status IN('running','awaiting_approval') THEN
      IF p_run IS NULL OR actual.run_id IS DISTINCT FROM p_run THEN RAISE EXCEPTION 'HELD_REVIEW_CONTROL_STALE' USING ERRCODE='42501';END IF;
    ELSIF actual.status='verifying' AND actual.run_id IS NULL AND p_run IS NULL THEN
      -- The shared kernel releases run_id before checking stale reviews. Only its actual retained
      -- current M2 review may carry that released control identity; never guess by time/order.
      SELECT count(DISTINCT approval.run_id) INTO review_runs FROM work.approvals approval WHERE approval.organization_id=app.current_organization_id()
        AND approval.work_unit_id=p_work AND approval.tool_name='work.review' AND approval.status IN('pending','approved')
        AND approval.requested_by_membership_id=p_requester AND approval.run_id IS NOT NULL;
      IF review_runs<>1 THEN RAISE EXCEPTION 'HELD_REVIEW_CONTROL_STALE' USING ERRCODE='42501';END IF;
    ELSE RAISE EXCEPTION 'HELD_REVIEW_CONTROL_STALE' USING ERRCODE='42501';END IF;
    RETURN QUERY SELECT catalog.artifact_id FROM knowledge.artifact_work_links linked JOIN knowledge.artifact_acl_catalog catalog
      ON catalog.organization_id=linked.organization_id AND catalog.artifact_id=linked.artifact_id
      WHERE linked.organization_id=app.current_organization_id() AND linked.work_unit_id=p_work AND catalog.alive
      ORDER BY catalog.artifact_id LIMIT 1001;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('work.review_control_org',coalesce(previous_org,''),true);
    PERFORM set_config('work.review_control_work',coalesce(previous_work,''),true);
    RAISE;
  END;
  PERFORM set_config('work.review_control_org',coalesce(previous_org,''),true);
  PERFORM set_config('work.review_control_work',coalesce(previous_work,''),true);
END $$;
REVOKE ALL ON FUNCTION work.held_review_artifact_ids(uuid,bigint,text,uuid)
  FROM PUBLIC,ensemus_app,ensemus_connector,ensemus_knowledge,ensemus_agent;
GRANT EXECUTE ON FUNCTION work.held_review_artifact_ids(uuid,bigint,text,uuid) TO ensemus_worker;
