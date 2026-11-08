-- Genuine read-time authority, new-run rolling admission and later delegated sinks.
-- Requires 0214/0216/0411/0414/0416. Source under construction; not a journal/apply instruction.
-- Legacy histories and 0414 quarantines are never guessed, promoted or deleted to obtain zero.
LOCK TABLE ai.agent_runs IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE ai.run_authority_checkpoints (
  organization_id uuid NOT NULL,run_id uuid NOT NULL,work_unit_id uuid NOT NULL,agent_version_id uuid NOT NULL,
  initiator_membership_id uuid NOT NULL,protocol_version text NOT NULL,history_complete boolean NOT NULL,
  born_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_authority_checkpoints_pk PRIMARY KEY(organization_id,run_id),
  CONSTRAINT run_authority_checkpoints_run_fk FOREIGN KEY(organization_id,run_id) REFERENCES ai.agent_runs(organization_id,id),
  CONSTRAINT run_authority_checkpoints_protocol CHECK((protocol_version='legacy' AND NOT history_complete) OR(protocol_version='authority-v1' AND history_complete))
);
ALTER TABLE ai.run_authority_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.run_authority_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY run_authority_tenant_read ON ai.run_authority_checkpoints FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
GRANT SELECT ON ai.run_authority_checkpoints TO ensemus_app;
CREATE POLICY authority_0417_backfill_read ON ai.agent_runs FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY authority_0417_backfill_write ON ai.run_authority_checkpoints FOR INSERT TO ensemus_migrator WITH CHECK(true);
INSERT INTO ai.run_authority_checkpoints(organization_id,run_id,work_unit_id,agent_version_id,initiator_membership_id,protocol_version,history_complete,born_at)
  SELECT organization_id,id,work_unit_id,agent_version_id,initiator_membership_id,'legacy',false,created_at FROM ai.agent_runs;
DROP POLICY authority_0417_backfill_write ON ai.run_authority_checkpoints;
DROP POLICY authority_0417_backfill_read ON ai.agent_runs;
CREATE POLICY run_authority_actual_birth ON ai.run_authority_checkpoints FOR INSERT TO ensemus_migrator
  WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()>0);
CREATE FUNCTION ai.track_run_authority_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'ai.agent_runs'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'RUN_AUTHORITY_BIRTH_TARGET' USING ERRCODE='42501';END IF;
  INSERT INTO ai.run_authority_checkpoints(organization_id,run_id,work_unit_id,agent_version_id,initiator_membership_id,protocol_version,history_complete,born_at)
    VALUES(NEW.organization_id,NEW.id,NEW.work_unit_id,NEW.agent_version_id,NEW.initiator_membership_id,'authority-v1',true,NEW.created_at);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.track_run_authority_birth() FROM PUBLIC;
CREATE TRIGGER run_authority_actual_birth AFTER INSERT ON ai.agent_runs FOR EACH ROW EXECUTE FUNCTION ai.track_run_authority_birth();
CREATE TRIGGER run_authority_checkpoint_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.run_authority_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TABLE ai.run_read_authorities (
  organization_id uuid NOT NULL,run_id uuid NOT NULL,input_kind text NOT NULL,input_id uuid NOT NULL,input_sha256 text NOT NULL,
  authorization_work_unit_id uuid,authority_inventory jsonb NOT NULL DEFAULT '[]'::jsonb,authority_sha256 text NOT NULL DEFAULT '',captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_read_authorities_pk PRIMARY KEY(organization_id,run_id,input_kind,input_id,input_sha256,authority_sha256),
  CONSTRAINT run_read_authorities_observation_fk FOREIGN KEY(organization_id,run_id,input_kind,input_id,input_sha256) REFERENCES ai.run_input_observations(organization_id,run_id,input_kind,input_id,input_sha256),
  CONSTRAINT run_read_authorities_shape CHECK(input_kind IN('work_unit','project','client','object_record','artifact') AND input_sha256 ~ '^[0-9a-f]{64}$' AND authority_sha256 ~ '^[0-9a-f]{64}$'
    AND(input_kind='artifact')=(authorization_work_unit_id IS NOT NULL) AND jsonb_typeof(authority_inventory)='array' AND jsonb_array_length(authority_inventory) BETWEEN 1 AND 1000 AND octet_length(authority_inventory::text)<=1048576)
);
ALTER TABLE ai.run_read_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.run_read_authorities FORCE ROW LEVEL SECURITY;
CREATE POLICY read_authority_tenant_read ON ai.run_read_authorities FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY read_authority_own_append ON ai.run_read_authorities FOR INSERT TO ensemus_agent WITH CHECK(organization_id=app.current_organization_id() AND app.current_actor_type()='agent' AND run_id::text=current_setting('app.agent_run_id',true));
GRANT SELECT ON ai.run_read_authorities TO ensemus_app;
GRANT INSERT ON ai.run_read_authorities TO ensemus_agent;
CREATE TRIGGER run_read_authority_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.run_read_authorities FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION ai.run_authority_protocol_version(p_run uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT protocol_version FROM ai.run_authority_checkpoints WHERE organization_id=app.current_organization_id() AND run_id=p_run
$$;
CREATE FUNCTION ai.run_authority_ready(p_run uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM ai.run_authority_checkpoints a JOIN ai.agent_runs r ON r.organization_id=a.organization_id AND r.id=a.run_id
    JOIN ai.run_input_checkpoints c ON c.organization_id=a.organization_id AND c.run_id=a.run_id
    JOIN org.memberships m ON m.organization_id=a.organization_id AND m.id=p_viewer AND m.status='active'
    WHERE a.organization_id=app.current_organization_id() AND a.run_id=p_run AND a.protocol_version='authority-v1' AND a.history_complete
      AND ROW(a.work_unit_id,a.agent_version_id,a.initiator_membership_id)=ROW(r.work_unit_id,r.agent_version_id,r.initiator_membership_id)
      AND r.initiator_membership_id=p_viewer AND c.history_complete AND c.fenced_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM ai.run_input_observations o WHERE o.organization_id=a.organization_id AND o.run_id=a.run_id AND NOT EXISTS(
        SELECT 1 FROM ai.run_read_authorities v WHERE v.organization_id=o.organization_id AND v.run_id=o.run_id AND v.input_kind=o.input_kind AND v.input_id=o.input_id AND v.input_sha256=o.input_sha256))),false)
