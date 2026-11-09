-- Unregistered source: requires early0517 anchor and coherent0417/0419/0508/0510/0514. Restore rotates the protected
-- root anchor AFTER PostgreSQL restore/schema readiness and BEFORE objects/reapply/readers start.
-- A UUID is a current trusted restore admission, not a user credential or historical input proof.
ALTER TABLE ai.run_input_checkpoints ADD CONSTRAINT run_input_restore_proof CHECK(purged_restore_generation IS NULL
  OR(payloads_purged_at IS NOT NULL AND purged_fence_generation=1 AND fence_generation=1 AND fenced_at IS NOT NULL));
CREATE POLICY material_restore_purge_read ON knowledge.purge_jobs FOR SELECT TO ensemus_migrator
  USING(current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND current_setting('sovereign.material_restore_mode',true)='row'
    AND organization_id=app.current_organization_id() AND organization_id::text=current_setting('sovereign.material_restore_org',true));
CREATE POLICY material_restore_purge_demote ON knowledge.purge_jobs FOR UPDATE TO ensemus_migrator
  USING(current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND current_setting('sovereign.material_restore_mode',true)='row'
    AND organization_id=app.current_organization_id() AND organization_id::text=current_setting('sovereign.material_restore_org',true) AND state='completed')
  WITH CHECK(current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND current_setting('sovereign.material_restore_mode',true)='row'
    AND organization_id=app.current_organization_id() AND organization_id::text=current_setting('sovereign.material_restore_org',true)
    AND state='failed' AND completed_at IS NULL AND last_error_code='RESTORE_MATERIAL_REQUALIFICATION_REQUIRED');
--> statement-breakpoint
CREATE FUNCTION sovereign.rotate_material_restore_generation() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant record;generation uuid;rotated integer:=0;
  previous_org text:=current_setting('app.organization_id',true);previous_actor text:=current_setting('app.actor_type',true);
  previous_member text:=current_setting('app.membership_id',true);previous_user text:=current_setting('app.user_id',true);
  previous_mode text:=current_setting('sovereign.material_restore_mode',true);previous_target text:=current_setting('sovereign.material_restore_org',true);
  previous_generation text:=current_setting('sovereign.material_restore_generation',true);
