-- Source-only: apply only after reviewed joined real-role gates. No legacy intent is inferred.
-- Preflight runs as the migration owner with FORCE RLS temporarily disabled only in this transaction.
ALTER TABLE studio.process_runs NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM studio.process_runs WHERE status NOT IN ('completed','failed','cancelled')) THEN
   RAISE EXCEPTION 'PROCESS_LEGACY_ACTIVE_INTENT_MISSING' USING ERRCODE='EN418';
 END IF;
END $$;
ALTER TABLE studio.process_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE studio.process_run_intents(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),run_id uuid NOT NULL,
 spec_id uuid NOT NULL,root_work_unit_id uuid NOT NULL,started_by_membership_id uuid NOT NULL,
 spec_sha256 text NOT NULL CHECK(spec_sha256~'^[0-9a-f]{64}$'),birth_nonce uuid NOT NULL DEFAULT gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,run_id),UNIQUE(organization_id,root_work_unit_id),
 FOREIGN KEY(organization_id,run_id) REFERENCES studio.process_runs(organization_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(organization_id,spec_id) REFERENCES studio.process_specs(organization_id,id),
 FOREIGN KEY(organization_id,root_work_unit_id) REFERENCES work.work_units(organization_id,id),
 FOREIGN KEY(organization_id,started_by_membership_id) REFERENCES org.memberships(organization_id,id));
CREATE TABLE studio.process_step_births(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),run_id uuid NOT NULL,step_key text NOT NULL,
 work_unit_id uuid NOT NULL,started_by_membership_id uuid NOT NULL,spec_sha256 text NOT NULL CHECK(spec_sha256~'^[0-9a-f]{64}$'),
 birth_nonce uuid NOT NULL DEFAULT gen_random_uuid(),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,run_id,step_key),UNIQUE(organization_id,work_unit_id),
 FOREIGN KEY(organization_id,run_id) REFERENCES studio.process_run_intents(organization_id,run_id),
 FOREIGN KEY(organization_id,work_unit_id) REFERENCES work.work_units(organization_id,id),
 FOREIGN KEY(organization_id,started_by_membership_id) REFERENCES org.memberships(organization_id,id));
ALTER TABLE studio.process_run_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.process_run_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE studio.process_step_births ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.process_step_births FORCE ROW LEVEL SECURITY;
CREATE POLICY process_intents_tenant ON studio.process_run_intents FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY process_births_tenant ON studio.process_step_births FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
-- Fixed Work AFTER INSERT mirrors only; no callable privileged body reader or application writes.
CREATE POLICY process_intents_mirror ON studio.process_run_intents FOR INSERT TO ensemus_migrator WITH CHECK(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND started_by_membership_id=app.current_membership_id() AND run_id::text=current_setting('app.process_start_run_id',true));
CREATE POLICY process_births_mirror ON studio.process_step_births FOR INSERT TO ensemus_migrator WITH CHECK(
 session_user='ensemus_app' AND app.current_actor_type()='delegated' AND organization_id=app.current_organization_id()
 AND started_by_membership_id=app.current_membership_id() AND run_id::text=current_setting('app.process_step_run_id',true)
 AND step_key=current_setting('app.process_step_key',true));
GRANT SELECT ON studio.process_run_intents,studio.process_step_births TO ensemus_app;
CREATE TRIGGER process_intents_immutable BEFORE UPDATE OR DELETE ON studio.process_run_intents FOR EACH ROW EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER process_births_immutable BEFORE UPDATE OR DELETE ON studio.process_step_births FOR EACH ROW EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
-- Predicates are invoker-only metadata. They neither widen RLS nor return body/approval text.
CREATE FUNCTION studio.process_requested(p_run uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM studio.process_run_intents i JOIN studio.process_runs r
 ON r.organization_id=i.organization_id AND r.id=i.run_id JOIN studio.process_specs s
 ON s.organization_id=i.organization_id AND s.id=i.spec_id
 WHERE i.organization_id=app.current_organization_id() AND i.run_id=p_run AND i.spec_id=r.spec_id
 AND i.root_work_unit_id=r.root_work_unit_id AND i.started_by_membership_id=r.started_by_membership_id
 AND i.spec_sha256=s.spec_sha256 AND EXISTS(SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o
 ON o.organization_id=e.organization_id AND o.event_id=e.id WHERE e.organization_id=i.organization_id
 AND e.event_type='process_run.requested' AND e.aggregate_type='process_run' AND e.aggregate_id=p_run
 AND e.aggregate_version=1 AND e.actor_type='membership' AND e.actor_id=i.started_by_membership_id
 AND e.payload=jsonb_build_object('process_run_id',p_run,'spec_id',i.spec_id,'work_unit_id',i.root_work_unit_id)))
$$;
CREATE FUNCTION studio.process_inventory_complete(p_run uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_typeof(s.spec->'steps')='array' AND jsonb_array_length(s.spec->'steps') BETWEEN 1 AND 64
 AND (SELECT count(*) FROM studio.process_run_steps x WHERE x.organization_id=r.organization_id AND x.run_id=r.id)=jsonb_array_length(s.spec->'steps')
 AND (SELECT count(DISTINCT v->>'key') FROM jsonb_array_elements(s.spec->'steps') v)=jsonb_array_length(s.spec->'steps')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.spec->'steps') v WHERE NOT EXISTS(SELECT 1 FROM studio.process_run_steps x
 WHERE x.organization_id=r.organization_id AND x.run_id=r.id AND x.step_key=v->>'key')),false)
 FROM studio.process_runs r JOIN studio.process_specs s ON s.organization_id=r.organization_id AND s.id=r.spec_id
 WHERE r.organization_id=app.current_organization_id() AND r.id=p_run
$$;
CREATE FUNCTION studio.process_ancestors(p_run uuid,p_key text) RETURNS SETOF text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH RECURSIVE manifest AS(SELECT v FROM studio.process_runs r JOIN studio.process_specs s
 ON s.organization_id=r.organization_id AND s.id=r.spec_id CROSS JOIN LATERAL jsonb_array_elements(s.spec->'steps') v
 WHERE r.organization_id=app.current_organization_id() AND r.id=p_run),ancestors(key) AS(
 SELECT jsonb_array_elements_text(v->'after') FROM manifest WHERE v->>'key'=p_key
 UNION SELECT jsonb_array_elements_text(m.v->'after') FROM ancestors a JOIN manifest m ON m.v->>'key'=a.key)
 SELECT key FROM ancestors
