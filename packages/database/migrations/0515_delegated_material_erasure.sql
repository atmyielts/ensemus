-- Unregistered source: requires coherent0417/0419/0508/0510/0514. Restore rotates the protected
-- root anchor AFTER PostgreSQL restore/schema readiness and BEFORE objects/reapply/readers start.
-- A UUID is a current trusted restore admission, not a user credential or historical input proof.
ALTER TABLE ai.run_input_checkpoints ADD CONSTRAINT run_input_restore_proof CHECK(purged_restore_generation IS NULL
  OR(payloads_purged_at IS NOT NULL AND purged_fence_generation=1 AND fence_generation=1 AND fenced_at IS NOT NULL));
ALTER TABLE org.organizations ADD COLUMN material_restore_generation uuid NOT NULL DEFAULT gen_random_uuid();
CREATE FUNCTION sovereign.guard_material_restore_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'org.organizations'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'MATERIAL_RESTORE_GENERATION_TARGET' USING ERRCODE='42501';END IF;
  IF TG_OP='INSERT' THEN NEW.material_restore_generation:=gen_random_uuid();RETURN NEW;END IF;
  IF NEW.material_restore_generation IS DISTINCT FROM OLD.material_restore_generation THEN
    IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' OR app.current_actor_type() IS DISTINCT FROM 'service'
      OR NEW.id IS DISTINCT FROM OLD.id OR OLD.id IS DISTINCT FROM app.current_organization_id()
      OR current_setting('sovereign.material_restore_mode',true) IS DISTINCT FROM 'row'
      OR current_setting('sovereign.material_restore_org',true) IS DISTINCT FROM OLD.id::text
      OR current_setting('sovereign.material_restore_generation',true) IS DISTINCT FROM NEW.material_restore_generation::text THEN
      RAISE EXCEPTION 'MATERIAL_RESTORE_GENERATION_IMMUTABLE' USING ERRCODE='42501';END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sovereign.guard_material_restore_generation() FROM PUBLIC;
CREATE TRIGGER organizations_material_restore_generation BEFORE INSERT OR UPDATE ON org.organizations FOR EACH ROW EXECUTE FUNCTION sovereign.guard_material_restore_generation();
CREATE POLICY material_restore_native_scan ON org.organizations FOR SELECT TO ensemus_migrator
  USING(current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND current_setting('sovereign.material_restore_mode',true)='scan');
CREATE POLICY material_restore_native_read ON org.organizations FOR SELECT TO ensemus_migrator
  USING(current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND current_setting('sovereign.material_restore_mode',true)='row'
    AND id=app.current_organization_id() AND id::text=current_setting('sovereign.material_restore_org',true));
CREATE POLICY material_restore_native_write ON org.organizations FOR UPDATE TO ensemus_migrator
  USING(current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND current_setting('sovereign.material_restore_mode',true)='row'
    AND id=app.current_organization_id() AND id::text=current_setting('sovereign.material_restore_org',true))
  WITH CHECK(current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND current_setting('sovereign.material_restore_mode',true)='row'
    AND id=app.current_organization_id() AND id::text=current_setting('sovereign.material_restore_org',true)
    AND material_restore_generation::text=current_setting('sovereign.material_restore_generation',true));
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