BEGIN
  IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' THEN
    RAISE EXCEPTION 'MATERIAL_RESTORE_NATIVE_ADMISSION_REQUIRED' USING ERRCODE='42501';END IF;
  PERFORM set_config('app.actor_type','service',true);PERFORM set_config('app.membership_id','',true);PERFORM set_config('app.user_id','',true);
  PERFORM set_config('sovereign.material_restore_mode','scan',true);
  FOR tenant IN SELECT actual.id FROM org.organizations actual ORDER BY actual.id LOOP
    generation:=gen_random_uuid();
    PERFORM set_config('app.organization_id',tenant.id::text,true);
    PERFORM set_config('sovereign.material_restore_mode','row',true);PERFORM set_config('sovereign.material_restore_org',tenant.id::text,true);
    PERFORM set_config('sovereign.material_restore_generation',generation::text,true);
    -- The same root barrier as holds and restricted erasure, never an erasable export epoch row.
    PERFORM actual.id FROM org.organizations actual WHERE actual.id=tenant.id FOR NO KEY UPDATE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'MATERIAL_RESTORE_TENANT_MISSING' USING ERRCODE='EN119';END IF;
    UPDATE org.organizations SET material_restore_generation=generation WHERE id=tenant.id;
    UPDATE knowledge.purge_jobs SET state='failed',prior_completed_at=coalesce(prior_completed_at,completed_at),completed_at=NULL,
      last_error_code='RESTORE_MATERIAL_REQUALIFICATION_REQUIRED' WHERE organization_id=tenant.id AND state='completed';
    rotated:=rotated+1;PERFORM set_config('sovereign.material_restore_mode','scan',true);
  END LOOP;
  PERFORM set_config('app.organization_id',coalesce(previous_org,''),true);PERFORM set_config('app.actor_type',coalesce(previous_actor,''),true);
  PERFORM set_config('app.membership_id',coalesce(previous_member,''),true);PERFORM set_config('app.user_id',coalesce(previous_user,''),true);
  PERFORM set_config('sovereign.material_restore_mode',coalesce(previous_mode,''),true);PERFORM set_config('sovereign.material_restore_org',coalesce(previous_target,''),true);
  PERFORM set_config('sovereign.material_restore_generation',coalesce(previous_generation,''),true);RETURN rotated;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.organization_id',coalesce(previous_org,''),true);PERFORM set_config('app.actor_type',coalesce(previous_actor,''),true);
  PERFORM set_config('app.membership_id',coalesce(previous_member,''),true);PERFORM set_config('app.user_id',coalesce(previous_user,''),true);
  PERFORM set_config('sovereign.material_restore_mode',coalesce(previous_mode,''),true);PERFORM set_config('sovereign.material_restore_org',coalesce(previous_target,''),true);
  PERFORM set_config('sovereign.material_restore_generation',coalesce(previous_generation,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION sovereign.rotate_material_restore_generation() FROM PUBLIC;
-- Owner-only: no app, agent, dispatcher or eraser EXECUTE. The trusted restore command uses the
-- actual migrator login after DB restore; a missing helper/generation is a hard stop before bytes.
--> statement-breakpoint
CREATE FUNCTION ai.guard_payload_restore_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE generation uuid;
BEGIN
  IF TG_RELID<>'ai.run_input_checkpoints'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN RAISE EXCEPTION 'PAYLOAD_RESTORE_TARGET' USING ERRCODE='42501';END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.purged_restore_generation IS NOT NULL THEN RAISE EXCEPTION 'PAYLOAD_RESTORE_PROOF_AT_BIRTH' USING ERRCODE='42501';END IF;
    RETURN NEW;
  END IF;
  IF NEW.purged_restore_generation IS DISTINCT FROM OLD.purged_restore_generation THEN
    generation:=ai.current_material_restore_generation();
    IF current_user<>'ensemus_agent' OR session_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'service'
      OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR generation IS NULL OR NEW.purged_restore_generation IS DISTINCT FROM generation
      OR NEW.fenced_at IS NULL OR NEW.fence_generation<>1 OR NEW.payloads_purged_at IS NULL OR NEW.purged_fence_generation IS DISTINCT FROM NEW.fence_generation
      OR NOT EXISTS(SELECT 1 FROM ai.agent_runs actual WHERE actual.organization_id=NEW.organization_id AND actual.id=NEW.run_id)
      OR EXISTS(SELECT 1 FROM ai.step_payloads payload JOIN ai.execution_steps step ON step.organization_id=payload.organization_id AND step.id=payload.step_id
        WHERE step.organization_id=NEW.organization_id AND step.run_id=NEW.run_id) THEN
      RAISE EXCEPTION 'PAYLOAD_RESTORE_COUNT_UNCONFIRMED' USING ERRCODE='EN119';END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_payload_restore_generation() FROM PUBLIC;
CREATE TRIGGER run_payload_restore_generation BEFORE INSERT OR UPDATE ON ai.run_input_checkpoints FOR EACH ROW EXECUTE FUNCTION ai.guard_payload_restore_generation();
--> statement-breakpoint
CREATE FUNCTION knowledge.guard_purge_restore_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE generation uuid;source record;actual_hash text;
BEGIN
  IF TG_RELID<>'knowledge.purge_jobs'::regclass OR TG_OP NOT IN('INSERT','UPDATE') OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'PURGE_RESTORE_TARGET' USING ERRCODE='42501';END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.transcript_restore_generation IS NOT NULL OR NEW.delegated_work_restore_generation IS NOT NULL THEN
      RAISE EXCEPTION 'PURGE_RESTORE_PROOF_AT_BIRTH' USING ERRCODE='42501';END IF;RETURN NEW;
  END IF;
  IF NEW.transcripts_checked_at IS NULL THEN NEW.transcript_restore_generation:=NULL;
  ELSIF ROW(NEW.transcripts_checked_at,NEW.transcript_source_version,NEW.transcript_runs_sha256,NEW.transcript_restore_generation)
    IS DISTINCT FROM ROW(OLD.transcripts_checked_at,OLD.transcript_source_version,OLD.transcript_runs_sha256,OLD.transcript_restore_generation) THEN
    generation:=ai.current_material_restore_generation();
    SELECT actual.state,actual.version INTO source FROM knowledge.sources actual WHERE actual.organization_id=NEW.organization_id AND actual.id=NEW.source_id;
    SELECT encode(sha256(convert_to(coalesce(string_agg(actual.run_id::text||E'\n','' ORDER BY actual.run_id),''),'UTF8')),'hex') INTO actual_hash
      FROM ai.source_input_runs(NEW.source_id) actual(run_id);
    IF current_user<>'ensemus_agent' OR session_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'service'
      OR generation IS NULL OR source.version IS NULL OR source.state NOT IN('revoked','deleted') OR NEW.transcript_source_version IS DISTINCT FROM source.version
      OR NEW.transcript_runs_sha256 IS DISTINCT FROM actual_hash OR EXISTS(SELECT 1 FROM ai.source_input_runs(NEW.source_id) actual(run_id)
        LEFT JOIN ai.run_input_checkpoints checkpoint ON checkpoint.organization_id=NEW.organization_id AND checkpoint.run_id=actual.run_id
        WHERE checkpoint.run_id IS NULL OR checkpoint.fenced_at IS NULL OR checkpoint.payloads_purged_at IS NULL
          OR checkpoint.purged_fence_generation IS DISTINCT FROM checkpoint.fence_generation OR checkpoint.purged_restore_generation IS DISTINCT FROM generation) THEN
      RAISE EXCEPTION 'TRANSCRIPT_RESTORE_PROOF_UNCONFIRMED' USING ERRCODE='EN119';END IF;
    NEW.transcript_restore_generation:=generation;
  END IF;
  IF NEW.delegated_work_checked_at IS NULL THEN NEW.delegated_work_restore_generation:=NULL;
  ELSIF ROW(NEW.delegated_work_checked_at,NEW.delegated_work_source_version,NEW.delegated_work_receipts_sha256,NEW.delegated_work_restore_generation)
    IS DISTINCT FROM ROW(OLD.delegated_work_checked_at,OLD.delegated_work_source_version,OLD.delegated_work_receipts_sha256,OLD.delegated_work_restore_generation) THEN
    generation:=ai.current_material_restore_generation();
    IF current_user<>'ensemus_agent' OR session_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'service' OR generation IS NULL THEN
      RAISE EXCEPTION 'WORK_RESTORE_PROOF_WRITER' USING ERRCODE='42501';END IF;
    -- The independent source_purge_delegated_work_proof trigger follows this trigger and validates
    -- the actual counters/control/source/transcript proof in this same transaction.
    NEW.delegated_work_restore_generation:=generation;
  END IF;
  IF NEW.state='completed' THEN
    generation:=ai.current_material_restore_generation();
    IF generation IS NULL OR NEW.transcript_restore_generation IS DISTINCT FROM generation OR NEW.delegated_work_restore_generation IS DISTINCT FROM generation THEN
      RAISE EXCEPTION 'PURGE_RESTORE_REQUALIFICATION_REQUIRED' USING ERRCODE='EN119';END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_purge_restore_generation() FROM PUBLIC;
CREATE TRIGGER purge_jobs_0515_generation BEFORE INSERT OR UPDATE ON knowledge.purge_jobs FOR EACH ROW EXECUTE FUNCTION knowledge.guard_purge_restore_generation();
--> statement-breakpoint
-- A source hold guards PG projections/private transcripts as well as blob bytes. Native roles
-- remain separate: app-service projection cleanup versus agent-service transcript cleanup.
CREATE FUNCTION lifecycle.source_material_hold_scope(p_org uuid,p_source uuid,p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(current_user='ensemus_migrator' AND session_user IN('ensemus_app','ensemus_agent') AND knowledge.is_service_actor()
    AND p_org=app.current_organization_id() AND p_org::text=current_setting('lifecycle.source_purge_org',true)
    AND(p_source IS NULL OR p_source::text=current_setting('lifecycle.source_purge_source',true))
    AND(p_job IS NULL OR p_job::text=current_setting('lifecycle.source_purge_job',true)),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.source_material_hold_scope(uuid,uuid,uuid) FROM PUBLIC;
CREATE POLICY source_material_hold_org_read ON org.organizations FOR SELECT TO ensemus_migrator USING(lifecycle.source_material_hold_scope(id,NULL,NULL));
CREATE POLICY source_material_hold_org_lock ON org.organizations FOR UPDATE TO ensemus_migrator USING(lifecycle.source_material_hold_scope(id,NULL,NULL)) WITH CHECK(false);
CREATE POLICY source_material_hold_read ON knowledge.sources FOR SELECT TO ensemus_migrator USING(lifecycle.source_material_hold_scope(organization_id,id,NULL));
CREATE POLICY source_material_hold_lock ON knowledge.sources FOR UPDATE TO ensemus_migrator USING(lifecycle.source_material_hold_scope(organization_id,id,NULL)) WITH CHECK(false);
CREATE POLICY source_material_hold_job_read ON knowledge.purge_jobs FOR SELECT TO ensemus_migrator USING(lifecycle.source_material_hold_scope(organization_id,source_id,id));
CREATE POLICY source_material_hold_job_lock ON knowledge.purge_jobs FOR UPDATE TO ensemus_migrator USING(lifecycle.source_material_hold_scope(organization_id,source_id,id)) WITH CHECK(false);
CREATE POLICY source_material_hold_tombstone ON platform.tombstones FOR SELECT TO ensemus_migrator
  USING(target_type='knowledge_source' AND lifecycle.source_material_hold_scope(organization_id,target_id,NULL));
CREATE FUNCTION lifecycle.source_material_hold_free(p_source uuid,p_version bigint,p_job uuid,p_operation text) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();allowed boolean:=false;
  previous_org text:=current_setting('lifecycle.source_purge_org',true);previous_source text:=current_setting('lifecycle.source_purge_source',true);
  previous_job text:=current_setting('lifecycle.source_purge_job',true);
BEGIN
  IF current_user<>'ensemus_migrator' OR NOT knowledge.is_service_actor() OR tenant IS NULL OR p_source IS NULL OR p_job IS NULL
    OR p_version IS NULL OR p_version<1 OR NOT coalesce((p_operation='projection' AND session_user='ensemus_app')
      OR(p_operation='payload' AND session_user='ensemus_agent'),false) THEN RETURN false;END IF;
  PERFORM set_config('lifecycle.source_purge_org',tenant::text,true);PERFORM set_config('lifecycle.source_purge_source',p_source::text,true);
  PERFORM set_config('lifecycle.source_purge_job',p_job::text,true);
  BEGIN
    <<proof>>
    BEGIN
      PERFORM actual.id FROM knowledge.sources actual WHERE actual.organization_id=tenant AND actual.id=p_source
        AND actual.state IN('revoked','deleted') AND actual.version=p_version FOR SHARE NOWAIT;
      IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM platform.tombstones actual WHERE actual.organization_id=tenant AND actual.target_type='knowledge_source' AND actual.target_id=p_source) THEN EXIT proof;END IF;
      PERFORM actual.id FROM org.organizations actual WHERE actual.id=tenant FOR NO KEY UPDATE NOWAIT;
      IF NOT FOUND OR EXISTS(SELECT 1 FROM lifecycle.legal_holds actual WHERE actual.organization_id=tenant AND actual.status='active') THEN EXIT proof;END IF;
      PERFORM actual.id FROM knowledge.purge_jobs actual WHERE actual.organization_id=tenant AND actual.id=p_job AND actual.source_id=p_source
        AND actual.state IN('pending','running','failed') FOR SHARE NOWAIT;
      IF NOT FOUND THEN EXIT proof;END IF;
      allowed:=ai.current_material_restore_generation() IS NOT NULL;
    END proof;
  EXCEPTION WHEN lock_not_available THEN allowed:=false;END;
  PERFORM set_config('lifecycle.source_purge_org',coalesce(previous_org,''),true);PERFORM set_config('lifecycle.source_purge_source',coalesce(previous_source,''),true);
  PERFORM set_config('lifecycle.source_purge_job',coalesce(previous_job,''),true);RETURN allowed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('lifecycle.source_purge_org',coalesce(previous_org,''),true);PERFORM set_config('lifecycle.source_purge_source',coalesce(previous_source,''),true);
  PERFORM set_config('lifecycle.source_purge_job',coalesce(previous_job,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.source_material_hold_free(uuid,bigint,uuid,text) FROM PUBLIC;
CREATE FUNCTION lifecycle.source_payload_hold_free(p_source uuid,p_version bigint,p_job uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT lifecycle.source_material_hold_free(p_source,p_version,p_job,'payload') $$;
CREATE FUNCTION lifecycle.source_projection_hold_free(p_source uuid,p_version bigint,p_job uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT lifecycle.source_material_hold_free(p_source,p_version,p_job,'projection') $$;
REVOKE ALL ON FUNCTION lifecycle.source_payload_hold_free(uuid,bigint,uuid),lifecycle.source_projection_hold_free(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.source_payload_hold_free(uuid,bigint,uuid) TO ensemus_agent;
GRANT EXECUTE ON FUNCTION lifecycle.source_projection_hold_free(uuid,bigint,uuid) TO ensemus_app;
--> statement-breakpoint
-- This retained technical witness breaks only the proof-row/source FK cleanup cycle. It is not a
-- row-erasure report, a financial settlement, a legal-retention policy, or historical input proof.
-- 0422 must precede runtime sealing; 0516 must supply the actual raw-source object confirmation.
CREATE TABLE lifecycle.delegated_erasure_receipts(
  organization_id uuid NOT NULL,offboarding_id uuid NOT NULL,
  material_restore_generation uuid NOT NULL,auth_restore_generation uuid NOT NULL,
  admitted_at timestamptz NOT NULL,erasure_started_at timestamptz NOT NULL,
  proof_sha256 text NOT NULL,run_count bigint NOT NULL,child_count bigint NOT NULL,source_count bigint NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT delegated_erasure_receipts_pk PRIMARY KEY(organization_id,offboarding_id,material_restore_generation),
  CONSTRAINT delegated_erasure_receipts_org_fk FOREIGN KEY(organization_id) REFERENCES org.organizations(id),
  CONSTRAINT delegated_erasure_receipts_offboarding_fk FOREIGN KEY(organization_id,offboarding_id) REFERENCES lifecycle.offboardings(organization_id,id),
  CONSTRAINT delegated_erasure_receipts_hash CHECK(proof_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT delegated_erasure_receipts_counts CHECK(run_count>=0 AND child_count>=0 AND source_count>=0)
);
ALTER TABLE lifecycle.delegated_erasure_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.delegated_erasure_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON lifecycle.delegated_erasure_receipts FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser;
CREATE TRIGGER delegated_erasure_receipts_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.delegated_erasure_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE FUNCTION lifecycle.delegated_erasure_scope(p_org uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(current_user='ensemus_migrator' AND session_user IN('ensemus_app','ensemus_eraser')
    AND knowledge.is_service_actor() AND p_org=app.current_organization_id()
    AND p_org::text=current_setting('lifecycle.delegated_erase_org',true),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.delegated_erasure_scope(uuid) FROM PUBLIC;
CREATE POLICY delegated_erasure_receipt_owner ON lifecycle.delegated_erasure_receipts TO ensemus_migrator
  USING(lifecycle.delegated_erasure_scope(organization_id)) WITH CHECK(lifecycle.delegated_erasure_scope(organization_id));
-- All fixed helpers expose booleans only. No runtime role receives SELECT over these private rows.
CREATE POLICY delegated_erase_org_read ON org.organizations FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(id));
CREATE POLICY delegated_erase_org_lock ON org.organizations FOR UPDATE TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(id)) WITH CHECK(false);
GRANT SELECT(id,organization_id,requested_by_membership_id,state,erasure_started_at) ON lifecycle.offboardings TO ensemus_migrator;
GRANT SELECT(organization_id,id,parent_run_id,work_unit_id,status,version) ON ai.agent_runs TO ensemus_migrator;
GRANT SELECT(organization_id,run_id,purged_restore_generation) ON ai.run_input_checkpoints TO ensemus_migrator;
GRANT SELECT(organization_id) ON ai.step_payloads TO ensemus_migrator;
GRANT SELECT(organization_id,job_id) ON ai.model_job_payloads TO ensemus_migrator;
GRANT SELECT(organization_id,id,state,fenced_at,fence_generation,payloads_purged_at,purged_fence_generation) ON ai.model_jobs TO ensemus_migrator;
GRANT SELECT(organization_id,state) ON ai.run_output_writes TO ensemus_migrator;
GRANT SELECT(organization_id,child_run_id,parent_run_id,child_work_unit_id,proposal_id,snapshot_id,birth_content_sha256,classification,
  redacted_at,redacted_version,disposition_sha256,redaction_scope_kind,redaction_scope_id,redaction_purge_job_id) ON ai.delegated_input_receipts TO ensemus_migrator;
GRANT SELECT(organization_id,work_unit_id,child_run_id,parent_run_id,proposal_id,snapshot_id,birth_content_sha256,classification) ON ai.delegated_work_births TO ensemus_migrator;
GRANT SELECT(organization_id,run_id,protocol_version,history_complete) ON ai.run_authority_checkpoints TO ensemus_migrator;
GRANT SELECT(organization_id,id,state,version) ON knowledge.sources TO ensemus_migrator;
GRANT SELECT(organization_id,id,source_id,state,transcripts_checked_at,transcript_source_version,transcript_runs_sha256,transcript_restore_generation,
  delegated_work_checked_at,delegated_work_source_version,delegated_work_receipts_sha256,delegated_work_restore_generation,
  delegated_work_remaining,delegated_work_unknown,delegated_work_controls_remaining) ON knowledge.purge_jobs TO ensemus_migrator;
GRANT SELECT(organization_id,source_id) ON knowledge.documents,knowledge.chunks,knowledge.fact_evidence TO ensemus_migrator;
GRANT SELECT(organization_id,id,title,objective,version,run_id) ON work.work_units TO ensemus_migrator;
CREATE POLICY delegated_erase_runs ON ai.agent_runs FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_payload_count ON ai.step_payloads FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_job_payload_count ON ai.model_job_payloads FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_model_jobs ON ai.model_jobs FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_writers ON ai.run_output_writes FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_receipts ON ai.delegated_input_receipts FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_births ON ai.delegated_work_births FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_authority ON ai.run_authority_checkpoints FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_sources ON knowledge.sources FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_source_lock ON knowledge.sources FOR UPDATE TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id)) WITH CHECK(false);
CREATE POLICY delegated_erase_purge_jobs ON knowledge.purge_jobs FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_job_lock ON knowledge.purge_jobs FOR UPDATE TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id)) WITH CHECK(false);
CREATE POLICY delegated_erase_documents ON knowledge.documents FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_chunks ON knowledge.chunks FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
CREATE POLICY delegated_erase_fact_evidence ON knowledge.fact_evidence FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id));
-- Internal exact Work selector, constrained again by the actual retained child receipt. It can
-- check the fixed redaction bytes only; neither its UUID nor its body is a caller-visible RPC.
CREATE POLICY delegated_erase_work ON work.work_units FOR SELECT TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id)
  AND id::text=current_setting('lifecycle.delegated_erase_work',true) AND EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt
    WHERE receipt.organization_id=work_units.organization_id AND receipt.child_work_unit_id=work_units.id));