$$;
CREATE FUNCTION studio.process_work_completed(p_work uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w work.work_units%ROWTYPE;
BEGIN
 SELECT * INTO w FROM work.work_units WHERE organization_id=app.current_organization_id() AND id=p_work FOR SHARE NOWAIT;
 RETURN w.id IS NOT NULL AND w.status='completed' AND EXISTS(SELECT 1 FROM work.work_transitions t
 JOIN platform.domain_events e ON e.organization_id=t.organization_id AND e.aggregate_id=t.work_unit_id
 JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id
 WHERE t.organization_id=w.organization_id AND t.work_unit_id=w.id AND t.from_version=w.version-1
 AND t.from_status='verifying' AND t.to_status='completed' AND t.completion_basis='owner_confirmed'
 AND t.actor_membership_id=w.owner_membership_id AND e.actor_type='membership' AND e.actor_id=t.actor_membership_id
 AND e.event_type='work.transitioned' AND e.aggregate_type='work_unit' AND e.aggregate_version=w.version
 AND e.payload=jsonb_build_object('work_unit_id',w.id,'from','verifying','to','completed'));
END $$;
CREATE FUNCTION studio.process_approval_valid(p_run uuid,p_key text,p_approval uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r studio.process_runs%ROWTYPE;s studio.process_specs%ROWTYPE;a work.approvals%ROWTYPE;x studio.process_run_steps%ROWTYPE;choice jsonb;
BEGIN
 SELECT * INTO r FROM studio.process_runs WHERE organization_id=app.current_organization_id() AND id=p_run;
 SELECT * INTO s FROM studio.process_specs WHERE organization_id=r.organization_id AND id=r.spec_id;
 SELECT * INTO x FROM studio.process_run_steps WHERE organization_id=r.organization_id AND run_id=r.id AND step_key=p_key;
 SELECT v INTO choice FROM jsonb_array_elements(s.spec->'steps') v WHERE v->>'key'=p_key;
 IF r.id IS NULL OR x.work_unit_id IS NULL OR choice->>'kind' IS DISTINCT FROM 'human_approval' THEN RETURN false;END IF;
 IF NOT knowledge.lock_structured_record('work_unit',r.root_work_unit_id) OR NOT knowledge.lock_structured_record('work_unit',x.work_unit_id) THEN RETURN false;END IF;
 SELECT * INTO a FROM work.approvals WHERE organization_id=r.organization_id AND id=p_approval FOR SHARE NOWAIT;
 PERFORM 1 FROM org.memberships m WHERE m.organization_id=r.organization_id AND m.id=a.approver_membership_id
 AND m.status='active' FOR SHARE NOWAIT;
 RETURN FOUND AND a.status='approved' AND a.work_unit_id=x.work_unit_id
 AND a.tool_name='process.step_approval' AND a.target_ref='process_run:'||r.id::text
 AND a.requested_by_membership_id=r.started_by_membership_id AND a.approver_membership_id<>r.started_by_membership_id
 AND a.action=jsonb_build_object('toolName','process.step_approval','toolVersion','1','targetRef','process_run:'||r.id::text,
 'payload',jsonb_build_object('process_run_id',r.id,'step_key',p_key,'spec_sha256',s.spec_sha256))
 AND a.action_hash=encode(sha256(convert_to('{"payload":{"process_run_id":'||to_jsonb(r.id::text)::text||',"spec_sha256":'||to_jsonb(s.spec_sha256)::text||',"step_key":'||to_jsonb(p_key)::text||'},"targetRef":'||to_jsonb('process_run:'||r.id::text)::text||',"toolName":"process.step_approval","toolVersion":"1"}','UTF8')),'hex')
 AND a.decided_at IS NOT NULL AND a.decided_at<a.expires_at AND knowledge.can_read_work(x.work_unit_id,a.approver_membership_id)
 AND (CASE choice->>'approverRole' WHEN 'named_reviewer' THEN EXISTS(SELECT 1 FROM work.work_assignments wa
 WHERE wa.organization_id=r.organization_id AND wa.work_unit_id=r.root_work_unit_id
 AND wa.membership_id=a.approver_membership_id AND wa.responsibility='reviewer')
 WHEN 'starter_manager' THEN false ELSE a.approver_membership_id=s.published_by_membership_id OR EXISTS(
 SELECT 1 FROM org.memberships m WHERE m.organization_id=r.organization_id AND m.id=a.approver_membership_id AND m.role IN ('owner','admin') AND m.status='active') END)
 AND EXISTS(SELECT 1 FROM work.approval_decisions d WHERE d.organization_id=r.organization_id AND d.approval_id=a.id
 AND d.actor_membership_id=a.approver_membership_id AND d.decision='approve' AND d.action_hash=a.action_hash
 AND d.decided_at<=a.expires_at) AND EXISTS(SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id WHERE e.organization_id=r.organization_id AND e.event_type='approval.resolved' AND e.aggregate_type='work_unit' AND e.aggregate_id=x.work_unit_id AND e.actor_type='membership' AND e.actor_id=a.approver_membership_id AND e.payload=jsonb_build_object('approval_id',a.id,'work_unit_id',x.work_unit_id,'outcome','approved'));
END $$;
CREATE FUNCTION studio.process_external_valid(p_action uuid,p_work uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a integrations.external_actions%ROWTYPE;
BEGIN
 SELECT * INTO a FROM integrations.external_actions WHERE organization_id=app.current_organization_id() AND id=p_action FOR SHARE NOWAIT;
 RETURN a.id IS NOT NULL AND a.status='sent' AND a.work_unit_id=p_work AND EXISTS(
 SELECT 1 FROM integrations.external_action_receipts receipt LEFT JOIN integrations.external_action_attempts attempt
 ON attempt.organization_id=receipt.organization_id AND attempt.id=receipt.attempt_id
 WHERE receipt.organization_id=a.organization_id AND receipt.external_action_id=a.id AND receipt.outcome='sent'
 AND receipt.request_hash=a.request_hash AND (CASE receipt.basis
 WHEN 'provider' THEN attempt.external_action_id=a.id AND attempt.request_hash=a.request_hash AND attempt.outcome='accepted'
 WHEN 'reconciliation' THEN attempt.external_action_id=a.id AND attempt.request_hash=a.request_hash AND attempt.outcome='accepted'
 WHEN 'person' THEN receipt.actor_membership_id=a.resolved_by_membership_id AND receipt.actor_membership_id IS NOT NULL
 AND a.resolution='confirmed_sent' AND EXISTS(SELECT 1 FROM integrations.external_action_attempts attempted WHERE attempted.organization_id=a.organization_id
 AND attempted.external_action_id=a.id AND attempted.request_hash=a.request_hash AND attempted.outcome='indeterminate')
 ELSE false END)) AND (NOT a.requires_approval OR EXISTS(SELECT 1 FROM work.approvals approval JOIN work.approval_decisions decision
 ON decision.organization_id=approval.organization_id AND decision.approval_id=approval.id
 WHERE approval.organization_id=a.organization_id AND approval.id=a.approval_id AND approval.work_unit_id=a.work_unit_id
 AND approval.status='approved' AND approval.action_hash=a.request_hash AND decision.decision='approve'
 AND decision.action_hash=a.request_hash AND decision.actor_membership_id=approval.approver_membership_id
 AND decision.decided_at<approval.expires_at));
END $$;
--> statement-breakpoint
-- Immutable protected birth inventory prevents attaching arbitrary old Work, including old Work made
-- earlier in the SAME transaction. Timestamp equality or a copied GUC never proves origin.
-- Row triggers may run after the caller already owns a Work/run lock. Refuse contention rather
-- than waiting in the inverse order of deprovisioning (policy -> membership -> Work).
CREATE FUNCTION studio.process_native_person_allowed() RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF app.current_actor_type()<>'user' THEN RETURN false;END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('interactive_policy:'||app.current_organization_id()::text,0)) THEN
 RAISE EXCEPTION 'PROCESS_PERSON_POLICY_BUSY' USING ERRCODE='55P03';END IF;
 PERFORM 1 FROM org.memberships m WHERE m.organization_id=app.current_organization_id() AND m.id=app.current_membership_id()
 AND m.user_id=app.current_user_id() AND m.status='active' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN false;END IF;
 RETURN experience.native_person_allowed();
END $$;
REVOKE ALL ON FUNCTION studio.process_native_person_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION studio.process_native_person_allowed() TO ensemus_app;
CREATE FUNCTION studio.guard_process_work_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE start_run text:=nullif(current_setting('app.process_start_run_id',true),'');
 start_spec text:=nullif(current_setting('app.process_start_spec_id',true),'');
 step_run text:=nullif(current_setting('app.process_step_run_id',true),'');step_key text:=nullif(current_setting('app.process_step_key',true),'');
 r studio.process_runs%ROWTYPE;s studio.process_specs%ROWTYPE;choice jsonb;person org.memberships%ROWTYPE;root_work work.work_units%ROWTYPE;
BEGIN
 IF start_run IS NULL AND start_spec IS NULL AND step_run IS NULL AND step_key IS NULL THEN RETURN NEW;END IF;
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.created_by_membership_id IS DISTINCT FROM app.current_membership_id()
 OR NEW.owner_membership_id IS DISTINCT FROM app.current_membership_id() OR NEW.status<>'queued' OR NEW.version<>1
 OR NEW.completion_criteria<>'[]'::jsonb OR NEW.objective IS NOT NULL OR NEW.project_id IS NOT NULL
 OR NEW.execution_plan IS NOT NULL OR NEW.run_id IS NOT NULL OR NEW.run_requested_at IS NOT NULL THEN
 RAISE EXCEPTION 'PROCESS_WORK_BIRTH_MISMATCH' USING ERRCODE='EN418';END IF;
 IF start_run IS NOT NULL AND start_spec IS NOT NULL AND step_run IS NULL AND step_key IS NULL THEN
   IF NOT studio.author_allowed() THEN RAISE EXCEPTION 'PROCESS_NATIVE_START_REQUIRED' USING ERRCODE='EN418';END IF;
   SELECT * INTO s FROM studio.process_specs WHERE organization_id=NEW.organization_id AND id=start_spec::uuid;
   IF s.id IS NULL OR (s.classification='restricted' AND s.published_by_membership_id<>app.current_membership_id())
   OR NEW.classification<>s.classification OR NEW.parent_id IS NOT NULL OR EXISTS(SELECT 1 FROM studio.process_runs
   WHERE organization_id=NEW.organization_id AND id=start_run::uuid) THEN
   RAISE EXCEPTION 'PROCESS_START_SOURCE_CHANGED' USING ERRCODE='EN418';END IF;
 ELSIF start_run IS NULL AND start_spec IS NULL AND step_run IS NOT NULL AND step_key IS NOT NULL THEN
   IF app.current_actor_type()<>'delegated' THEN RAISE EXCEPTION 'PROCESS_DELEGATED_STEP_REQUIRED' USING ERRCODE='EN418';END IF;
   SELECT * INTO r FROM studio.process_runs WHERE organization_id=NEW.organization_id AND id=step_run::uuid FOR UPDATE NOWAIT;
   SELECT * INTO s FROM studio.process_specs WHERE organization_id=r.organization_id AND id=r.spec_id;
   SELECT * INTO person FROM org.memberships WHERE organization_id=NEW.organization_id AND id=app.current_membership_id()
   AND user_id=app.current_user_id() AND status='active' FOR SHARE NOWAIT;
   SELECT v INTO choice FROM jsonb_array_elements(s.spec->'steps') v WHERE v->>'key'=step_key;
   SELECT * INTO root_work FROM work.work_units WHERE organization_id=NEW.organization_id AND id=r.root_work_unit_id FOR SHARE NOWAIT;
   IF r.id IS NULL OR s.id IS NULL OR root_work.id IS NULL OR person.id IS NULL OR person.role NOT IN ('owner','admin') OR choice IS NULL OR NOT studio.process_requested(r.id)
   OR r.started_by_membership_id<>person.id OR r.status NOT IN ('running','waiting') OR r.stop_code='STOP_REQUESTED'
   OR NEW.classification<>s.classification OR NEW.parent_id IS DISTINCT FROM r.root_work_unit_id OR NEW.title<>choice->>'label'
   OR NEW.due_at IS NOT NULL OR NOT coalesce(knowledge.can_read_work(r.root_work_unit_id,person.id),false)
   OR root_work.status IN ('completed','cancelled','failed') OR root_work.classification IS DISTINCT FROM s.classification
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(choice->'after') previous WHERE NOT coalesce(studio.process_step_proof(r.id,previous),false)) THEN
   RAISE EXCEPTION 'PROCESS_STEP_SOURCE_CHANGED' USING ERRCODE='EN418';END IF;
 ELSE RAISE EXCEPTION 'PROCESS_BIRTH_SELECTOR_INVALID' USING ERRCODE='EN418';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER process_work_birth_guard BEFORE INSERT ON work.work_units FOR EACH ROW EXECUTE FUNCTION studio.guard_process_work_birth();
-- Only the fixed mirror can see spec/intent IDs under its owner role. No text is returned.
CREATE POLICY process_birth_spec_mirror ON studio.process_specs FOR SELECT TO ensemus_migrator
 USING(session_user='ensemus_app' AND organization_id=app.current_organization_id()
 AND id::text=current_setting('app.process_start_spec_id',true));
CREATE POLICY process_birth_intent_mirror ON studio.process_run_intents FOR SELECT TO ensemus_migrator
 USING(session_user='ensemus_app' AND organization_id=app.current_organization_id()
 AND run_id::text=current_setting('app.process_step_run_id',true));
CREATE FUNCTION studio.record_process_work_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope text;manifest studio.process_specs%ROWTYPE;intent studio.process_run_intents%ROWTYPE;
BEGIN
 scope:=nullif(current_setting('app.process_start_run_id',true),'');
 IF scope IS NOT NULL THEN
   IF session_user<>'ensemus_app' OR app.current_actor_type()<>'user' OR NEW.organization_id<>app.current_organization_id()
   OR NEW.created_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN RAISE EXCEPTION 'PROCESS_BIRTH_DENIED' USING ERRCODE='EN418';END IF;
   SELECT * INTO manifest FROM studio.process_specs WHERE organization_id=NEW.organization_id
   AND id::text=current_setting('app.process_start_spec_id',true);
   IF manifest.id IS NULL THEN RAISE EXCEPTION 'PROCESS_BIRTH_DENIED' USING ERRCODE='EN418';END IF;
   INSERT INTO studio.process_run_intents(organization_id,run_id,spec_id,root_work_unit_id,started_by_membership_id,spec_sha256)
   VALUES(NEW.organization_id,scope::uuid,manifest.id,NEW.id,NEW.created_by_membership_id,manifest.spec_sha256);
 ELSE
   scope:=nullif(current_setting('app.process_step_run_id',true),'');IF scope IS NULL THEN RETURN NEW;END IF;
   IF session_user<>'ensemus_app' OR app.current_actor_type()<>'delegated' OR NEW.organization_id<>app.current_organization_id()
   OR NEW.created_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN RAISE EXCEPTION 'PROCESS_BIRTH_DENIED' USING ERRCODE='EN418';END IF;
   SELECT * INTO intent FROM studio.process_run_intents WHERE organization_id=NEW.organization_id AND run_id=scope::uuid;
   IF intent.run_id IS NULL THEN RAISE EXCEPTION 'PROCESS_BIRTH_DENIED' USING ERRCODE='EN418';END IF;
   INSERT INTO studio.process_step_births(organization_id,run_id,step_key,work_unit_id,started_by_membership_id,spec_sha256)
   VALUES(NEW.organization_id,intent.run_id,current_setting('app.process_step_key',true),NEW.id,NEW.created_by_membership_id,intent.spec_sha256);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER process_work_birth_record AFTER INSERT ON work.work_units FOR EACH ROW EXECUTE FUNCTION studio.record_process_work_birth();
REVOKE ALL ON FUNCTION studio.guard_process_work_birth(),studio.record_process_work_birth() FROM PUBLIC;

--> statement-breakpoint
CREATE FUNCTION studio.process_artifact_valid(p_artifact uuid,p_work uuid,p_viewer uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE catalog knowledge.artifact_acl_catalog%ROWTYPE;source_id uuid;record_ref record;
BEGIN
 -- All locks are NOWAIT or inherited fixed helper locks. A competing closure is a retry, not a stale pass.
 FOR source_id IN SELECT id FROM knowledge.sources WHERE organization_id=app.current_organization_id()
 AND id IN(SELECT knowledge.artifact_required_sources(p_artifact)) ORDER BY id FOR SHARE NOWAIT LOOP NULL;END LOOP;
 FOR record_ref IN SELECT record_kind,record_id FROM knowledge.artifact_lineage_records
 WHERE organization_id=app.current_organization_id() AND (artifact_id=p_artifact OR artifact_id IN(SELECT input_artifact_id FROM knowledge.artifact_lineage_inputs WHERE organization_id=app.current_organization_id() AND artifact_id=p_artifact)) ORDER BY record_kind,record_id LOOP
 IF NOT knowledge.lock_structured_record(record_ref.record_kind,record_ref.record_id) THEN RETURN false;END IF;END LOOP;
 PERFORM knowledge.lock_artifact_catalog(p_artifact);
 SELECT * INTO catalog FROM knowledge.artifact_acl_catalog WHERE organization_id=app.current_organization_id() AND artifact_id=p_artifact;
 RETURN coalesce(catalog.alive,false) AND knowledge.artifact_readable(p_artifact,p_viewer) AND EXISTS(SELECT 1 FROM knowledge.artifact_work_links
 WHERE organization_id=app.current_organization_id() AND artifact_id=p_artifact AND work_unit_id=p_work)
 AND ((catalog.provenance_state='ordinary' AND EXISTS(SELECT 1 FROM work.artifacts a WHERE a.organization_id=catalog.organization_id
 AND a.id=p_artifact AND a.created_by_membership_id IS NOT NULL)) OR knowledge.artifact_is_accepted(p_artifact,p_work));
END $$;
CREATE FUNCTION studio.process_step_proof(p_run uuid,p_key text) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r studio.process_runs%ROWTYPE;s studio.process_specs%ROWTYPE;x studio.process_run_steps%ROWTYPE;
 step jsonb;candidate studio.process_run_steps%ROWTYPE;agent ai.agent_runs%ROWTYPE;scope uuid;
BEGIN
 SELECT * INTO r FROM studio.process_runs WHERE organization_id=app.current_organization_id() AND id=p_run;
 SELECT * INTO s FROM studio.process_specs WHERE organization_id=r.organization_id AND id=r.spec_id;
 SELECT * INTO x FROM studio.process_run_steps WHERE organization_id=r.organization_id AND run_id=r.id AND step_key=p_key;
 SELECT v INTO step FROM jsonb_array_elements(s.spec->'steps') v WHERE v->>'key'=p_key;
 IF x.status IS DISTINCT FROM 'done' OR step IS NULL OR NOT studio.process_requested(r.id)
 OR NOT EXISTS(SELECT 1 FROM studio.process_step_births b WHERE b.organization_id=r.organization_id AND b.run_id=r.id
 AND b.step_key=p_key AND b.work_unit_id=x.work_unit_id AND b.started_by_membership_id=r.started_by_membership_id AND b.spec_sha256=s.spec_sha256)
 OR NOT coalesce(studio.process_work_completed(x.work_unit_id),false) THEN RETURN false;END IF;
 IF step->>'kind'='work_item' THEN RETURN true;
 ELSIF step->>'kind'='human_approval' THEN RETURN studio.process_approval_valid(r.id,p_key,x.approval_id);
 ELSIF step->>'kind'='external_action' THEN
   RETURN studio.process_external_valid(x.external_action_id,x.work_unit_id) AND EXISTS(SELECT 1 FROM integrations.external_actions a
   WHERE a.organization_id=r.organization_id AND a.id=x.external_action_id AND a.tool_name=step->>'toolId'
   AND a.approval_id=x.approval_id);
 ELSIF step->>'kind'='agent_task' THEN
   SELECT * INTO agent FROM ai.agent_runs WHERE organization_id=r.organization_id AND id=x.agent_run_id FOR SHARE NOWAIT;
   RETURN agent.id IS NOT NULL AND agent.status='completed' AND agent.ended_at IS NOT NULL
   AND agent.work_unit_id=x.work_unit_id AND agent.initiator_membership_id=r.started_by_membership_id
   AND agent.parent_run_id IS NULL AND agent.depth=0 AND EXISTS(SELECT 1 FROM ai.agent_versions v
   WHERE v.organization_id=r.organization_id AND v.id=agent.agent_version_id AND v.definition_id=(step->>'agentDefinitionId')::uuid)
   AND EXISTS(SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id
   WHERE e.organization_id=r.organization_id AND e.aggregate_type='agent_run' AND e.aggregate_id=agent.id
   AND e.event_type='agent_run.requested' AND e.actor_id=r.started_by_membership_id)
   AND EXISTS(SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id
   WHERE e.organization_id=r.organization_id AND e.aggregate_type='agent_run' AND e.aggregate_id=agent.id
   AND e.event_type='agent_run.finished' AND e.aggregate_version=agent.version AND e.payload->>'status'='completed');
 ELSIF step->>'kind'='evidence_check' THEN
   IF step->>'evidence'='artifact_attached' THEN
     FOR scope IN SELECT r.root_work_unit_id UNION SELECT x.work_unit_id UNION SELECT before.work_unit_id
     FROM studio.process_run_steps before WHERE before.organization_id=r.organization_id AND before.run_id=r.id
     AND before.step_key IN(SELECT studio.process_ancestors(r.id,p_key)) LOOP
       IF scope IS NOT NULL AND studio.process_artifact_valid(x.artifact_id,scope,r.started_by_membership_id) THEN RETURN true;END IF;
     END LOOP;
   ELSIF step->>'evidence' IN ('reviewer_approved','external_receipt') THEN
     FOR candidate IN SELECT before.* FROM studio.process_run_steps before WHERE before.organization_id=r.organization_id AND before.run_id=r.id
     AND before.step_key IN(SELECT studio.process_ancestors(r.id,p_key)) AND before.status='done' ORDER BY before.step_key LOOP
       IF step->>'evidence'='reviewer_approved' AND x.approval_id IS NOT NULL AND candidate.approval_id=x.approval_id
       AND studio.process_approval_valid(r.id,candidate.step_key,candidate.approval_id) AND studio.process_step_proof(r.id,candidate.step_key) THEN RETURN true;END IF;
       IF step->>'evidence'='external_receipt' AND x.external_action_id IS NOT NULL AND candidate.external_action_id=x.external_action_id
       AND studio.process_external_valid(candidate.external_action_id,candidate.work_unit_id) AND studio.process_step_proof(r.id,candidate.step_key) THEN RETURN true;END IF;
     END LOOP;
   END IF;
 END IF;
 RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION studio.guard_process_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE person org.memberships%ROWTYPE;root work.work_units%ROWTYPE;intent studio.process_run_intents%ROWTYPE;
BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'PROCESS_TENANT_REQUIRED' USING ERRCODE='EN418';END IF;
 IF TG_OP='INSERT' THEN
   IF NOT studio.author_allowed() OR NEW.started_by_membership_id IS DISTINCT FROM app.current_membership_id()
   OR NEW.status<>'queued' OR NEW.version<>1 OR NEW.finished_at IS NOT NULL OR NEW.temporal_run_id IS NOT NULL OR NEW.stop_code IS NOT NULL THEN
   RAISE EXCEPTION 'PROCESS_NATIVE_START_REQUIRED' USING ERRCODE='EN418';END IF;
   SELECT * INTO intent FROM studio.process_run_intents WHERE organization_id=NEW.organization_id AND run_id=NEW.id;
   IF intent.run_id IS NULL OR intent.spec_id<>NEW.spec_id OR intent.root_work_unit_id<>NEW.root_work_unit_id
   OR intent.started_by_membership_id<>NEW.started_by_membership_id THEN RAISE EXCEPTION 'PROCESS_ROOT_BIRTH_REQUIRED' USING ERRCODE='EN418';END IF;
   RETURN NEW;
 END IF;
 IF OLD.status IN ('completed','failed','cancelled') OR NOT studio.process_requested(OLD.id)
 OR ROW(NEW.organization_id,NEW.id,NEW.spec_id,NEW.root_work_unit_id,NEW.started_by_membership_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.spec_id,OLD.root_work_unit_id,OLD.started_by_membership_id,OLD.created_at) THEN
 RAISE EXCEPTION 'PROCESS_HISTORY_IMMUTABLE' USING ERRCODE='EN418';END IF;
 IF app.current_actor_type()='user' THEN
   -- Same lock order as fresh DAL authorization and actual deprovisioning.
   IF NOT studio.process_native_person_allowed() THEN RAISE EXCEPTION 'PROCESS_PERSON_REQUIRED' USING ERRCODE='EN418';END IF;
   SELECT * INTO person FROM org.memberships WHERE organization_id=NEW.organization_id AND id=app.current_membership_id()
   AND user_id=app.current_user_id() AND status='active' FOR SHARE NOWAIT;
   SELECT * INTO root FROM work.work_units WHERE organization_id=NEW.organization_id AND id=NEW.root_work_unit_id FOR SHARE NOWAIT;
   IF person.id IS NULL OR NOT knowledge.can_read_work(root.id,person.id) OR NOT (root.owner_membership_id=person.id OR person.role IN ('owner','admin'))
   OR NEW.stop_code IS DISTINCT FROM 'STOP_REQUESTED' OR NEW.status<>OLD.status OR NEW.version<>OLD.version+1
   OR NEW.temporal_run_id IS DISTINCT FROM OLD.temporal_run_id OR NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
   RAISE EXCEPTION 'PROCESS_STOP_DENIED' USING ERRCODE='EN418';END IF;
 ELSIF app.current_actor_type()='service' THEN
   IF NEW.status='queued' OR (NEW.status IN ('completed','failed','cancelled') AND (NEW.version<>OLD.version+1 OR NEW.finished_at IS NULL))
   OR (NEW.status IN ('running','waiting') AND (NEW.version<>OLD.version OR NEW.finished_at IS NOT NULL))
   OR (OLD.stop_code='STOP_REQUESTED' AND NEW.status NOT IN ('completed','failed','cancelled') AND NEW.stop_code IS DISTINCT FROM OLD.stop_code)
   THEN RAISE EXCEPTION 'PROCESS_TRANSITION_DENIED' USING ERRCODE='EN418';END IF;
 ELSE RAISE EXCEPTION 'PROCESS_WORKER_REQUIRED' USING ERRCODE='EN418';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER process_runs_00_authority BEFORE INSERT OR UPDATE ON studio.process_runs FOR EACH ROW EXECUTE FUNCTION studio.guard_process_run();
CREATE FUNCTION studio.guard_process_step() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r studio.process_runs%ROWTYPE;s studio.process_specs%ROWTYPE;choice jsonb;person org.memberships%ROWTYPE;root work.work_units%ROWTYPE;
BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'PROCESS_TENANT_REQUIRED' USING ERRCODE='EN418';END IF;
 SELECT * INTO r FROM studio.process_runs WHERE organization_id=NEW.organization_id AND id=NEW.run_id FOR SHARE NOWAIT;
 SELECT * INTO s FROM studio.process_specs WHERE organization_id=NEW.organization_id AND id=r.spec_id;
 SELECT v INTO choice FROM jsonb_array_elements(s.spec->'steps') v WHERE v->>'key'=NEW.step_key;
 IF r.id IS NULL OR choice IS NULL OR NOT EXISTS(SELECT 1 FROM studio.process_run_intents i WHERE i.organization_id=r.organization_id AND i.run_id=r.id)
 THEN RAISE EXCEPTION 'PROCESS_STEP_INTENT_REQUIRED' USING ERRCODE='EN418';END IF;
 IF TG_OP='INSERT' THEN
   IF app.current_actor_type()<>'user' OR r.started_by_membership_id IS DISTINCT FROM app.current_membership_id()
   OR NOT studio.author_allowed() OR r.status<>'queued' OR NEW.status<>'pending' OR NEW.stop_code IS NOT NULL
   OR NEW.work_unit_id IS NOT NULL OR NEW.agent_run_id IS NOT NULL OR NEW.approval_id IS NOT NULL
   OR NEW.external_action_id IS NOT NULL OR NEW.artifact_id IS NOT NULL THEN
   RAISE EXCEPTION 'PROCESS_STEP_INVALID_START' USING ERRCODE='EN418';END IF;RETURN NEW;
 END IF;
 IF r.status IN ('completed','failed','cancelled') OR NOT studio.process_requested(r.id)
 OR ROW(NEW.organization_id,NEW.run_id,NEW.step_key) IS DISTINCT FROM ROW(OLD.organization_id,OLD.run_id,OLD.step_key) THEN
 RAISE EXCEPTION 'PROCESS_STEP_HISTORY_IMMUTABLE' USING ERRCODE='EN418';END IF;
 IF app.current_actor_type()='user' THEN
   IF NOT studio.process_native_person_allowed() OR choice->>'kind'<>'external_action'
   OR OLD.status<>'waiting' OR NEW.status<>OLD.status OR OLD.external_action_id IS NOT NULL OR NEW.external_action_id IS NULL
   OR ROW(NEW.work_unit_id,NEW.agent_run_id,NEW.artifact_id) IS DISTINCT FROM ROW(OLD.work_unit_id,OLD.agent_run_id,OLD.artifact_id) THEN
   RAISE EXCEPTION 'PROCESS_EFFECT_PROPOSAL_DENIED' USING ERRCODE='EN418';END IF;
   SELECT * INTO person FROM org.memberships WHERE organization_id=r.organization_id AND id=app.current_membership_id()
   AND user_id=app.current_user_id() AND status='active' FOR SHARE NOWAIT;
   SELECT * INTO root FROM work.work_units WHERE organization_id=r.organization_id AND id=r.root_work_unit_id FOR SHARE NOWAIT;
   IF person.id IS NULL OR NOT knowledge.can_read_work(root.id,person.id) OR NOT (root.owner_membership_id=person.id OR person.role IN ('owner','admin'))
   THEN RAISE EXCEPTION 'PROCESS_EFFECT_PROPOSAL_DENIED' USING ERRCODE='EN418';END IF;
 ELSIF app.current_actor_type()='delegated' THEN
   -- 0406 independently binds the actual queued M4 run, version/publication, Work and starter.
   IF NEW.agent_run_id IS NULL OR OLD.agent_run_id IS NOT NULL OR NEW.status<>'waiting' OR choice->>'kind'<>'agent_task'
   OR r.started_by_membership_id IS DISTINCT FROM app.current_membership_id()
   OR ROW(NEW.work_unit_id,NEW.approval_id,NEW.external_action_id,NEW.artifact_id) IS DISTINCT FROM ROW(OLD.work_unit_id,OLD.approval_id,OLD.external_action_id,OLD.artifact_id)
   THEN RAISE EXCEPTION 'PROCESS_AGENT_BIND_DENIED' USING ERRCODE='EN418';END IF;
 ELSIF app.current_actor_type()<>'service' THEN RAISE EXCEPTION 'PROCESS_WORKER_REQUIRED' USING ERRCODE='EN418';END IF;
 IF NEW.status<>OLD.status AND NOT ((OLD.status='pending' AND NEW.status IN ('ready','waiting','failed','skipped'))
 OR (OLD.status='ready' AND NEW.status IN ('waiting','failed','skipped')) OR (OLD.status='waiting' AND NEW.status IN ('done','failed','skipped'))) THEN
 RAISE EXCEPTION 'PROCESS_STEP_TRANSITION_DENIED' USING ERRCODE='EN418';END IF;
 IF NEW.work_unit_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM studio.process_step_births b WHERE b.organization_id=r.organization_id
 AND b.run_id=r.id AND b.step_key=NEW.step_key AND b.work_unit_id=NEW.work_unit_id AND b.spec_sha256=s.spec_sha256
 AND b.started_by_membership_id=r.started_by_membership_id) THEN RAISE EXCEPTION 'PROCESS_STEP_BIRTH_REQUIRED' USING ERRCODE='EN418';END IF;
 IF NEW.status NOT IN ('pending','failed','skipped') AND NEW.work_unit_id IS NULL THEN RAISE EXCEPTION 'PROCESS_STEP_WORK_REQUIRED' USING ERRCODE='EN418';END IF;
 IF NEW.status NOT IN ('pending','failed','skipped') AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(choice->'after') before
 WHERE NOT coalesce(studio.process_step_proof(r.id,before),false)) THEN RAISE EXCEPTION 'PROCESS_PREREQUISITE_CHANGED' USING ERRCODE='EN418';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER process_steps_01_authority BEFORE INSERT OR UPDATE ON studio.process_run_steps FOR EACH ROW EXECUTE FUNCTION studio.guard_process_step();

