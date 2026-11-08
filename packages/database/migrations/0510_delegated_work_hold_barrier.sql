-- Fixed hold proof for the actual 0419 delegated Work redaction effect. Requires 0417/0419 and
-- 0500-0509. This returns metadata only: no body, redaction, delete or physical-completion grant.
-- Custom GUCs are scoped selectors, not credentials. The actual login and stored relationships are
-- checked independently. The invoker must use this in the SAME source/record -> redaction SQL Tx.
CREATE FUNCTION lifecycle.delegated_hold_scope(p_org uuid,p_run uuid,p_source uuid,p_job uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_user='ensemus_migrator' AND session_user='ensemus_agent'
    AND app.current_actor_type()='service' AND p_org=app.current_organization_id()
    AND p_org::text=current_setting('lifecycle.delegated_hold_org',true)
    AND(p_run IS NULL OR p_run::text=current_setting('lifecycle.delegated_hold_run',true))
    AND(p_source IS NULL OR p_source::text=current_setting('lifecycle.delegated_hold_source',true))
    AND(p_job IS NULL OR p_job::text=current_setting('lifecycle.delegated_hold_job',true)),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.delegated_hold_scope(uuid,uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
-- Only the fixed definer can use these narrowly scoped metadata/locking policies. UPDATE visibility
-- is needed for PostgreSQL locking SELECT; every new WITH CHECK is false. No mutation is admitted.
CREATE POLICY delegated_hold_org_read ON org.organizations FOR SELECT TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(id,NULL,NULL,NULL));
CREATE POLICY delegated_hold_org_lock ON org.organizations FOR UPDATE TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(id,NULL,NULL,NULL)) WITH CHECK(false);
CREATE POLICY delegated_hold_source_read ON knowledge.sources FOR SELECT TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,NULL,id,NULL));
CREATE POLICY delegated_hold_source_lock ON knowledge.sources FOR UPDATE TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,NULL,id,NULL)) WITH CHECK(false);
CREATE POLICY delegated_hold_job_read ON knowledge.purge_jobs FOR SELECT TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,NULL,source_id,id));
CREATE POLICY delegated_hold_job_lock ON knowledge.purge_jobs FOR UPDATE TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,NULL,source_id,id)) WITH CHECK(false);
CREATE POLICY delegated_hold_run_read ON ai.agent_runs FOR SELECT TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,id,NULL,NULL));
CREATE POLICY delegated_hold_run_lock ON ai.agent_runs FOR UPDATE TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,id,NULL,NULL)) WITH CHECK(false);
CREATE POLICY delegated_hold_checkpoint_read ON ai.run_input_checkpoints FOR SELECT TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,run_id,NULL,NULL));
CREATE POLICY delegated_hold_checkpoint_lock ON ai.run_input_checkpoints FOR UPDATE TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,run_id,NULL,NULL)) WITH CHECK(false);
CREATE POLICY delegated_hold_birth_read ON ai.run_authority_checkpoints FOR SELECT TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,run_id,NULL,NULL));
CREATE POLICY delegated_hold_birth_lock ON ai.run_authority_checkpoints FOR UPDATE TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,run_id,NULL,NULL)) WITH CHECK(false);
CREATE POLICY delegated_hold_receipt_read ON ai.delegated_input_receipts FOR SELECT TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,child_run_id,NULL,NULL));
CREATE POLICY delegated_hold_receipt_lock ON ai.delegated_input_receipts FOR UPDATE TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,child_run_id,NULL,NULL)) WITH CHECK(false);
CREATE POLICY delegated_hold_refs_read ON ai.delegated_input_refs FOR SELECT TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,child_run_id,NULL,NULL));
CREATE POLICY delegated_hold_refs_lock ON ai.delegated_input_refs FOR UPDATE TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,child_run_id,NULL,NULL)) WITH CHECK(false);
CREATE POLICY delegated_hold_work_birth_read ON ai.delegated_work_births FOR SELECT TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,child_run_id,NULL,NULL));
CREATE POLICY delegated_hold_work_birth_lock ON ai.delegated_work_births FOR UPDATE TO ensemus_migrator
  USING(lifecycle.delegated_hold_scope(organization_id,child_run_id,NULL,NULL)) WITH CHECK(false);