CREATE POLICY delegated_erase_work_lock ON work.work_units FOR UPDATE TO ensemus_migrator USING(lifecycle.delegated_erasure_scope(organization_id)
  AND id::text=current_setting('lifecycle.delegated_erase_work',true) AND EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt
    WHERE receipt.organization_id=work_units.organization_id AND receipt.child_work_unit_id=work_units.id)) WITH CHECK(false);
--> statement-breakpoint
CREATE FUNCTION lifecycle.current_delegated_material_proof() RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE source_row record;job record;child record;generation uuid:=ai.current_material_restore_generation();
  previous_work text:=current_setting('lifecycle.delegated_erase_work',true);allowed boolean:=false;
BEGIN
  IF NOT lifecycle.delegated_erasure_scope(app.current_organization_id()) OR generation IS NULL THEN RETURN false;END IF;
  <<proof>>
  BEGIN
    -- Check actual rows, not a caller's zero count or a mutable progress cursor. No private body is
    -- returned or read; SELECT(organization_id) suffices for the actual private-payload COUNT0.
    IF EXISTS(SELECT 1 FROM ai.unproven_child_work_inputs actual WHERE actual.organization_id=app.current_organization_id())
      OR EXISTS(SELECT 1 FROM ai.step_payloads actual WHERE actual.organization_id=app.current_organization_id())
      OR(SELECT count(actual.job_id) FROM ai.model_job_payloads actual WHERE actual.organization_id=app.current_organization_id())<>0
      OR EXISTS(SELECT 1 FROM ai.model_jobs actual WHERE actual.organization_id=app.current_organization_id()
        AND(actual.state NOT IN('completed','refused','fenced') OR actual.fenced_at IS NULL OR actual.fence_generation<>1
          OR actual.payloads_purged_at IS NULL OR actual.purged_fence_generation IS DISTINCT FROM actual.fence_generation))
      OR EXISTS(SELECT 1 FROM ai.run_output_writes actual WHERE actual.organization_id=app.current_organization_id() AND actual.state<>'settled')
      OR EXISTS(SELECT 1 FROM ai.agent_runs run LEFT JOIN ai.run_input_checkpoints checkpoint
        ON checkpoint.organization_id=run.organization_id AND checkpoint.run_id=run.id
        WHERE run.organization_id=app.current_organization_id() AND(run.status NOT IN('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')
          OR checkpoint.run_id IS NULL OR NOT checkpoint.history_complete OR checkpoint.fenced_at IS NULL OR checkpoint.fence_generation<>1
          OR checkpoint.payloads_purged_at IS NULL OR checkpoint.purged_fence_generation IS DISTINCT FROM checkpoint.fence_generation
          OR checkpoint.purged_restore_generation IS DISTINCT FROM generation))
      OR EXISTS(SELECT 1 FROM ai.agent_runs run WHERE run.organization_id=app.current_organization_id() AND run.parent_run_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=run.organization_id AND receipt.child_run_id=run.id
          AND receipt.parent_run_id=run.parent_run_id AND receipt.child_work_unit_id=run.work_unit_id)) THEN EXIT proof;END IF;
    FOR child IN SELECT receipt.organization_id,receipt.child_run_id,receipt.parent_run_id,receipt.child_work_unit_id,receipt.proposal_id,receipt.snapshot_id,
      receipt.birth_content_sha256,receipt.classification,receipt.redacted_at,receipt.redacted_version,receipt.disposition_sha256,
      receipt.redaction_scope_kind,receipt.redaction_scope_id,receipt.redaction_purge_job_id
      FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=app.current_organization_id() ORDER BY receipt.child_run_id LOOP
      IF child.redacted_at IS NULL OR child.redacted_version IS NULL OR child.disposition_sha256 IS NULL
        OR child.disposition_sha256 IS DISTINCT FROM work.delegated_redaction_digest(child.child_run_id,child.child_work_unit_id,child.redacted_version,
          child.redaction_scope_kind,child.redaction_scope_id,child.redaction_purge_job_id)
        OR NOT EXISTS(SELECT 1 FROM ai.delegated_work_births birth WHERE birth.organization_id=child.organization_id AND birth.child_run_id=child.child_run_id
          AND ROW(birth.work_unit_id,birth.parent_run_id,birth.proposal_id,birth.snapshot_id,birth.birth_content_sha256,birth.classification)
            =ROW(child.child_work_unit_id,child.parent_run_id,child.proposal_id,child.snapshot_id,child.birth_content_sha256,child.classification))
        OR NOT EXISTS(SELECT 1 FROM ai.run_authority_checkpoints birth WHERE birth.organization_id=child.organization_id AND birth.run_id=child.child_run_id
          AND birth.protocol_version='authority-v1' AND birth.history_complete) THEN EXIT proof;END IF;
      PERFORM set_config('lifecycle.delegated_erase_work',child.child_work_unit_id::text,true);
      PERFORM actual.id FROM work.work_units actual WHERE actual.organization_id=child.organization_id AND actual.id=child.child_work_unit_id
        AND actual.title='Removed because an input was deleted.' AND actual.objective IS NULL AND actual.run_id IS NULL
        AND actual.version>=child.redacted_version FOR SHARE NOWAIT;
      IF NOT FOUND THEN EXIT proof;END IF;
    END LOOP;
    FOR source_row IN SELECT actual.id,actual.state,actual.version FROM knowledge.sources actual WHERE actual.organization_id=app.current_organization_id() ORDER BY actual.id FOR SHARE NOWAIT LOOP
      IF source_row.state NOT IN('revoked','deleted') THEN EXIT proof;END IF;
      SELECT actual.id,actual.state,actual.transcripts_checked_at,actual.delegated_work_checked_at,actual.transcript_source_version,actual.delegated_work_source_version,
        actual.transcript_restore_generation,actual.delegated_work_restore_generation,actual.delegated_work_remaining,actual.delegated_work_unknown,
        actual.delegated_work_controls_remaining INTO job FROM knowledge.purge_jobs actual
        WHERE actual.organization_id=app.current_organization_id() AND actual.source_id=source_row.id FOR SHARE NOWAIT;
      IF NOT FOUND OR job.state<>'completed' OR job.transcripts_checked_at IS NULL OR job.delegated_work_checked_at IS NULL
        OR job.transcript_source_version IS DISTINCT FROM source_row.version OR job.delegated_work_source_version IS DISTINCT FROM source_row.version
        OR job.transcript_restore_generation IS DISTINCT FROM generation OR job.delegated_work_restore_generation IS DISTINCT FROM generation
        OR job.delegated_work_remaining IS DISTINCT FROM 0 OR job.delegated_work_unknown IS DISTINCT FROM 0 OR job.delegated_work_controls_remaining IS DISTINCT FROM 0
        OR EXISTS(SELECT 1 FROM knowledge.documents actual WHERE actual.organization_id=app.current_organization_id() AND actual.source_id=source_row.id)
        OR EXISTS(SELECT 1 FROM knowledge.chunks actual WHERE actual.organization_id=app.current_organization_id() AND actual.source_id=source_row.id)
        OR EXISTS(SELECT 1 FROM knowledge.fact_evidence actual WHERE actual.organization_id=app.current_organization_id() AND actual.source_id=source_row.id) THEN EXIT proof;END IF;
      -- Native job guards validated the exact source anti-joins when issuing these certificates.
      -- Whole-tenant sealing independently requires EVERY actual run/child above to be closed,
      -- rather than trusting a cursor or reconstructing its historical input relationships.
      -- 0516 owns actual document/writer/delete/transport inventory. Missing document rows, legacy
      -- counters, HEAD absence and an old completed job are deliberately insufficient.
      IF to_regprocedure('lifecycle.raw_source_material_complete(uuid,bigint,uuid,uuid)') IS NULL THEN EXIT proof;END IF;
      IF lifecycle.raw_source_material_complete(source_row.id,source_row.version,job.id,generation) IS DISTINCT FROM true THEN EXIT proof;END IF;
    END LOOP;
    allowed:=true;
  END proof;
  PERFORM set_config('lifecycle.delegated_erase_work',coalesce(previous_work,''),true);RETURN allowed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('lifecycle.delegated_erase_work',coalesce(previous_work,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.current_delegated_material_proof() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION lifecycle.delegated_material_cleanup_ready() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();generation uuid;auth_generation uuid;intent record;allowed boolean:=false;
  previous_org text:=current_setting('lifecycle.delegated_erase_org',true);
BEGIN
  IF current_user<>'ensemus_migrator' OR session_user NOT IN('ensemus_app','ensemus_eraser') OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN RETURN false;END IF;
  PERFORM set_config('lifecycle.delegated_erase_org',tenant::text,true);
  BEGIN
    <<proof>>
    BEGIN
      -- A maintenance role's auth bypass is deliberately insufficient for a material witness.
      IF to_regprocedure('app.current_auth_restore_generation()') IS NULL THEN EXIT proof;END IF;
      auth_generation:=app.current_auth_restore_generation();generation:=ai.current_material_restore_generation();
      IF auth_generation IS NULL OR generation IS NULL THEN EXIT proof;END IF;
      PERFORM actual.id FROM org.organizations actual WHERE actual.id=tenant FOR NO KEY UPDATE NOWAIT;
      IF NOT FOUND OR lifecycle.erasure_open(tenant) IS DISTINCT FROM true THEN EXIT proof;END IF;
      SELECT actual.id,actual.erasure_started_at,admission.admitted_at INTO intent FROM lifecycle.offboardings actual
        JOIN lifecycle.offboarding_admissions admission ON admission.organization_id=actual.organization_id AND admission.offboarding_id=actual.id
        WHERE actual.organization_id=tenant AND actual.state='erasing' AND actual.erasure_started_at IS NOT NULL
          AND actual.requested_by_membership_id=admission.requested_by_membership_id;
      IF NOT FOUND THEN EXIT proof;END IF;
      IF EXISTS(SELECT 1 FROM lifecycle.delegated_erasure_receipts receipt WHERE receipt.organization_id=tenant AND receipt.offboarding_id=intent.id
        AND receipt.material_restore_generation=generation AND receipt.auth_restore_generation=auth_generation
        AND receipt.admitted_at=intent.admitted_at AND receipt.erasure_started_at=intent.erasure_started_at) THEN
        -- Only metadata cleanup can have happened since this immutable same-generation seal.
        -- New content INSERTs and Work body mutations remain permanently fenced while erasing.
        allowed:=true;
      ELSIF NOT EXISTS(SELECT 1 FROM lifecycle.delegated_erasure_receipts receipt WHERE receipt.organization_id=tenant AND receipt.offboarding_id=intent.id) THEN
        allowed:=lifecycle.current_delegated_material_proof();
      END IF;
    END proof;
  EXCEPTION WHEN lock_not_available THEN allowed:=false;END;
  PERFORM set_config('lifecycle.delegated_erase_org',coalesce(previous_org,''),true);RETURN allowed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('lifecycle.delegated_erase_org',coalesce(previous_org,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.delegated_material_cleanup_ready() FROM PUBLIC;
--> statement-breakpoint
-- Preserve every 0508 object/archive/restore predicate. Only the final source-absence proxy changes:
-- a genuine current material proof or sealed witness permits ordered removal of retained metadata.
CREATE OR REPLACE FUNCTION lifecycle.tenant_object_proofs_complete() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app.current_organization_id() IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM lifecycle.object_restore_debts d WHERE d.organization_id=app.current_organization_id())
  AND NOT EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=app.current_organization_id() AND c.state<>'proven')
  AND NOT EXISTS(SELECT 1 FROM platform.blob_lifecycle b WHERE b.organization_id=app.current_organization_id() AND(b.state<>'purged' OR b.purged_at IS NULL))
  AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=app.current_organization_id() AND(a.alive
   OR NOT EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=a.organization_id
    AND c.artifact_id=a.artifact_id AND c.kind IN('derived','ordinary') AND c.sha256=a.sha256
    AND c.object_key=a.organization_id::text||'/artifacts/'||a.artifact_id::text AND c.state='proven' AND c.absent_at>=c.terminal_at)))
  AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_lineage l WHERE l.organization_id=app.current_organization_id()
   AND(l.physical_purged_at IS NULL OR l.write_state<>'settled' OR l.state<>'blocked' OR l.held OR l.restore_reapply_pending
    OR NOT lifecycle.object_deletion_proven('derived',l.artifact_id,NULL,l.write_id,l.generation,l.object_key,l.artifact_sha256)))
  AND NOT EXISTS(SELECT 1 FROM sovereign.imported_archive_files f WHERE f.organization_id=app.current_organization_id()
   AND NOT sovereign.archive_file_has_physical_proof(f))
  AND NOT EXISTS(SELECT 1 FROM ai.unproven_child_work_inputs c WHERE c.organization_id=app.current_organization_id())
  AND NOT EXISTS(SELECT 1 FROM ai.run_input_checkpoints c WHERE c.organization_id=app.current_organization_id()
   AND(NOT c.history_complete OR c.fenced_at IS NULL OR c.payloads_purged_at IS NULL OR c.purged_fence_generation IS DISTINCT FROM c.fence_generation))
  AND NOT EXISTS(SELECT 1 FROM sovereign.organization_exports e WHERE e.organization_id=app.current_organization_id())
  AND lifecycle.delegated_material_cleanup_ready()