--> statement-breakpoint
CREATE FUNCTION studio.complete_process_intent(p_run uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r studio.process_runs%ROWTYPE;x studio.process_run_steps%ROWTYPE;i studio.process_run_intents%ROWTYPE;
BEGIN
 SELECT * INTO r FROM studio.process_runs WHERE organization_id=app.current_organization_id() AND id=p_run;
 SELECT * INTO i FROM studio.process_run_intents WHERE organization_id=app.current_organization_id() AND run_id=p_run;
 IF r.id IS NULL OR i.run_id IS NULL OR NOT studio.process_requested(p_run) OR NOT coalesce(studio.process_inventory_complete(p_run),false)
 OR NOT EXISTS(SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id
 WHERE e.organization_id=r.organization_id AND e.event_type='work.created' AND e.aggregate_type='work_unit'
 AND e.aggregate_id=r.root_work_unit_id AND e.aggregate_version=1 AND e.actor_type='membership' AND e.actor_id=r.started_by_membership_id)
 THEN RAISE EXCEPTION 'PROCESS_INTENT_INCOMPLETE' USING ERRCODE='EN418';END IF;
 FOR x IN SELECT * FROM studio.process_run_steps WHERE organization_id=r.organization_id AND run_id=p_run ORDER BY step_key LOOP
   IF x.work_unit_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM studio.process_step_births b
   WHERE b.organization_id=r.organization_id AND b.run_id=p_run AND b.step_key=x.step_key AND b.work_unit_id=x.work_unit_id
   AND b.started_by_membership_id=r.started_by_membership_id AND b.spec_sha256=i.spec_sha256) THEN
   RAISE EXCEPTION 'PROCESS_STEP_BIRTH_REQUIRED' USING ERRCODE='EN418';END IF;
   IF r.status NOT IN ('failed','cancelled') AND x.status='done' AND NOT coalesce(studio.process_step_proof(p_run,x.step_key),false) THEN RAISE EXCEPTION 'PROCESS_STEP_PROOF_REQUIRED' USING ERRCODE='EN418';END IF;
   IF x.status='skipped' AND r.status NOT IN ('failed','cancelled') THEN RAISE EXCEPTION 'PROCESS_SKIP_NOT_TERMINAL' USING ERRCODE='EN418';END IF;
 END LOOP;
 IF r.status='completed' AND (NOT coalesce(studio.process_work_completed(r.root_work_unit_id),false)
 OR EXISTS(SELECT 1 FROM studio.process_run_steps WHERE organization_id=r.organization_id AND run_id=p_run AND status<>'done')) THEN
 RAISE EXCEPTION 'PROCESS_COMPLETION_PROOF_REQUIRED' USING ERRCODE='EN418';END IF;
 IF r.status IN ('completed','failed','cancelled') AND (r.finished_at IS NULL OR NOT EXISTS(
 SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id
 WHERE e.organization_id=r.organization_id AND e.event_type='process_run.finished' AND e.aggregate_type='process_run'
 AND e.aggregate_id=p_run AND e.aggregate_version=r.version AND e.actor_type='system'
 AND e.payload=jsonb_build_object('process_run_id',p_run,'status',r.status,'stop_code',r.stop_code))) THEN
 RAISE EXCEPTION 'PROCESS_FINISH_INTENT_REQUIRED' USING ERRCODE='EN418';END IF;
 IF r.stop_code='STOP_REQUESTED' AND r.status NOT IN ('completed','failed','cancelled') AND NOT EXISTS(
 SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id
 WHERE e.organization_id=r.organization_id AND e.event_type='process_run.stop_requested' AND e.aggregate_type='process_run'
 AND e.aggregate_id=p_run AND e.aggregate_version=r.version AND e.actor_type='membership'
 AND e.payload=jsonb_build_object('process_run_id',p_run)) THEN RAISE EXCEPTION 'PROCESS_STOP_INTENT_REQUIRED' USING ERRCODE='EN418';END IF;