--> statement-breakpoint
CREATE FUNCTION lifecycle.delegated_work_hold_free(p_child_run uuid,p_work uuid,p_scope_kind text,p_scope_id uuid,p_purge_job uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();permitted boolean:=false;source_state text;source_version bigint;
  previous_org text:=current_setting('lifecycle.delegated_hold_org',true);
  previous_run text:=current_setting('lifecycle.delegated_hold_run',true);
  previous_source text:=current_setting('lifecycle.delegated_hold_source',true);
  previous_job text:=current_setting('lifecycle.delegated_hold_job',true);
BEGIN
  IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_agent'
    OR app.current_actor_type() IS DISTINCT FROM 'service' OR tenant IS NULL OR p_child_run IS NULL OR p_work IS NULL
    OR p_scope_id IS NULL OR p_scope_kind IS NULL OR p_scope_kind NOT IN('knowledge_source','work_unit','project','client','object_record')
    OR(p_scope_kind='knowledge_source' AND p_purge_job IS NULL)
    OR(p_scope_kind<>'knowledge_source' AND p_purge_job IS NOT NULL) THEN RETURN false;END IF;
  PERFORM set_config('lifecycle.delegated_hold_org',tenant::text,true);
  PERFORM set_config('lifecycle.delegated_hold_run',p_child_run::text,true);
  PERFORM set_config('lifecycle.delegated_hold_source',CASE WHEN p_scope_kind='knowledge_source' THEN p_scope_id::text ELSE '' END,true);
  PERFORM set_config('lifecycle.delegated_hold_job',coalesce(p_purge_job::text,''),true);
  BEGIN
    <<proof>>
    BEGIN
      -- Source/record before org, with NOWAIT everywhere on an inverse acquisition. An unknown
      -- missing catalog/source is not a claim that it has been closed or physically removed.
      IF p_scope_kind='knowledge_source' THEN
        SELECT s.state,s.version INTO source_state,source_version FROM knowledge.sources s
          WHERE s.organization_id=tenant AND s.id=p_scope_id FOR SHARE NOWAIT;
        IF NOT FOUND OR source_state NOT IN('revoked','deleted') OR source_version IS NULL OR source_version<1 THEN EXIT proof;END IF;
      ELSE
        PERFORM c.record_id FROM knowledge.structured_record_catalog c
          WHERE c.organization_id=tenant AND c.record_kind=p_scope_kind AND c.record_id=p_scope_id
            AND(NOT c.alive OR EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=c.organization_id
              AND t.target_type=c.record_kind AND t.target_id=c.record_id)) FOR SHARE NOWAIT;
        IF NOT FOUND THEN EXIT proof;END IF;
      END IF;
      -- Same physical tenant row as 0508 hold placement, not the app-only helper/role. Locks survive
      -- a successful call until the caller's redaction transaction ends; no object I/O is allowed.
      PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
      IF NOT FOUND THEN EXIT proof;END IF;
      IF EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active') THEN EXIT proof;END IF;
      IF p_scope_kind='knowledge_source' THEN
        PERFORM j.id FROM knowledge.purge_jobs j WHERE j.organization_id=tenant AND j.id=p_purge_job
          AND j.source_id=p_scope_id AND j.state IN('pending','running','failed','completed') FOR SHARE NOWAIT;
        IF NOT FOUND THEN EXIT proof;END IF;
      END IF;
      -- New-protocol actual child birth and permanent fence. Legacy 0414 rows are never promoted.
      PERFORM c.run_id FROM ai.run_input_checkpoints c WHERE c.organization_id=tenant AND c.run_id=p_child_run
        AND c.protocol_version='v1' AND c.history_complete AND c.fenced_at IS NOT NULL AND c.fence_generation=1 FOR SHARE NOWAIT;
      IF NOT FOUND THEN EXIT proof;END IF;
      PERFORM a.run_id FROM ai.run_authority_checkpoints a WHERE a.organization_id=tenant AND a.run_id=p_child_run
        AND a.protocol_version='authority-v1' AND a.history_complete AND a.work_unit_id=p_work FOR SHARE NOWAIT;
      IF NOT FOUND THEN EXIT proof;END IF;
      PERFORM r.id FROM ai.agent_runs r JOIN ai.run_authority_checkpoints a ON a.organization_id=r.organization_id AND a.run_id=r.id
        WHERE r.organization_id=tenant AND r.id=p_child_run AND r.work_unit_id=p_work AND r.parent_run_id IS NOT NULL
          AND r.status IN('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')
          AND ROW(a.work_unit_id,a.agent_version_id,a.initiator_membership_id)=ROW(r.work_unit_id,r.agent_version_id,r.initiator_membership_id)
        FOR SHARE OF r NOWAIT;
      IF NOT FOUND THEN EXIT proof;END IF;
      PERFORM d.child_run_id FROM ai.delegated_input_receipts d JOIN ai.agent_runs r ON r.organization_id=d.organization_id AND r.id=d.child_run_id
        WHERE d.organization_id=tenant AND d.child_run_id=p_child_run AND d.child_work_unit_id=p_work
          AND d.parent_run_id=r.parent_run_id FOR SHARE OF d NOWAIT;
      IF NOT FOUND THEN EXIT proof;END IF;
      PERFORM b.child_run_id FROM ai.delegated_work_births b JOIN ai.delegated_input_receipts d
        ON d.organization_id=b.organization_id AND d.child_run_id=b.child_run_id
        WHERE b.organization_id=tenant AND b.child_run_id=p_child_run AND b.work_unit_id=p_work
          AND ROW(b.work_unit_id,b.parent_run_id,b.proposal_id,b.snapshot_id,b.birth_content_sha256,b.classification)
            =ROW(d.child_work_unit_id,d.parent_run_id,d.proposal_id,d.snapshot_id,d.birth_content_sha256,d.classification)
        FOR SHARE OF b NOWAIT;
      IF NOT FOUND THEN EXIT proof;END IF;
      PERFORM f.proof_key_sha256 FROM ai.delegated_input_refs f WHERE f.organization_id=tenant AND f.child_run_id=p_child_run
        AND(CASE WHEN p_scope_kind='knowledge_source' THEN (f.ref_kind='source' AND f.ref_id=p_scope_id) OR f.source_id=p_scope_id
          ELSE f.ref_kind=p_scope_kind AND f.ref_id=p_scope_id END) FOR SHARE NOWAIT;
      IF NOT FOUND THEN EXIT proof;END IF;
      permitted:=true;
    END proof;
  EXCEPTION WHEN lock_not_available THEN permitted:=false;
  END;
  PERFORM set_config('lifecycle.delegated_hold_org',coalesce(previous_org,''),true);
  PERFORM set_config('lifecycle.delegated_hold_run',coalesce(previous_run,''),true);
  PERFORM set_config('lifecycle.delegated_hold_source',coalesce(previous_source,''),true);
  PERFORM set_config('lifecycle.delegated_hold_job',coalesce(previous_job,''),true);
  RETURN permitted;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('lifecycle.delegated_hold_org',coalesce(previous_org,''),true);
  PERFORM set_config('lifecycle.delegated_hold_run',coalesce(previous_run,''),true);
  PERFORM set_config('lifecycle.delegated_hold_source',coalesce(previous_source,''),true);
  PERFORM set_config('lifecycle.delegated_hold_job',coalesce(previous_job,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.delegated_work_hold_free(uuid,uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.delegated_work_hold_free(uuid,uuid,text,uuid,uuid) TO ensemus_agent;