$$;
CREATE FUNCTION ai.run_authority_read_admitted(p_run uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_user='ensemus_agent' AND app.current_actor_type()='agent' AND current_setting('app.agent_run_id',true)=p_run::text
    AND ai.run_input_admitted(p_run) AND EXISTS(SELECT 1 FROM ai.run_authority_checkpoints a
      WHERE a.organization_id=app.current_organization_id() AND a.run_id=p_run
        AND(a.protocol_version='legacy' OR(a.protocol_version='authority-v1' AND a.history_complete AND current_setting('app.agent_authority_protocol',true)='authority-v1:'||p_run::text))),false)
$$;
CREATE FUNCTION ai.run_authority_required(p_run uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(ai.run_authority_protocol_version(p_run)<>'legacy',true)
$$;
REVOKE ALL ON FUNCTION ai.run_authority_protocol_version(uuid),ai.run_authority_ready(uuid,uuid),ai.run_authority_read_admitted(uuid),ai.run_authority_required(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.run_authority_protocol_version(uuid),ai.run_authority_ready(uuid,uuid),ai.run_authority_read_admitted(uuid),ai.run_authority_required(uuid) TO ensemus_agent;
--> statement-breakpoint
-- Metadata only. Effective classes come from the public authority helper, not a body reconstruction.
CREATE FUNCTION ai.structured_read_authorities(p_kind text,p_id uuid)
RETURNS TABLE(kind text,id uuid,classification text,owner_membership_id uuid,parent_record_id uuid) LANGUAGE sql STABLE AS $$
  WITH own AS(SELECT c.* FROM knowledge.structured_record_catalog c WHERE c.organization_id=app.current_organization_id() AND c.record_kind=p_kind AND c.record_id=p_id AND c.alive),
  projects AS(SELECT record_id id FROM own WHERE record_kind='project' UNION SELECT parent_record_id FROM own WHERE record_kind='work_unit' AND parent_record_id IS NOT NULL),
  refs AS(SELECT record_kind kind,record_id id FROM own UNION SELECT 'project',id FROM projects
    UNION SELECT 'client',c.parent_record_id FROM knowledge.structured_record_catalog c JOIN projects p ON p.id=c.record_id WHERE c.organization_id=app.current_organization_id() AND c.record_kind='project' AND c.parent_record_id IS NOT NULL)
  SELECT c.record_kind,c.record_id,knowledge.structured_record_class(c.record_kind,c.record_id),c.owner_membership_id,c.parent_record_id FROM knowledge.structured_record_catalog c JOIN refs r ON r.kind=c.record_kind AND r.id=c.record_id
    WHERE c.organization_id=app.current_organization_id() AND c.alive ORDER BY c.record_kind COLLATE "C",c.record_id
$$;
CREATE FUNCTION ai.current_read_authority_inventory(p_kind text,p_id uuid,p_work uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH structured AS(
    SELECT * FROM ai.structured_read_authorities(p_kind,p_id) WHERE p_kind<>'artifact'
    UNION SELECT * FROM ai.structured_read_authorities('work_unit',p_work) WHERE p_kind='artifact'
    UNION SELECT s.* FROM knowledge.artifact_required_records(p_id) r CROSS JOIN LATERAL ai.structured_read_authorities(r.record_kind,r.record_id) s WHERE p_kind='artifact'
  ),entries AS(
    SELECT kind,id,classification,owner_membership_id,parent_record_id FROM structured
    UNION SELECT 'artifact',a.artifact_id,a.classification,NULL::uuid,NULL::uuid FROM knowledge.artifact_acl_catalog a WHERE p_kind='artifact' AND a.organization_id=app.current_organization_id() AND a.artifact_id=p_id AND a.alive
    UNION SELECT 'source',s.id,s.classification,s.owner_membership_id,NULL::uuid FROM knowledge.sources s WHERE p_kind='artifact' AND s.organization_id=app.current_organization_id() AND s.id IN(SELECT knowledge.artifact_required_sources(p_id))
  ),bounded AS(SELECT jsonb_build_object('kind',kind,'id',id,'classification',classification,'ownerMembershipId',owner_membership_id,'parentRecordId',parent_record_id) entry FROM entries ORDER BY kind COLLATE "C",id LIMIT 1001)
  SELECT coalesce(jsonb_agg(entry ORDER BY entry::text COLLATE "C"),'[]'::jsonb) FROM bounded
$$;
REVOKE ALL ON FUNCTION ai.structured_read_authorities(text,uuid),ai.current_read_authority_inventory(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.structured_read_authorities(text,uuid),ai.current_read_authority_inventory(text,uuid,uuid) TO ensemus_agent;
CREATE FUNCTION ai.lock_read_authority(p_kind text,p_id uuid,p_work uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r record;inventory jsonb;
BEGIN
  IF current_user<>'ensemus_agent' OR NOT ai.run_authority_read_admitted(nullif(current_setting('app.agent_run_id',true),'')::uuid) THEN RETURN false;END IF;
  IF p_kind='artifact' THEN
    IF p_work IS NULL OR NOT EXISTS(SELECT 1 FROM knowledge.artifact_work_links l WHERE l.organization_id=app.current_organization_id() AND l.artifact_id=p_id AND l.work_unit_id=p_work) THEN RETURN false;END IF;
    -- Source-close/purge always precedes catalog and run locks. Never wait while holding inverse rows.
    FOR r IN SELECT s.id FROM knowledge.sources s WHERE s.organization_id=app.current_organization_id() AND s.id IN(SELECT knowledge.artifact_required_sources(p_id)) ORDER BY s.id FOR SHARE NOWAIT LOOP NULL;END LOOP;
    IF NOT knowledge.lock_structured_record('work_unit',p_work) THEN RETURN false;END IF;
    PERFORM knowledge.lock_artifact_catalog(p_id);
    FOR r IN SELECT record_kind,record_id FROM(SELECT DISTINCT record_kind,record_id FROM knowledge.artifact_required_records(p_id)) records ORDER BY record_kind COLLATE "C",record_id LOOP
      IF NOT knowledge.lock_structured_record(r.record_kind,r.record_id) THEN RETURN false;END IF;
    END LOOP;
    IF NOT knowledge.structured_record_readable('work_unit',p_work,app.current_membership_id()) OR NOT knowledge.artifact_readable(p_id,app.current_membership_id()) THEN RETURN false;END IF;
  ELSIF p_kind IN('work_unit','project','client','object_record') AND p_work IS NULL THEN
    IF NOT knowledge.lock_structured_record(p_kind,p_id) OR NOT knowledge.structured_record_readable(p_kind,p_id,app.current_membership_id()) THEN RETURN false;END IF;
  ELSE RETURN false;END IF;
  inventory:=ai.current_read_authority_inventory(p_kind,p_id,p_work);
  RETURN jsonb_array_length(inventory) BETWEEN 1 AND 1000 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(inventory) i WHERE i->>'classification' IS NULL OR i->>'classification' NOT IN('public','internal','confidential','restricted')
    OR(ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid) IS NOT NULL AND knowledge.class_rank(i->>'classification')>ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid)));
END $$;
REVOKE ALL ON FUNCTION ai.lock_read_authority(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.lock_read_authority(text,uuid,uuid) TO ensemus_agent;
--> statement-breakpoint
CREATE FUNCTION ai.guard_read_authority_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inventory jsonb;
BEGIN
  IF TG_RELID<>'ai.run_read_authorities'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR ai.run_authority_protocol_version(NEW.run_id) IS DISTINCT FROM 'authority-v1'
    OR NOT ai.lock_read_authority(NEW.input_kind,NEW.input_id,NEW.authorization_work_unit_id)
    OR NOT EXISTS(SELECT 1 FROM ai.run_input_observations o WHERE o.organization_id=NEW.organization_id AND o.run_id=NEW.run_id AND o.input_kind=NEW.input_kind AND o.input_id=NEW.input_id AND o.input_sha256=NEW.input_sha256) THEN
    RAISE EXCEPTION 'READ_AUTHORITY_UNPROVEN' USING ERRCODE='EN119';END IF;
  inventory:=ai.current_read_authority_inventory(NEW.input_kind,NEW.input_id,NEW.authorization_work_unit_id);
  NEW.authority_inventory:=inventory;
  NEW.authority_sha256:=encode(sha256(convert_to(inventory::text,'UTF8')),'hex');
  NEW.captured_at:=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_read_authority_capture() FROM PUBLIC;
CREATE TRIGGER read_authority_capture BEFORE INSERT ON ai.run_read_authorities FOR EACH ROW EXECUTE FUNCTION ai.guard_read_authority_capture();
CREATE FUNCTION ai.require_observation_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'ai.run_input_observations'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'OBSERVATION_AUTHORITY_TARGET' USING ERRCODE='42501';END IF;
  IF ai.run_authority_protocol_version(NEW.run_id)='authority-v1' AND NOT EXISTS(SELECT 1 FROM ai.run_read_authorities a WHERE a.organization_id=NEW.organization_id AND a.run_id=NEW.run_id AND a.input_kind=NEW.input_kind AND a.input_id=NEW.input_id AND a.input_sha256=NEW.input_sha256) THEN
    RAISE EXCEPTION 'OBSERVATION_AUTHORITY_INCOMPLETE' USING ERRCODE='EN119';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.require_observation_authority() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER observation_authority_complete AFTER INSERT ON ai.run_input_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai.require_observation_authority();
--> statement-breakpoint
-- The marker is a coherent trusted-runtime version claim, not authentication. It is NEVER set by
-- generic withTenantTx. New-run body access fails before an old bundle can read/cache material.
CREATE POLICY authority_work_body ON work.work_units AS RESTRICTIVE FOR SELECT TO ensemus_agent
  USING(app.current_actor_type() IS DISTINCT FROM 'agent' OR NOT ai.run_authority_required(nullif(current_setting('app.agent_run_id',true),'')::uuid)
    OR ai.run_authority_read_admitted(nullif(current_setting('app.agent_run_id',true),'')::uuid));
CREATE POLICY authority_project_body ON work.projects AS RESTRICTIVE FOR SELECT TO ensemus_agent
  USING(app.current_actor_type() IS DISTINCT FROM 'agent' OR NOT ai.run_authority_required(nullif(current_setting('app.agent_run_id',true),'')::uuid)
    OR(ai.run_authority_read_admitted(nullif(current_setting('app.agent_run_id',true),'')::uuid)
      AND(ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid) IS NULL
        OR knowledge.class_rank(CASE WHEN client_id IS NULL THEN 'internal' ELSE knowledge.structured_record_class('client',client_id) END)<=ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid))));
CREATE POLICY authority_client_body ON work.clients AS RESTRICTIVE FOR SELECT TO ensemus_agent
  USING(app.current_actor_type() IS DISTINCT FROM 'agent' OR NOT ai.run_authority_required(nullif(current_setting('app.agent_run_id',true),'')::uuid)
    OR(ai.run_authority_read_admitted(nullif(current_setting('app.agent_run_id',true),'')::uuid)
      AND(ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid) IS NULL OR knowledge.class_rank(classification)<=ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid))));