END $$;
CREATE FUNCTION studio.complete_process_rows() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID='studio.process_runs'::regclass THEN
   PERFORM studio.complete_process_intent(NEW.id);
 ELSE PERFORM studio.complete_process_intent(NEW.run_id);END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER process_run_intent_complete AFTER INSERT OR UPDATE ON studio.process_runs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio.complete_process_rows();
CREATE CONSTRAINT TRIGGER process_step_intent_complete AFTER INSERT OR UPDATE ON studio.process_run_steps
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio.complete_process_rows();
CREATE FUNCTION studio.complete_process_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE root_intent studio.process_run_intents%ROWTYPE;step_birth studio.process_step_births%ROWTYPE;
BEGIN
 SELECT * INTO root_intent FROM studio.process_run_intents WHERE organization_id=NEW.organization_id AND root_work_unit_id=NEW.id;
 IF root_intent.run_id IS NOT NULL THEN PERFORM studio.complete_process_intent(root_intent.run_id);END IF;
 SELECT * INTO step_birth FROM studio.process_step_births WHERE organization_id=NEW.organization_id AND work_unit_id=NEW.id;
 IF step_birth.run_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM studio.process_run_steps x WHERE x.organization_id=NEW.organization_id AND x.run_id=step_birth.run_id
   AND x.step_key=step_birth.step_key AND x.work_unit_id=NEW.id) OR NOT EXISTS(
   SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id
   WHERE e.organization_id=NEW.organization_id AND e.event_type='work.created' AND e.aggregate_type='work_unit' AND e.aggregate_id=NEW.id
   AND e.aggregate_version=1 AND e.actor_type='membership' AND e.actor_id=step_birth.started_by_membership_id) THEN
   RAISE EXCEPTION 'PROCESS_STEP_BIRTH_UNBOUND' USING ERRCODE='EN418';END IF;
   PERFORM studio.complete_process_intent(step_birth.run_id);
 END IF;
 RETURN NULL;