$$;
--> statement-breakpoint
CREATE FUNCTION lifecycle.seal_delegated_erasure(p_intent uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();generation uuid;auth_generation uuid;intent record;proof_hash text;
  runs bigint;children bigint;sources bigint;previous_org text:=current_setting('lifecycle.delegated_erase_org',true);sealed boolean:=false;
BEGIN
  IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL OR p_intent IS NULL THEN RETURN false;END IF;
  PERFORM set_config('lifecycle.delegated_erase_org',tenant::text,true);
  BEGIN
    <<proof>>
    BEGIN
      IF to_regprocedure('app.current_auth_restore_generation()') IS NULL THEN EXIT proof;END IF;
      auth_generation:=app.current_auth_restore_generation();generation:=ai.current_material_restore_generation();
      IF auth_generation IS NULL OR generation IS NULL THEN EXIT proof;END IF;
      PERFORM actual.id FROM org.organizations actual WHERE actual.id=tenant FOR NO KEY UPDATE NOWAIT;
      IF NOT FOUND OR lifecycle.erasure_open(tenant) IS DISTINCT FROM true OR NOT lifecycle.admitted_offboarding(p_intent) THEN EXIT proof;END IF;
      SELECT actual.erasure_started_at,admission.admitted_at INTO intent FROM lifecycle.offboardings actual
        JOIN lifecycle.offboarding_admissions admission ON admission.organization_id=actual.organization_id AND admission.offboarding_id=actual.id
        WHERE actual.organization_id=tenant AND actual.id=p_intent AND actual.state='erasing' AND actual.erasure_started_at IS NOT NULL
          AND actual.requested_by_membership_id=admission.requested_by_membership_id;
      IF NOT FOUND OR lifecycle.tenant_object_proofs_complete() IS DISTINCT FROM true THEN EXIT proof;END IF;
      IF EXISTS(SELECT 1 FROM lifecycle.delegated_erasure_receipts receipt WHERE receipt.organization_id=tenant AND receipt.offboarding_id=p_intent
        AND receipt.material_restore_generation=generation AND receipt.auth_restore_generation=auth_generation
        AND receipt.admitted_at=intent.admitted_at AND receipt.erasure_started_at=intent.erasure_started_at) THEN sealed:=true;EXIT proof;END IF;
      -- A new generation can only issue a new seal from genuine current proof, never from absence
      -- left by earlier proof-row cleanup or an old restore certificate.
      IF EXISTS(SELECT 1 FROM lifecycle.delegated_erasure_receipts receipt WHERE receipt.organization_id=tenant AND receipt.offboarding_id=p_intent)
        OR NOT lifecycle.current_delegated_material_proof() THEN EXIT proof;END IF;
      SELECT count(*) INTO runs FROM ai.agent_runs actual WHERE actual.organization_id=tenant;
      SELECT count(*) INTO children FROM ai.delegated_input_receipts actual WHERE actual.organization_id=tenant;
      SELECT count(*) INTO sources FROM knowledge.sources actual WHERE actual.organization_id=tenant;
      SELECT encode(sha256(convert_to(jsonb_build_object('protocol','delegated-erasure/v1','organizationId',tenant,'offboardingId',p_intent,
        'materialRestoreGeneration',generation,'authRestoreGeneration',auth_generation,'admittedAt',intent.admitted_at,'erasureStartedAt',intent.erasure_started_at,
        'runs',(SELECT coalesce(jsonb_agg(jsonb_build_array(actual.id,actual.version,actual.status) ORDER BY actual.id),'[]'::jsonb) FROM ai.agent_runs actual WHERE actual.organization_id=tenant),
        'children',(SELECT coalesce(jsonb_agg(jsonb_build_array(actual.child_run_id,actual.disposition_sha256) ORDER BY actual.child_run_id),'[]'::jsonb) FROM ai.delegated_input_receipts actual WHERE actual.organization_id=tenant),
        'sources',(SELECT coalesce(jsonb_agg(jsonb_build_array(actual.id,actual.version) ORDER BY actual.id),'[]'::jsonb) FROM knowledge.sources actual WHERE actual.organization_id=tenant))::text,'UTF8')),'hex') INTO proof_hash;
      INSERT INTO lifecycle.delegated_erasure_receipts(organization_id,offboarding_id,material_restore_generation,auth_restore_generation,
        admitted_at,erasure_started_at,proof_sha256,run_count,child_count,source_count)
        VALUES(tenant,p_intent,generation,auth_generation,intent.admitted_at,intent.erasure_started_at,proof_hash,runs,children,sources);
      sealed:=true;
    END proof;
  EXCEPTION WHEN lock_not_available THEN sealed:=false;END;
  PERFORM set_config('lifecycle.delegated_erase_org',coalesce(previous_org,''),true);RETURN sealed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('lifecycle.delegated_erase_org',coalesce(previous_org,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.seal_delegated_erasure(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.seal_delegated_erasure(uuid) TO ensemus_app;
--> statement-breakpoint
-- These exact proof tables gain no caller grant here. 0999 must explicitly review/count/reach
-- every one; the retained witness itself has no eraser DELETE capability. Normal runtime changes
-- remain append-only, while an actual restricted eraser must present the same-generation seal.
CREATE FUNCTION lifecycle.delete_delegated_proof() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();generation uuid;auth_generation uuid;allowed boolean:=false;
  previous_org text:=current_setting('lifecycle.delegated_erase_org',true);
BEGIN
  IF TG_OP<>'DELETE' OR TG_LEVEL<>'ROW' OR TG_RELID NOT IN('ai.run_authority_checkpoints'::regclass,'ai.run_read_authorities'::regclass,
    'ai.delegated_input_receipts'::regclass,'ai.delegated_work_births'::regclass,'ai.delegated_input_refs'::regclass,
    'knowledge.artifact_authority_receipts'::regclass,'knowledge.artifact_authority_refs'::regclass,
    'ai.source_run_closures'::regclass,'ai.record_run_closures'::regclass,'ai.record_purge_jobs'::regclass)
    OR current_user<>'ensemus_migrator' OR session_user<>'ensemus_eraser' OR NOT knowledge.is_service_actor()
    OR tenant IS NULL OR OLD.organization_id IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'DELEGATED_PROOF_RETAINED' USING ERRCODE='42501';END IF;
  PERFORM set_config('lifecycle.delegated_erase_org',tenant::text,true);
  BEGIN
    IF to_regprocedure('app.current_auth_restore_generation()') IS NOT NULL THEN
      auth_generation:=app.current_auth_restore_generation();generation:=ai.current_material_restore_generation();
      IF lifecycle.lock_erasure_tenant() IS TRUE AND generation IS NOT NULL AND auth_generation IS NOT NULL THEN
        SELECT EXISTS(SELECT 1 FROM lifecycle.delegated_erasure_receipts receipt JOIN lifecycle.offboardings intent
          ON intent.organization_id=receipt.organization_id AND intent.id=receipt.offboarding_id
          JOIN lifecycle.offboarding_admissions admission ON admission.organization_id=intent.organization_id AND admission.offboarding_id=intent.id
          WHERE receipt.organization_id=tenant AND receipt.material_restore_generation=generation AND receipt.auth_restore_generation=auth_generation
            AND intent.state='erasing' AND receipt.erasure_started_at=intent.erasure_started_at AND receipt.admitted_at=admission.admitted_at
            AND intent.requested_by_membership_id=admission.requested_by_membership_id) INTO allowed;
      END IF;
    END IF;
  EXCEPTION WHEN lock_not_available THEN allowed:=false;END;
  PERFORM set_config('lifecycle.delegated_erase_org',coalesce(previous_org,''),true);
  IF NOT allowed THEN RAISE EXCEPTION 'DELEGATED_ERASURE_WITNESS_REQUIRED' USING ERRCODE='EN850';END IF;
  RETURN OLD;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('lifecycle.delegated_erase_org',coalesce(previous_org,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.delete_delegated_proof() FROM PUBLIC;
DROP TRIGGER run_authority_checkpoint_keep ON ai.run_authority_checkpoints;
CREATE TRIGGER run_authority_checkpoint_keep BEFORE UPDATE OR TRUNCATE ON ai.run_authority_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER run_authority_checkpoint_erasure BEFORE DELETE ON ai.run_authority_checkpoints FOR EACH ROW EXECUTE FUNCTION lifecycle.delete_delegated_proof();
DROP TRIGGER run_read_authority_keep ON ai.run_read_authorities;
CREATE TRIGGER run_read_authority_keep BEFORE UPDATE OR TRUNCATE ON ai.run_read_authorities FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER run_read_authority_erasure BEFORE DELETE ON ai.run_read_authorities FOR EACH ROW EXECUTE FUNCTION lifecycle.delete_delegated_proof();
DROP TRIGGER delegated_input_receipt_no_delete ON ai.delegated_input_receipts;
CREATE TRIGGER delegated_input_receipt_no_delete BEFORE TRUNCATE ON ai.delegated_input_receipts FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER delegated_input_receipt_erasure BEFORE DELETE ON ai.delegated_input_receipts FOR EACH ROW EXECUTE FUNCTION lifecycle.delete_delegated_proof();
DROP TRIGGER delegated_work_birth_keep ON ai.delegated_work_births;
CREATE TRIGGER delegated_work_birth_keep BEFORE UPDATE OR TRUNCATE ON ai.delegated_work_births FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER delegated_work_birth_erasure BEFORE DELETE ON ai.delegated_work_births FOR EACH ROW EXECUTE FUNCTION lifecycle.delete_delegated_proof();
DROP TRIGGER delegated_input_refs_keep ON ai.delegated_input_refs;
CREATE TRIGGER delegated_input_refs_keep BEFORE UPDATE OR TRUNCATE ON ai.delegated_input_refs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER delegated_input_refs_erasure BEFORE DELETE ON ai.delegated_input_refs FOR EACH ROW EXECUTE FUNCTION lifecycle.delete_delegated_proof();
DROP TRIGGER artifact_authority_receipt_keep ON knowledge.artifact_authority_receipts;
CREATE TRIGGER artifact_authority_receipt_keep BEFORE UPDATE OR TRUNCATE ON knowledge.artifact_authority_receipts FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER artifact_authority_receipt_erasure BEFORE DELETE ON knowledge.artifact_authority_receipts FOR EACH ROW EXECUTE FUNCTION lifecycle.delete_delegated_proof();
DROP TRIGGER artifact_authority_refs_keep ON knowledge.artifact_authority_refs;
CREATE TRIGGER artifact_authority_refs_keep BEFORE UPDATE OR TRUNCATE ON knowledge.artifact_authority_refs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER artifact_authority_refs_erasure BEFORE DELETE ON knowledge.artifact_authority_refs FOR EACH ROW EXECUTE FUNCTION lifecycle.delete_delegated_proof();
DROP TRIGGER source_run_closures_keep ON ai.source_run_closures;
CREATE TRIGGER source_run_closures_keep BEFORE UPDATE OR TRUNCATE ON ai.source_run_closures FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER source_run_closures_erasure BEFORE DELETE ON ai.source_run_closures FOR EACH ROW EXECUTE FUNCTION lifecycle.delete_delegated_proof();
DROP TRIGGER record_run_closures_keep ON ai.record_run_closures;
CREATE TRIGGER record_run_closures_keep BEFORE UPDATE OR TRUNCATE ON ai.record_run_closures FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER record_run_closures_erasure BEFORE DELETE ON ai.record_run_closures FOR EACH ROW EXECUTE FUNCTION lifecycle.delete_delegated_proof();
DROP TRIGGER record_purge_jobs_no_delete ON ai.record_purge_jobs;
CREATE TRIGGER record_purge_jobs_no_delete BEFORE TRUNCATE ON ai.record_purge_jobs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER record_purge_jobs_erasure BEFORE DELETE ON ai.record_purge_jobs FOR EACH ROW EXECUTE FUNCTION lifecycle.delete_delegated_proof();
--> statement-breakpoint
-- Preserve 0508's fixed birth fence, adding only native proof metadata required to close already
-- fenced material. Each target's independent native row guard still proves its source/record/run.
CREATE OR REPLACE FUNCTION lifecycle.refuse_erasing_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid;life text;proof_append boolean:=false;
BEGIN
  IF TG_OP<>'INSERT' OR (TG_TABLE_SCHEMA NOT IN('ai','org','work','knowledge','integrations','secrets','studio','objects','packs','experience','sovereign','support','platform')
    AND (TG_TABLE_SCHEMA,TG_TABLE_NAME) NOT IN(('lifecycle','raw_source_inventories'),('lifecycle','raw_object_writes')))
    OR TG_RELID IS DISTINCT FROM to_regclass(quote_ident(TG_TABLE_SCHEMA)||'.'||quote_ident(TG_TABLE_NAME)) THEN
    RAISE EXCEPTION 'INVALID_ERASURE_BIRTH_TARGET' USING ERRCODE='42501';END IF;
  tenant:=NEW.organization_id;
  IF tenant IS NULL OR tenant IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'INVALID_ERASURE_BIRTH_TENANT' USING ERRCODE='42501';END IF;
  SELECT actual.lifecycle INTO life FROM org.organizations actual WHERE actual.id=tenant FOR SHARE NOWAIT;
  IF NOT FOUND OR life='deleted' THEN RAISE EXCEPTION 'TENANT_ERASURE_IN_PROGRESS' USING ERRCODE='EN850';END IF;
  IF EXISTS(SELECT 1 FROM lifecycle.offboardings actual WHERE actual.organization_id=tenant AND actual.state IN('erasing','verified','reported')) THEN
    IF session_user='ensemus_agent' AND knowledge.is_service_actor()
      AND EXISTS(SELECT 1 FROM lifecycle.offboardings actual WHERE actual.organization_id=tenant AND actual.state='erasing'
        AND lifecycle.admitted_offboarding(actual.id)) THEN
      -- Separate RELID branches are necessary: PostgreSQL resolves record fields before a Boolean
      -- short circuit, and these three protected row types intentionally have different fields.
      IF TG_RELID='ai.source_run_closures'::regclass THEN
        proof_append:=NEW.restore_generation=ai.current_material_restore_generation() AND NEW.fence_generation=1;
      ELSIF TG_RELID='ai.record_run_closures'::regclass THEN
        proof_append:=NEW.restore_generation=ai.current_material_restore_generation() AND NEW.fence_generation=1;
      ELSIF TG_RELID='ai.record_purge_jobs'::regclass THEN
        proof_append:=NEW.snapshot_sha256=ai.lock_record_purge_snapshot(NEW.record_kind,NEW.record_id)
          AND NEW.checked_at IS NULL AND NEW.restore_generation IS NULL;
      END IF;
    END IF;
    IF proof_append IS DISTINCT FROM true THEN RAISE EXCEPTION 'TENANT_ERASURE_IN_PROGRESS' USING ERRCODE='EN850';END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Once proof rows are removed, their absence must not revive a copied Work title. This trigger
-- fences only body mutation, retaining terminal release/status/accounting and ordinary pre-erasure
-- semantics. The existing redaction kernel and 0510 proof remain the sole narrow body transition.
CREATE FUNCTION work.guard_erasing_material_body() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE life text;
BEGIN
  IF TG_RELID<>'work.work_units'::regclass OR TG_OP<>'UPDATE' OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'ERASING_WORK_BODY_TARGET' USING ERRCODE='42501';END IF;
  IF ROW(NEW.title,NEW.objective) IS NOT DISTINCT FROM ROW(OLD.title,OLD.objective) THEN RETURN NEW;END IF;
  SELECT actual.lifecycle INTO life FROM org.organizations actual WHERE actual.id=OLD.organization_id FOR SHARE NOWAIT;
  IF NOT FOUND OR life='deleted' THEN RAISE EXCEPTION 'TENANT_ERASURE_IN_PROGRESS' USING ERRCODE='EN850';END IF;
  IF EXISTS(SELECT 1 FROM lifecycle.offboardings actual WHERE actual.organization_id=OLD.organization_id AND actual.state IN('erasing','verified','reported')) THEN
    IF session_user<>'ensemus_agent' OR NOT knowledge.is_service_actor() OR NEW.title IS DISTINCT FROM 'Removed because an input was deleted.'
      OR NEW.objective IS NOT NULL OR NEW.version<>OLD.version+1 OR NEW.run_id IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=OLD.organization_id AND receipt.child_work_unit_id=OLD.id
        AND receipt.child_run_id::text=current_setting('app.delegated_work_redaction_run',true) AND receipt.redacted_at IS NULL) THEN
      RAISE EXCEPTION 'TENANT_ERASURE_IN_PROGRESS' USING ERRCODE='EN850';END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION work.guard_erasing_material_body() FROM PUBLIC;
CREATE TRIGGER work_erasing_material_body BEFORE UPDATE ON work.work_units FOR EACH ROW EXECUTE FUNCTION work.guard_erasing_material_body();
--> statement-breakpoint
-- Rolling backstop for older/direct native writers. These selectors are set only from actual OLD
-- row metadata in the fixed trigger, not accepted as authority from its caller. No EXECUTE/body
-- grant is added. Existing authorized human deletes keep their no-hold semantics under their RLS.
CREATE FUNCTION lifecycle.material_delete_scope(p_org uuid,p_source uuid,p_run uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(current_user='ensemus_migrator' AND p_org=app.current_organization_id()
    AND p_org::text=current_setting('lifecycle.material_delete_org',true)
    AND(session_user='ensemus_app' OR(session_user='ensemus_agent' AND knowledge.is_service_actor()))
    AND(p_source IS NULL OR p_source::text=current_setting('lifecycle.material_delete_source',true))
    AND(p_run IS NULL OR p_run::text=current_setting('lifecycle.material_delete_run',true)),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.material_delete_scope(uuid,uuid,uuid) FROM PUBLIC;
CREATE POLICY material_delete_org_read ON org.organizations FOR SELECT TO ensemus_migrator USING(lifecycle.material_delete_scope(id,NULL,NULL));
CREATE POLICY material_delete_org_lock ON org.organizations FOR UPDATE TO ensemus_migrator USING(lifecycle.material_delete_scope(id,NULL,NULL)) WITH CHECK(false);
CREATE POLICY material_delete_source_read ON knowledge.sources FOR SELECT TO ensemus_migrator USING(lifecycle.material_delete_scope(organization_id,id,NULL));
CREATE POLICY material_delete_source_lock ON knowledge.sources FOR UPDATE TO ensemus_migrator USING(lifecycle.material_delete_scope(organization_id,id,NULL)) WITH CHECK(false);
CREATE POLICY material_delete_job_read ON knowledge.purge_jobs FOR SELECT TO ensemus_migrator USING(lifecycle.material_delete_scope(organization_id,source_id,NULL));
CREATE POLICY material_delete_job_lock ON knowledge.purge_jobs FOR UPDATE TO ensemus_migrator USING(lifecycle.material_delete_scope(organization_id,source_id,NULL)) WITH CHECK(false);
GRANT SELECT(organization_id,id,run_id) ON ai.execution_steps TO ensemus_migrator;
CREATE POLICY material_delete_step_metadata ON ai.execution_steps FOR SELECT TO ensemus_migrator
  USING(lifecycle.material_delete_scope(organization_id,NULL,NULL) AND id::text=current_setting('lifecycle.material_delete_row',true));
CREATE POLICY material_delete_checkpoint_read ON ai.run_input_checkpoints FOR SELECT TO ensemus_migrator USING(lifecycle.material_delete_scope(organization_id,NULL,run_id));
CREATE POLICY material_delete_checkpoint_lock ON ai.run_input_checkpoints FOR UPDATE TO ensemus_migrator USING(lifecycle.material_delete_scope(organization_id,NULL,run_id)) WITH CHECK(false);
CREATE POLICY material_delete_model_job_read ON ai.model_jobs FOR SELECT TO ensemus_migrator
  USING(lifecycle.material_delete_scope(organization_id,NULL,NULL) AND id::text=current_setting('lifecycle.material_delete_row',true));
CREATE POLICY material_delete_model_job_lock ON ai.model_jobs FOR UPDATE TO ensemus_migrator
  USING(lifecycle.material_delete_scope(organization_id,NULL,NULL) AND id::text=current_setting('lifecycle.material_delete_row',true)) WITH CHECK(false);
CREATE FUNCTION lifecycle.guard_material_delete_hold() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid;target_source uuid;target_run uuid;target_job uuid;source_row record;
  payload_target boolean:=false;run_payload_target boolean:=false;job_payload_target boolean:=false;
  previous_org text:=current_setting('lifecycle.material_delete_org',true);previous_source text:=current_setting('lifecycle.material_delete_source',true);
  previous_run text:=current_setting('lifecycle.material_delete_run',true);previous_row text:=current_setting('lifecycle.material_delete_row',true);
BEGIN
  IF TG_OP<>'DELETE' OR TG_LEVEL<>'ROW' OR TG_RELID NOT IN('ai.step_payloads'::regclass,'ai.model_job_payloads'::regclass,'knowledge.answers'::regclass,'knowledge.facts'::regclass,
    'knowledge.fact_evidence'::regclass,'knowledge.chunks'::regclass,'knowledge.embeddings'::regclass,'knowledge.documents'::regclass,'knowledge.object_writers'::regclass)
    OR current_user<>'ensemus_migrator' THEN RAISE EXCEPTION 'MATERIAL_DELETE_TARGET' USING ERRCODE='42501';END IF;
  tenant:=OLD.organization_id;
  IF tenant IS NULL OR tenant IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'MATERIAL_DELETE_TENANT' USING ERRCODE='42501';END IF;
  IF session_user='ensemus_eraser' THEN
    -- The restricted role retains its independent actual material witness/physical proof, not a
    -- role-name-only hold exception. Actual payload rows themselves keep that readiness false.
    IF NOT knowledge.is_service_actor() OR lifecycle.lock_erasure_tenant() IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'MATERIAL_DELETE_ERASURE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
    RETURN OLD;
  END IF;
  run_payload_target:=TG_RELID='ai.step_payloads'::regclass;job_payload_target:=TG_RELID='ai.model_job_payloads'::regclass;
  payload_target:=run_payload_target OR job_payload_target;
  IF(payload_target AND(session_user<>'ensemus_agent' OR NOT knowledge.is_service_actor()))
    OR(NOT payload_target AND session_user<>'ensemus_app') THEN
    RAISE EXCEPTION 'MATERIAL_DELETE_NATIVE_OPERATION_REQUIRED' USING ERRCODE='42501';END IF;
  PERFORM set_config('lifecycle.material_delete_org',tenant::text,true);
  PERFORM set_config('lifecycle.material_delete_source','',true);PERFORM set_config('lifecycle.material_delete_run','',true);
  PERFORM set_config('lifecycle.material_delete_row','',true);
  IF run_payload_target THEN
    PERFORM set_config('lifecycle.material_delete_row',OLD.step_id::text,true);
    SELECT actual.run_id INTO target_run FROM ai.execution_steps actual WHERE actual.organization_id=tenant AND actual.id=OLD.step_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'MATERIAL_DELETE_RUN_UNKNOWN' USING ERRCODE='EN119';END IF;
    PERFORM set_config('lifecycle.material_delete_run',target_run::text,true);
  ELSIF job_payload_target THEN
    target_job:=OLD.job_id;PERFORM set_config('lifecycle.material_delete_row',target_job::text,true);
  ELSIF TG_RELID='knowledge.documents'::regclass THEN target_source:=OLD.source_id;
  ELSIF TG_RELID='knowledge.chunks'::regclass THEN target_source:=OLD.source_id;
  ELSIF TG_RELID='knowledge.fact_evidence'::regclass THEN target_source:=OLD.source_id;
  ELSIF TG_RELID='knowledge.object_writers'::regclass THEN target_source:=OLD.source_id;
  ELSIF TG_RELID='knowledge.embeddings'::regclass THEN target_source:=OLD.source_id;
  END IF;
  IF target_source IS NOT NULL THEN
    PERFORM set_config('lifecycle.material_delete_source',target_source::text,true);
    SELECT actual.state,actual.version INTO source_row FROM knowledge.sources actual WHERE actual.organization_id=tenant AND actual.id=target_source FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'MATERIAL_DELETE_SOURCE_UNKNOWN' USING ERRCODE='EN119';END IF;
    IF source_row.state IN('revoked','deleted') AND knowledge.is_service_actor() THEN
      -- Current native purge identity is derived from the actual source-bearing row. Active-source
      -- indexing and authorized human operations keep their existing policy; this adds no grant.
      PERFORM actual.id FROM knowledge.purge_jobs actual WHERE actual.organization_id=tenant AND actual.source_id=target_source
        AND actual.state IN('pending','running','failed','completed') AND actual.transcripts_checked_at IS NOT NULL
        AND actual.transcript_source_version=source_row.version AND actual.transcript_restore_generation=ai.current_material_restore_generation() FOR SHARE NOWAIT;
      IF NOT FOUND THEN RAISE EXCEPTION 'MATERIAL_DELETE_PURGE_UNCONFIRMED' USING ERRCODE='EN119';END IF;
    END IF;
  END IF;
  -- The row may already be locked by DELETE: never wait in the inverse row->organization order.
  -- Fresh SPI reads after this barrier see a just-committed hold; NOWAIT refuses an in-flight hold.
  PERFORM actual.id FROM org.organizations actual WHERE actual.id=tenant FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM lifecycle.legal_holds actual WHERE actual.organization_id=tenant AND actual.status='active') THEN
    RAISE EXCEPTION 'MATERIAL_DELETE_HOLD_UNCONFIRMED' USING ERRCODE='EN119';END IF;
  IF run_payload_target THEN
    PERFORM actual.run_id FROM ai.run_input_checkpoints actual WHERE actual.organization_id=tenant AND actual.run_id=target_run
      AND actual.fenced_at IS NOT NULL AND actual.fence_generation=1 FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'MATERIAL_DELETE_RUN_UNFENCED' USING ERRCODE='EN119';END IF;
  ELSIF job_payload_target THEN
    PERFORM actual.id FROM ai.model_jobs actual WHERE actual.organization_id=tenant AND actual.id=target_job
      AND actual.fenced_at IS NOT NULL AND actual.fence_generation=1 FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'MATERIAL_DELETE_MODEL_JOB_UNFENCED' USING ERRCODE='EN120';END IF;
  END IF;
  -- Facts after their last evidence deletion and multi-source answers deliberately get no guessed
  -- subject/source relationship here. Their exact source/job check stays in the real native DAL Tx.
  PERFORM set_config('lifecycle.material_delete_org',coalesce(previous_org,''),true);PERFORM set_config('lifecycle.material_delete_source',coalesce(previous_source,''),true);
  PERFORM set_config('lifecycle.material_delete_run',coalesce(previous_run,''),true);PERFORM set_config('lifecycle.material_delete_row',coalesce(previous_row,''),true);RETURN OLD;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('lifecycle.material_delete_org',coalesce(previous_org,''),true);PERFORM set_config('lifecycle.material_delete_source',coalesce(previous_source,''),true);
  PERFORM set_config('lifecycle.material_delete_run',coalesce(previous_run,''),true);PERFORM set_config('lifecycle.material_delete_row',coalesce(previous_row,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.guard_material_delete_hold() FROM PUBLIC;
CREATE TRIGGER step_payloads_material_hold BEFORE DELETE ON ai.step_payloads FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_material_delete_hold();
CREATE TRIGGER model_job_payloads_material_hold BEFORE DELETE ON ai.model_job_payloads FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_material_delete_hold();
CREATE TRIGGER answers_material_hold BEFORE DELETE ON knowledge.answers FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_material_delete_hold();
CREATE TRIGGER facts_material_hold BEFORE DELETE ON knowledge.facts FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_material_delete_hold();
CREATE TRIGGER fact_evidence_material_hold BEFORE DELETE ON knowledge.fact_evidence FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_material_delete_hold();
CREATE TRIGGER chunks_material_hold BEFORE DELETE ON knowledge.chunks FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_material_delete_hold();
CREATE TRIGGER embeddings_material_hold BEFORE DELETE ON knowledge.embeddings FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_material_delete_hold();
CREATE TRIGGER documents_material_hold BEFORE DELETE ON knowledge.documents FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_material_delete_hold();
CREATE TRIGGER object_writers_material_hold BEFORE DELETE ON knowledge.object_writers FOR EACH ROW EXECUTE FUNCTION lifecycle.guard_material_delete_hold();