CREATE POLICY authority_artifact_body ON work.artifacts AS RESTRICTIVE FOR SELECT TO ensemus_agent
  USING(app.current_actor_type() IS DISTINCT FROM 'agent' OR NOT ai.run_authority_required(nullif(current_setting('app.agent_run_id',true),'')::uuid)
    OR(ai.run_authority_read_admitted(nullif(current_setting('app.agent_run_id',true),'')::uuid)
      AND(ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid) IS NULL OR knowledge.class_rank(classification)<=ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid))));
CREATE POLICY authority_transcript_body ON ai.step_payloads AS RESTRICTIVE FOR SELECT TO ensemus_agent
  USING(app.current_actor_type() IS DISTINCT FROM 'agent' OR EXISTS(SELECT 1 FROM ai.execution_steps e WHERE e.organization_id=step_payloads.organization_id AND e.id=step_payloads.step_id
    AND e.run_id::text=current_setting('app.agent_run_id',true) AND(NOT ai.run_authority_required(e.run_id) OR ai.run_authority_read_admitted(e.run_id))));
CREATE FUNCTION ai.guard_authority_protocol_write() RETURNS trigger LANGUAGE plpgsql AS $$
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
      IF needed AND ai.run_authority_required(run_key) THEN
        -- 0419 replaces this explicit gate only after actual read authority is retained by the
        -- file sink and participates in fresh named-viewer serving, source purge and byte proof.
        RAISE EXCEPTION 'RUN_OUTPUT_AUTHORITY_UNBOUND' USING ERRCODE='EN119';END IF;
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
REVOKE ALL ON FUNCTION ai.guard_authority_protocol_write() FROM PUBLIC;
CREATE TRIGGER authority_observation_write BEFORE INSERT ON ai.run_input_observations FOR EACH ROW EXECUTE FUNCTION ai.guard_authority_protocol_write();
CREATE TRIGGER authority_step_write BEFORE INSERT OR UPDATE ON ai.execution_steps FOR EACH ROW EXECUTE FUNCTION ai.guard_authority_protocol_write();
CREATE TRIGGER authority_payload_write BEFORE INSERT ON ai.step_payloads FOR EACH ROW EXECUTE FUNCTION ai.guard_authority_protocol_write();
CREATE TRIGGER authority_proposal_write BEFORE INSERT ON ai.tool_proposals FOR EACH ROW EXECUTE FUNCTION ai.guard_authority_protocol_write();
CREATE TRIGGER authority_reservation_write BEFORE INSERT OR UPDATE ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION ai.guard_authority_protocol_write();
CREATE TRIGGER authority_call_write BEFORE INSERT OR UPDATE ON ai.model_call_attempts FOR EACH ROW EXECUTE FUNCTION ai.guard_authority_protocol_write();
CREATE TRIGGER authority_egress_write BEFORE INSERT ON governance.egress_decisions FOR EACH ROW EXECUTE FUNCTION ai.guard_authority_protocol_write();
CREATE TRIGGER artifact_lineage_03_authority BEFORE INSERT OR UPDATE ON knowledge.artifact_lineage FOR EACH ROW EXECUTE FUNCTION ai.guard_authority_protocol_write();
CREATE TRIGGER authority_main_snapshot_write BEFORE INSERT OR UPDATE ON ai.main_input_snapshots FOR EACH ROW EXECUTE FUNCTION ai.guard_authority_protocol_write();
--> statement-breakpoint
-- Terminal status control has no body-serving exception. The only definer projection is exact
-- transition metadata plus the existing canonical two-string content hash. Runtime receives no
-- owner privilege, Work UPDATE grant, body column grant, arbitrary target or interactive/MFA claim.
CREATE POLICY terminal_control_run_metadata ON ai.agent_runs FOR SELECT TO ensemus_migrator USING(
  organization_id=app.current_organization_id() AND app.current_actor_type() IN('agent','service')
  AND id::text=current_setting('app.terminal_work_control_run',true)
  AND(app.current_actor_type()='service' OR(id::text=current_setting('app.agent_run_id',true) AND initiator_membership_id=app.current_membership_id()))
  AND status IN('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified'));