END $$;
-- Queue under the actual app Work INSERT, not inside the security-definer mirror. On commit the
-- current tenant can verify reciprocal bindings without any migrator body-serving privilege.
CREATE CONSTRAINT TRIGGER process_work_birth_complete AFTER INSERT ON work.work_units
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio.complete_process_birth();
--> statement-breakpoint
-- Process Work is born with the ordinary kernel's no-criteria/manual confirmation contract. Do not
-- turn a raw completed status, fabricated transition or service flag into a person's confirmation.
CREATE FUNCTION studio.guard_process_work_completion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE linked boolean;root_run uuid;
BEGIN
 SELECT EXISTS(SELECT 1 FROM studio.process_run_intents WHERE organization_id=OLD.organization_id AND root_work_unit_id=OLD.id)
 OR EXISTS(SELECT 1 FROM studio.process_step_births WHERE organization_id=OLD.organization_id AND work_unit_id=OLD.id) INTO linked;
 IF NOT linked THEN RETURN NEW;END IF;
 IF NEW.completion_criteria IS DISTINCT FROM OLD.completion_criteria THEN RAISE EXCEPTION 'PROCESS_WORK_CRITERIA_FIXED' USING ERRCODE='EN418';END IF;
 IF NEW.status='completed' AND OLD.status<>'completed' THEN
   IF OLD.status<>'verifying' OR NEW.version<>OLD.version+1 OR NEW.completion_criteria<>'[]'::jsonb
   OR NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id OR app.current_membership_id() IS DISTINCT FROM OLD.owner_membership_id
   OR NOT studio.process_native_person_allowed() THEN RAISE EXCEPTION 'PROCESS_WORK_OWNER_CONFIRMATION_REQUIRED' USING ERRCODE='EN418';END IF;
   SELECT run_id INTO root_run FROM studio.process_run_intents WHERE organization_id=OLD.organization_id AND root_work_unit_id=OLD.id;
   IF root_run IS NOT NULL AND (NOT coalesce(studio.process_inventory_complete(root_run),false) OR EXISTS(SELECT 1 FROM studio.process_run_steps x
   WHERE x.organization_id=OLD.organization_id AND x.run_id=root_run AND NOT coalesce(studio.process_step_proof(root_run,x.step_key),false))) THEN
   RAISE EXCEPTION 'PROCESS_ROOT_STEPS_INCOMPLETE' USING ERRCODE='EN418';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER process_work_completion_guard BEFORE UPDATE ON work.work_units FOR EACH ROW EXECUTE FUNCTION studio.guard_process_work_completion();
CREATE FUNCTION studio.complete_process_work_confirmation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='completed' AND OLD.status<>'completed' AND (EXISTS(SELECT 1 FROM studio.process_run_intents
 WHERE organization_id=NEW.organization_id AND root_work_unit_id=NEW.id) OR EXISTS(SELECT 1 FROM studio.process_step_births
 WHERE organization_id=NEW.organization_id AND work_unit_id=NEW.id)) AND NOT coalesce(studio.process_work_completed(NEW.id),false) THEN
 RAISE EXCEPTION 'PROCESS_WORK_KERNEL_RECEIPT_REQUIRED' USING ERRCODE='EN418';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER process_work_confirmation_complete AFTER UPDATE ON work.work_units
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio.complete_process_work_confirmation();
REVOKE ALL ON FUNCTION studio.process_requested(uuid),studio.process_inventory_complete(uuid),studio.process_ancestors(uuid,text),
 studio.process_work_completed(uuid),studio.process_approval_valid(uuid,text,uuid),studio.process_external_valid(uuid,uuid),
 studio.process_artifact_valid(uuid,uuid,uuid),studio.process_step_proof(uuid,text),studio.complete_process_intent(uuid),
 studio.guard_process_run(),studio.guard_process_step(),studio.complete_process_rows(),studio.complete_process_birth(),
 studio.guard_process_work_completion(),studio.complete_process_work_confirmation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION studio.process_requested(uuid),studio.process_inventory_complete(uuid),studio.process_ancestors(uuid,text),
 studio.process_work_completed(uuid),studio.process_approval_valid(uuid,text,uuid),studio.process_external_valid(uuid,uuid),
 studio.process_artifact_valid(uuid,uuid,uuid),studio.process_step_proof(uuid,text),studio.complete_process_intent(uuid) TO ensemus_app;