CREATE POLICY terminal_control_run_lock ON ai.agent_runs FOR UPDATE TO ensemus_migrator USING(
  organization_id=app.current_organization_id() AND app.current_actor_type() IN('agent','service')
  AND id::text=current_setting('app.terminal_work_control_run',true)
  AND(app.current_actor_type()='service' OR(id::text=current_setting('app.agent_run_id',true) AND initiator_membership_id=app.current_membership_id()))
  AND status IN('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')) WITH CHECK(false);
CREATE POLICY terminal_control_authority_metadata ON ai.run_authority_checkpoints FOR SELECT TO ensemus_migrator USING(
  organization_id=app.current_organization_id() AND run_id::text=current_setting('app.terminal_work_control_run',true)
  AND(app.current_actor_type()='service' OR(app.current_actor_type()='agent' AND run_id::text=current_setting('app.agent_run_id',true))));
CREATE POLICY terminal_control_fence_metadata ON ai.run_input_checkpoints FOR SELECT TO ensemus_migrator USING(
  organization_id=app.current_organization_id() AND run_id::text=current_setting('app.terminal_work_control_run',true)
  AND(app.current_actor_type()='service' OR(app.current_actor_type()='agent' AND run_id::text=current_setting('app.agent_run_id',true))));
CREATE POLICY terminal_control_work_metadata ON work.work_units FOR SELECT TO ensemus_migrator USING(
  organization_id=app.current_organization_id() AND app.current_actor_type() IN('agent','service') AND EXISTS(
    SELECT 1 FROM ai.agent_runs r WHERE r.organization_id=work_units.organization_id AND r.work_unit_id=work_units.id
      AND r.id::text=current_setting('app.terminal_work_control_run',true)));