--> statement-breakpoint
-- Apply actual root visibility before PostgreSQL's LIMIT, including direct application-role reads.
-- No recursion: can_read_work consults retained Work/project/client metadata, never Studio tables.
CREATE POLICY process_runs_root_read ON studio.process_runs AS RESTRICTIVE FOR SELECT TO ensemus_app
 USING(app.current_actor_type()='service' OR knowledge.can_read_work(root_work_unit_id,app.current_membership_id()));
CREATE POLICY process_runs_root_lock ON studio.process_runs AS RESTRICTIVE FOR UPDATE TO ensemus_app
 USING(app.current_actor_type()='service' OR knowledge.can_read_work(root_work_unit_id,app.current_membership_id()))
 WITH CHECK(app.current_actor_type()='service' OR knowledge.can_read_work(root_work_unit_id,app.current_membership_id()));
CREATE POLICY process_steps_root_read ON studio.process_run_steps AS RESTRICTIVE FOR SELECT TO ensemus_app
 USING(EXISTS(SELECT 1 FROM studio.process_runs r WHERE r.organization_id=process_run_steps.organization_id AND r.id=process_run_steps.run_id));
CREATE POLICY process_steps_root_lock ON studio.process_run_steps AS RESTRICTIVE FOR UPDATE TO ensemus_app
 USING(EXISTS(SELECT 1 FROM studio.process_runs r WHERE r.organization_id=process_run_steps.organization_id AND r.id=process_run_steps.run_id))
 WITH CHECK(EXISTS(SELECT 1 FROM studio.process_runs r WHERE r.organization_id=process_run_steps.organization_id AND r.id=process_run_steps.run_id));