-- PostgreSQL locking reads also need UPDATE visibility. Only the fixed effect can use this private
-- selector; it rechecks exact from/version/Temporal ownership and cannot positively complete Work.
CREATE POLICY terminal_control_work_effect ON work.work_units FOR UPDATE TO ensemus_migrator USING(
  organization_id=app.current_organization_id() AND app.current_actor_type() IN('agent','service') AND EXISTS(
    SELECT 1 FROM ai.agent_runs r WHERE r.organization_id=work_units.organization_id AND r.work_unit_id=work_units.id
      AND r.id::text=current_setting('app.terminal_work_control_run',true)))
  WITH CHECK(organization_id=app.current_organization_id() AND app.current_actor_type() IN('agent','service') AND EXISTS(
    SELECT 1 FROM ai.agent_runs r WHERE r.organization_id=work_units.organization_id AND r.work_unit_id=work_units.id
      AND r.id::text=current_setting('app.terminal_work_control_run',true)));
CREATE FUNCTION work.agent_terminal_control_facts(p_run uuid)
RETURNS TABLE(id uuid,status text,version bigint,classification text,"ownerMembershipId" uuid,"runId" text,"runRequestedAt" timestamptz,"runRequestedByMembershipId" uuid,"hasExecutionPlan" boolean,"contentSha256" text,"runStatus" text,"initiatorMembershipId" uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_selector text:=current_setting('app.terminal_work_control_run',true);actual_run record;
BEGIN
  IF session_user<>'ensemus_agent' OR p_run IS NULL OR app.current_organization_id() IS NULL
    OR app.current_actor_type() NOT IN('agent','service') OR app.current_actor_type() IS NULL
    OR(app.current_actor_type()='agent' AND(p_run::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR app.current_membership_id() IS NULL)) THEN
    RAISE EXCEPTION 'TERMINAL_CONTROL_TARGET' USING ERRCODE='42501';END IF;
  PERFORM set_config('app.terminal_work_control_run',p_run::text,true);
  SELECT r.id,r.work_unit_id,r.temporal_run_id,r.status,r.initiator_membership_id INTO actual_run FROM ai.agent_runs r
    JOIN ai.run_authority_checkpoints a ON a.organization_id=r.organization_id AND a.run_id=r.id
    JOIN ai.run_input_checkpoints c ON c.organization_id=r.organization_id AND c.run_id=r.id
    WHERE r.organization_id=app.current_organization_id() AND r.id=p_run
      AND(app.current_actor_type()='service' OR r.initiator_membership_id=app.current_membership_id())
      AND r.status IN('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')
      AND a.protocol_version='authority-v1' AND a.history_complete
      AND ROW(a.work_unit_id,a.agent_version_id,a.initiator_membership_id)=ROW(r.work_unit_id,r.agent_version_id,r.initiator_membership_id)
      AND c.fenced_at IS NOT NULL AND c.fence_generation=1 FOR SHARE OF r NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'TERMINAL_CONTROL_UNAVAILABLE' USING ERRCODE='42501';END IF;
  IF actual_run.temporal_run_id IS NOT NULL THEN
    RETURN QUERY SELECT w.id,w.status,w.version,w.classification,w.owner_membership_id,w.run_id,w.run_requested_at,w.run_requested_by_membership_id,
      w.execution_plan IS NOT NULL AND w.execution_plan<>'',
      encode(sha256(convert_to('{"objective":'||to_json(coalesce(w.objective,''))::text||',"title":'||to_json(w.title)::text||'}','UTF8')),'hex'),
      actual_run.status,actual_run.initiator_membership_id
      FROM work.work_units w WHERE w.organization_id=app.current_organization_id() AND w.id=actual_run.work_unit_id AND w.run_id=actual_run.temporal_run_id FOR UPDATE OF w NOWAIT;
  END IF;
  PERFORM set_config('app.terminal_work_control_run',coalesce(previous_selector,''),true);
  RETURN;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.terminal_work_control_run',coalesce(previous_selector,''),true);
  RAISE;
END $$;
CREATE FUNCTION work.agent_terminal_control_transition(p_run uuid,p_expected_version bigint,p_from text,p_to text)
RETURNS TABLE(id uuid,status text,version bigint,classification text,"ownerMembershipId" uuid,"runId" text,"runRequestedAt" timestamptz,"runRequestedByMembershipId" uuid,"hasExecutionPlan" boolean,"contentSha256" text,"runStatus" text,"initiatorMembershipId" uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_selector text:=current_setting('app.terminal_work_control_run',true);f record;
BEGIN
  IF session_user<>'ensemus_agent' OR p_run IS NULL OR app.current_organization_id() IS NULL
    OR app.current_actor_type() NOT IN('agent','service') OR app.current_actor_type() IS NULL
    OR(app.current_actor_type()='agent' AND(p_run::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR app.current_membership_id() IS NULL)) THEN
    RAISE EXCEPTION 'TERMINAL_CONTROL_TARGET' USING ERRCODE='42501';END IF;
  PERFORM set_config('app.terminal_work_control_run',p_run::text,true);
  SELECT * INTO f FROM work.agent_terminal_control_facts(p_run);
  IF NOT FOUND OR f.version IS DISTINCT FROM p_expected_version OR f.status IS DISTINCT FROM p_from THEN RAISE EXCEPTION 'TERMINAL_CONTROL_STALE' USING ERRCODE='40001';END IF;
  IF f."runStatus" IN('completed','outcome_unverified') THEN
    IF p_from<>'running' OR p_to<>'verifying' THEN RAISE EXCEPTION 'TERMINAL_CONTROL_TRANSITION' USING ERRCODE='42501';END IF;
  ELSE
    IF NOT((p_from='running' AND p_to='failed') OR(p_from IN('ready','awaiting_approval','verifying') AND p_to='running')) THEN RAISE EXCEPTION 'TERMINAL_CONTROL_TRANSITION' USING ERRCODE='42501';END IF;
  END IF;
  RETURN QUERY UPDATE work.work_units AS w SET status=p_to,version=w.version+1,updated_at=clock_timestamp(),
      run_id=(CASE WHEN p_to='running' THEN w.run_id ELSE NULL END),run_requested_at=(CASE WHEN p_from='ready' THEN NULL ELSE w.run_requested_at END)
    WHERE w.organization_id=app.current_organization_id() AND w.id=f.id AND w.version=p_expected_version AND w.status=p_from AND w.run_id=f."runId"
    RETURNING w.id,w.status,w.version,w.classification,w.owner_membership_id,w.run_id,w.run_requested_at,w.run_requested_by_membership_id,
      w.execution_plan IS NOT NULL AND w.execution_plan<>'',
      encode(sha256(convert_to('{"objective":'||to_json(coalesce(w.objective,''))::text||',"title":'||to_json(w.title)::text||'}','UTF8')),'hex'),
      f."runStatus",f."initiatorMembershipId";
  IF NOT FOUND THEN RAISE EXCEPTION 'TERMINAL_CONTROL_STALE' USING ERRCODE='40001';END IF;
  PERFORM set_config('app.terminal_work_control_run',coalesce(previous_selector,''),true);
  RETURN;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.terminal_work_control_run',coalesce(previous_selector,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION work.agent_terminal_control_facts(uuid),work.agent_terminal_control_transition(uuid,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.agent_terminal_control_facts(uuid),work.agent_terminal_control_transition(uuid,bigint,text,text) TO ensemus_agent;

--> statement-breakpoint
-- Freeze actual read-time closures alongside the original 0416 inventory.
CREATE FUNCTION ai.main_input_base_inventory_0417(p_run uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH observations AS(
    SELECT o.input_kind kind,o.input_id id,o.input_sha256 hash,o.classification FROM ai.run_input_observations o
      WHERE o.organization_id=app.current_organization_id() AND o.run_id=p_run
      ORDER BY o.input_kind COLLATE "C",o.input_id,o.input_sha256 COLLATE "C" LIMIT 1001
  ),nodes AS(
    SELECT id,hash FROM observations WHERE kind='artifact'
    UNION SELECT i.input_artifact_id,i.input_sha256 FROM knowledge.artifact_lineage_inputs i JOIN observations o ON o.kind='artifact' AND o.id=i.artifact_id WHERE i.organization_id=app.current_organization_id()
  ),packages AS(
    SELECT p.id FROM knowledge.evidence_packages p WHERE p.organization_id=app.current_organization_id() AND p.run_id=p_run
    UNION SELECT b.package_id FROM knowledge.artifact_lineage_packages b JOIN nodes n ON n.id=b.artifact_id WHERE b.organization_id=app.current_organization_id()
    UNION SELECT p.id FROM knowledge.evidence_packages p JOIN knowledge.artifact_lineage l ON l.organization_id=p.organization_id AND l.execution_kind='agent_run' AND l.execution_id=p.run_id JOIN nodes n ON n.id=l.artifact_id WHERE p.organization_id=app.current_organization_id()
  ),calls AS(
    SELECT c.id,c.request_hash,c.classification FROM ai.model_call_attempts c WHERE c.organization_id=app.current_organization_id() AND c.run_id=p_run
  ),chunks AS(
    SELECT i.chunk_id id,i.content_sha256 hash,i.classification,i.source_id,i.document_id FROM knowledge.evidence_items i JOIN packages p ON p.id=i.package_id WHERE i.organization_id=app.current_organization_id()
    UNION SELECT i.chunk_id,i.content_sha256,a.classification,i.source_id,i.document_id FROM knowledge.artifact_citations i JOIN nodes n ON n.id=i.artifact_id JOIN knowledge.artifact_acl_catalog a ON a.organization_id=i.organization_id AND a.artifact_id=i.artifact_id WHERE i.organization_id=app.current_organization_id()
    UNION SELECT i.input_id,i.sha256,i.classification,i.source_id,c.document_id FROM ai.model_call_inputs i JOIN calls a ON a.id=i.call_id LEFT JOIN knowledge.chunks c ON c.organization_id=i.organization_id AND c.id=i.input_id WHERE i.organization_id=app.current_organization_id() AND i.kind='chunk'
  ),records AS(
    SELECT kind,id,hash,classification FROM observations WHERE kind<>'artifact'
    UNION SELECT r.record_kind,r.record_id,r.record_sha256,r.classification FROM knowledge.artifact_lineage_records r JOIN nodes n ON n.id=r.artifact_id WHERE r.organization_id=app.current_organization_id()
    UNION SELECT i.kind,i.input_id,i.sha256,i.classification FROM ai.model_call_inputs i JOIN calls c ON c.id=i.call_id WHERE i.organization_id=app.current_organization_id() AND i.kind<>'chunk'
  ),projects AS(
    SELECT id FROM records WHERE kind='project'
    UNION SELECT c.parent_record_id FROM knowledge.structured_record_catalog c JOIN records r ON r.kind='work_unit' AND r.id=c.record_id WHERE c.organization_id=app.current_organization_id() AND c.record_kind='work_unit' AND c.parent_record_id IS NOT NULL
  ),authority AS(
    SELECT kind,id FROM records
    UNION SELECT 'project',id FROM projects
    UNION SELECT 'client',c.parent_record_id FROM knowledge.structured_record_catalog c JOIN projects p ON p.id=c.record_id WHERE c.organization_id=app.current_organization_id() AND c.record_kind='project' AND c.parent_record_id IS NOT NULL
  ),sources AS(
    SELECT source_id id FROM chunks
    UNION SELECT s.source_id FROM knowledge.artifact_lineage_sources s JOIN nodes n ON n.id=s.artifact_id WHERE s.organization_id=app.current_organization_id()
  ),entries AS(
    SELECT kind,id,hash,classification,NULL::uuid source_id,NULL::uuid document_id FROM observations
    UNION SELECT 'artifact',n.id,n.hash,a.classification,NULL::uuid,NULL::uuid FROM nodes n JOIN knowledge.artifact_acl_catalog a ON a.organization_id=app.current_organization_id() AND a.artifact_id=n.id
    UNION SELECT kind,id,hash,classification,NULL::uuid,NULL::uuid FROM records
    UNION SELECT 'evidence_package',p.id,p.package_sha256,p.strongest_classification,NULL::uuid,NULL::uuid FROM knowledge.evidence_packages p JOIN packages i ON i.id=p.id WHERE p.organization_id=app.current_organization_id()
    UNION SELECT 'fact',f.fact_id,f.content_sha256,f.classification,NULL::uuid,NULL::uuid FROM knowledge.evidence_package_facts f JOIN packages p ON p.id=f.package_id WHERE f.organization_id=app.current_organization_id()
    -- A legacy package is not promoted by looking up its current claims. Missing real receipts
    -- remain an explicit invalid entry; the snapshot guard refuses before any model reservation.
    UNION SELECT 'unproven_fact',v.id,NULL,NULL,NULL::uuid,NULL::uuid FROM knowledge.evidence_packages p JOIN packages i ON i.id=p.id CROSS JOIN LATERAL unnest(p.verified_fact_ids) v(id)
      WHERE p.organization_id=app.current_organization_id() AND NOT EXISTS(SELECT 1 FROM knowledge.evidence_package_facts f WHERE f.organization_id=p.organization_id AND f.package_id=p.id AND f.fact_id=v.id)
    UNION SELECT 'model_call',id,request_hash,classification,NULL::uuid,NULL::uuid FROM calls
    UNION SELECT 'chunk',id,hash,classification,source_id,document_id FROM chunks
    UNION SELECT 'source',s.id,NULL,s.classification,s.id,NULL::uuid FROM knowledge.sources s JOIN sources i ON i.id=s.id WHERE s.organization_id=app.current_organization_id()
    UNION SELECT 'document',d.id,d.content_sha256,d.classification,d.source_id,d.id FROM knowledge.documents d WHERE d.organization_id=app.current_organization_id() AND d.id IN(SELECT document_id FROM chunks)
    UNION SELECT 'authority_'||kind,id,NULL,knowledge.structured_record_class(kind,id),NULL::uuid,NULL::uuid FROM authority
  ),bounded AS(
    SELECT jsonb_build_object('kind',kind,'id',id,'sha256',hash,'classification',classification,'sourceId',source_id,'documentId',document_id) entry FROM entries
    ORDER BY kind COLLATE "C",id,hash COLLATE "C",classification COLLATE "C",source_id,document_id LIMIT 1001
  ) SELECT coalesce(jsonb_agg(entry ORDER BY entry::text COLLATE "C"),'[]'::jsonb) FROM bounded
$$;

REVOKE ALL ON FUNCTION ai.main_input_base_inventory_0417(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.main_input_base_inventory_0417(uuid) TO ensemus_agent;
-- Preserve the public OID. These receipts describe actual historical read authority, including
-- exact old parents after reparenting; the base authority_* rows remain explicitly current metadata.
CREATE OR REPLACE FUNCTION ai.current_main_input_inventory(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE receipt_count bigint;receipt_bytes bigint;result jsonb;
BEGIN
  SELECT count(*),coalesce(sum(octet_length(a.authority_inventory::text)),0) INTO receipt_count,receipt_bytes
    FROM ai.run_read_authorities a WHERE a.organization_id=app.current_organization_id() AND a.run_id=p_run;
  IF receipt_count>1000 OR receipt_bytes>1048576 THEN
    RAISE EXCEPTION 'MAIN_READ_AUTHORITY_LIMIT' USING ERRCODE='EN119';END IF;
  WITH entries AS(
    SELECT value entry FROM jsonb_array_elements(ai.main_input_base_inventory_0417(p_run))
    UNION SELECT jsonb_build_object('kind','read_authority','id',a.input_id,'sha256',a.authority_sha256,
      'classification',(SELECT value->>'classification' FROM jsonb_array_elements(a.authority_inventory)
        ORDER BY knowledge.class_rank(value->>'classification') DESC LIMIT 1),
      'sourceId',NULL::uuid,'documentId',NULL::uuid,'inputKind',a.input_kind,'inputSha256',a.input_sha256,
      'authorizationWorkUnitId',a.authorization_work_unit_id,'authorityInventory',a.authority_inventory)
      FROM ai.run_read_authorities a WHERE a.organization_id=app.current_organization_id() AND a.run_id=p_run
  ),bounded AS(SELECT entry FROM entries ORDER BY entry::text COLLATE "C" LIMIT 1001)
  SELECT coalesce(jsonb_agg(entry ORDER BY entry::text COLLATE "C"),'[]'::jsonb) INTO result FROM bounded;
  IF octet_length(result::text)>1048576 THEN
    RAISE EXCEPTION 'MAIN_READ_AUTHORITY_LIMIT' USING ERRCODE='EN119';END IF;
  RETURN result;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ai.guard_main_input_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;inventory jsonb;
BEGIN
  IF TG_RELID<>'ai.main_input_snapshots'::regclass OR TG_OP NOT IN('INSERT','UPDATE') OR current_user<>'ensemus_agent'
    OR app.current_actor_type() IS DISTINCT FROM 'agent' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR NEW.viewer_membership_id IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'MAIN_SNAPSHOT_TARGET' USING ERRCODE='42501';END IF;
  PERFORM 1 FROM ai.run_input_checkpoints WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id FOR SHARE;
  SELECT e.kind,e.state,e.attempt,r.initiator_membership_id INTO s FROM ai.execution_steps e JOIN ai.agent_runs r ON r.organization_id=e.organization_id AND r.id=e.run_id
    WHERE e.organization_id=NEW.organization_id AND e.id=NEW.step_id AND e.run_id=NEW.run_id FOR SHARE OF e NOWAIT;
  IF NOT FOUND OR s.kind<>'model_turn' OR s.state<>'in_flight' OR s.attempt<>NEW.attempt OR s.initiator_membership_id<>NEW.viewer_membership_id OR NOT ai.run_input_admitted(NEW.run_id)
    OR NOT ai.run_inputs_readable(NEW.run_id,NEW.viewer_membership_id) THEN
    RAISE EXCEPTION 'MAIN_SNAPSHOT_ATTEMPT_STALE' USING ERRCODE='EN119';END IF;
  IF TG_OP='INSERT' THEN
    inventory:=ai.current_main_input_inventory(NEW.run_id);
    IF NEW.state<>'prepared' OR NEW.input_inventory IS DISTINCT FROM inventory OR jsonb_array_length(inventory) NOT BETWEEN 1 AND 1000
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(inventory) i WHERE i->>'classification' IS NULL OR i->>'classification' NOT IN('public','internal','confidential','restricted')
        OR i->>'kind' NOT IN('work_unit','project','client','object_record','artifact','chunk','document','source','fact','evidence_package','model_call','authority_work_unit','authority_project','authority_client','authority_object_record','read_authority')
        OR(i->>'kind' NOT IN('source','authority_work_unit','authority_project','authority_client','authority_object_record') AND(i->>'sha256' IS NULL OR i->>'sha256' !~ '^[0-9a-f]{64}$')))
      OR NEW.inventory_sha256 IS DISTINCT FROM encode(sha256(convert_to(inventory::text,'UTF8')),'hex')
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(inventory) i JOIN ai.agent_runs r ON r.organization_id=NEW.organization_id AND r.id=NEW.run_id
        WHERE i->>'kind'='work_unit' AND i->>'id'=r.work_unit_id::text) THEN
      RAISE EXCEPTION 'MAIN_SNAPSHOT_INCOMPLETE' USING ERRCODE='EN119';END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['state','result_kind','result_tool_id','result_payload_hash']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','result_kind','result_tool_id','result_payload_hash']) THEN
      RAISE EXCEPTION 'MAIN_SNAPSHOT_IMMUTABLE' USING ERRCODE='42501';END IF;
    IF OLD.state='prepared' AND NEW.state='dispatched' THEN
      IF NEW.input_inventory IS DISTINCT FROM ai.current_main_input_inventory(NEW.run_id) THEN RAISE EXCEPTION 'MAIN_SNAPSHOT_CHANGED' USING ERRCODE='EN119';END IF;
    ELSIF OLD.state='dispatched' AND NEW.state='response_received' THEN
      IF current_setting('app.knowledge_model_protocol',true) IS DISTINCT FROM('model-result-v1:'||NEW.run_id::text||':'||NEW.step_id::text||':'||NEW.attempt::text) THEN
        RAISE EXCEPTION 'MAIN_SNAPSHOT_RESULT_UNBOUND' USING ERRCODE='EN119';END IF;
    ELSE RAISE EXCEPTION 'MAIN_SNAPSHOT_ALREADY_CLAIMED' USING ERRCODE='EN119';END IF;
  END IF;
  RETURN NEW;
END $$;