CREATE POLICY process_specs_current_reader ON studio.process_specs AS RESTRICTIVE FOR SELECT TO ensemus_app
 USING((studio.current_author() AND (classification<>'restricted' OR published_by_membership_id=app.current_membership_id()))
 OR EXISTS(SELECT 1 FROM studio.process_runs r WHERE r.organization_id=process_specs.organization_id AND r.spec_id=process_specs.id));

--> statement-breakpoint
-- A genuine process approval is a real person's exact decision, not two service-written status rows.
-- Scope is only Work born for these runs; ordinary M2/M3 approvals keep their existing guards.
CREATE FUNCTION studio.guard_process_approval_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE approval work.approvals%ROWTYPE;subject_work uuid;
BEGIN
 IF TG_RELID='work.approvals'::regclass THEN subject_work:=NEW.work_unit_id;
 ELSE SELECT * INTO approval FROM work.approvals WHERE organization_id=NEW.organization_id AND id=NEW.approval_id;
 subject_work:=approval.work_unit_id;END IF;
 IF NOT EXISTS(SELECT 1 FROM studio.process_step_births b WHERE b.organization_id=NEW.organization_id AND b.work_unit_id=subject_work) THEN RETURN NEW;END IF;
 IF TG_RELID='work.approvals'::regclass THEN
   IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
     IF NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN RAISE EXCEPTION 'PROCESS_APPROVAL_DECISION_FIXED' USING ERRCODE='EN418';END IF;
     RETURN NEW;
   END IF;
   IF NEW.status NOT IN ('approved','denied') THEN RETURN NEW;END IF;
   IF OLD.status<>'pending' OR OLD.decided_at IS NOT NULL THEN RAISE EXCEPTION 'PROCESS_APPROVAL_DECISION_FIXED' USING ERRCODE='EN418';END IF;
   NEW.decided_at:=clock_timestamp();approval:=NEW;
 ELSE
   IF EXISTS(SELECT 1 FROM work.approval_decisions d WHERE d.organization_id=NEW.organization_id AND d.approval_id=NEW.approval_id)
   OR NEW.actor_membership_id IS DISTINCT FROM app.current_membership_id() OR NEW.action_hash IS DISTINCT FROM approval.action_hash
   OR (NEW.decision='approve' AND approval.status<>'approved') OR (NEW.decision='deny' AND approval.status<>'denied') THEN
   RAISE EXCEPTION 'PROCESS_APPROVAL_DECISION_MISMATCH' USING ERRCODE='EN418';END IF;
 END IF;
 IF approval.approver_membership_id IS DISTINCT FROM app.current_membership_id()
 OR approval.approver_membership_id IS NOT DISTINCT FROM approval.requested_by_membership_id
 OR NOT studio.process_native_person_allowed() OR NOT knowledge.can_read_work(subject_work,app.current_membership_id())
 OR approval.decided_at IS NULL OR approval.decided_at>=approval.expires_at OR approval.expires_at<=clock_timestamp() THEN
 RAISE EXCEPTION 'PROCESS_APPROVAL_PERSON_REQUIRED' USING ERRCODE='EN418';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER process_approval_person BEFORE UPDATE ON work.approvals FOR EACH ROW EXECUTE FUNCTION studio.guard_process_approval_decision();
CREATE TRIGGER process_approval_receipt_person BEFORE INSERT ON work.approval_decisions FOR EACH ROW EXECUTE FUNCTION studio.guard_process_approval_decision();
REVOKE ALL ON FUNCTION studio.guard_process_approval_decision() FROM PUBLIC;

--> statement-breakpoint
CREATE FUNCTION studio.guard_process_approval_request() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r studio.process_runs%ROWTYPE;s studio.process_specs%ROWTYPE;x studio.process_run_steps%ROWTYPE;choice jsonb;
BEGIN
 SELECT process.* INTO r FROM studio.process_step_births b JOIN studio.process_runs process
 ON process.organization_id=b.organization_id AND process.id=b.run_id WHERE b.organization_id=NEW.organization_id AND b.work_unit_id=NEW.work_unit_id;
 IF r.id IS NULL THEN RETURN NEW;END IF;
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.status<>'pending' OR NEW.decided_at IS NOT NULL
 OR NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id() OR NEW.requested_by_membership_id=NEW.approver_membership_id
 OR NOT studio.process_requested(r.id) OR r.status NOT IN ('running','waiting') OR r.stop_code='STOP_REQUESTED' THEN
 RAISE EXCEPTION 'PROCESS_APPROVAL_INTENT_REQUIRED' USING ERRCODE='EN418';END IF;
 IF NEW.tool_name='process.step_approval' THEN
   SELECT * INTO s FROM studio.process_specs WHERE organization_id=r.organization_id AND id=r.spec_id;
   SELECT * INTO x FROM studio.process_run_steps WHERE organization_id=r.organization_id AND run_id=r.id AND work_unit_id=NEW.work_unit_id;
   SELECT v INTO choice FROM jsonb_array_elements(s.spec->'steps') v WHERE v->>'key'=x.step_key;
   IF app.current_actor_type()<>'delegated' OR app.current_membership_id() IS DISTINCT FROM r.started_by_membership_id
   OR choice->>'kind' IS DISTINCT FROM 'human_approval'
   OR NEW.target_ref IS DISTINCT FROM 'process_run:'||r.id::text
   OR NEW.action IS DISTINCT FROM jsonb_build_object('toolName','process.step_approval','toolVersion','1','targetRef','process_run:'||r.id::text,
   'payload',jsonb_build_object('process_run_id',r.id,'step_key',x.step_key,'spec_sha256',s.spec_sha256))
   OR NEW.action_hash IS DISTINCT FROM encode(sha256(convert_to('{"payload":{"process_run_id":'||to_jsonb(r.id::text)::text||',"spec_sha256":'||to_jsonb(s.spec_sha256)::text||',"step_key":'||to_jsonb(x.step_key)::text||'},"targetRef":'||to_jsonb('process_run:'||r.id::text)::text||',"toolName":"process.step_approval","toolVersion":"1"}','UTF8')),'hex') THEN
   RAISE EXCEPTION 'PROCESS_APPROVAL_BINDING_REQUIRED' USING ERRCODE='EN418';END IF;
 ELSE
   IF NOT studio.process_native_person_allowed() OR NOT knowledge.can_read_work(NEW.work_unit_id,app.current_membership_id()) THEN
   RAISE EXCEPTION 'PROCESS_APPROVAL_PERSON_REQUIRED' USING ERRCODE='EN418';END IF;
 END IF;
 PERFORM 1 FROM org.memberships m WHERE m.organization_id=r.organization_id AND m.id=NEW.approver_membership_id AND m.status='active' FOR SHARE NOWAIT;
 IF NOT FOUND OR NOT knowledge.can_read_work(NEW.work_unit_id,NEW.approver_membership_id) THEN
 RAISE EXCEPTION 'PROCESS_APPROVER_UNAVAILABLE' USING ERRCODE='EN418';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER process_approval_request BEFORE INSERT ON work.approvals FOR EACH ROW EXECUTE FUNCTION studio.guard_process_approval_request();
REVOKE ALL ON FUNCTION studio.guard_process_approval_request() FROM PUBLIC;
