-- M7/M4/M3 composition: genuine references and an independently checked durable agent admission.
ALTER TABLE studio.agent_drafts ADD CONSTRAINT agent_drafts_definition_fk
  FOREIGN KEY(organization_id,agent_definition_id) REFERENCES ai.agent_definitions(organization_id,id);
ALTER TABLE studio.process_run_steps ADD CONSTRAINT process_step_agent_run_fk
  FOREIGN KEY(organization_id,agent_run_id) REFERENCES ai.agent_runs(organization_id,id);
ALTER TABLE studio.process_run_steps ADD CONSTRAINT process_step_external_action_fk
  FOREIGN KEY(organization_id,external_action_id) REFERENCES integrations.external_actions(organization_id,id);
--> statement-breakpoint
CREATE FUNCTION studio.guard_process_agent_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE process studio.process_runs%ROWTYPE; manifest studio.process_specs%ROWTYPE; chosen jsonb;
  selected_run ai.agent_runs%ROWTYPE; definition_key uuid; identity_key uuid; actor_role text; matches integer;
BEGIN
  IF TG_RELID<>'studio.process_run_steps'::regclass OR TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'PROCESS_BIND_TARGET_INVALID' USING ERRCODE='42501'; END IF;
  IF OLD.agent_run_id IS NOT NULL OR NEW.agent_run_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_type() IS DISTINCT FROM 'delegated' OR NEW.status<>'waiting'
    OR OLD.status NOT IN ('ready','waiting') OR NEW.work_unit_id IS NULL THEN
    RAISE EXCEPTION 'PROCESS_BIND_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  SELECT * INTO process FROM studio.process_runs WHERE organization_id=NEW.organization_id AND id=NEW.run_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR process.started_by_membership_id IS DISTINCT FROM app.current_membership_id()
    OR process.status NOT IN ('running','waiting') THEN
    RAISE EXCEPTION 'PROCESS_BIND_PARENT_CHANGED' USING ERRCODE='EN406'; END IF;
  SELECT role INTO actor_role FROM org.memberships WHERE organization_id=NEW.organization_id
    AND id=process.started_by_membership_id AND user_id=app.current_user_id() AND status='active' FOR SHARE NOWAIT;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'PROCESS_BIND_STARTER_CLOSED' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM work.work_units WHERE organization_id=NEW.organization_id AND id=process.root_work_unit_id
    AND status NOT IN ('completed','cancelled','failed')
    AND knowledge.can_read_work(id,app.current_membership_id()) FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESS_BIND_ROOT_CLOSED' USING ERRCODE='EN406'; END IF;
  PERFORM 1 FROM work.work_units WHERE organization_id=NEW.organization_id AND id=NEW.work_unit_id
    AND parent_id=process.root_work_unit_id AND status IN ('queued','ready','running')
    AND knowledge.can_read_work(id,app.current_membership_id()) FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESS_BIND_WORK_CLOSED' USING ERRCODE='EN406'; END IF;
  SELECT * INTO manifest FROM studio.process_specs WHERE organization_id=NEW.organization_id AND id=process.spec_id;
  IF NOT FOUND OR jsonb_typeof(manifest.spec->'steps') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'PROCESS_BIND_SPEC_INVALID' USING ERRCODE='EN406'; END IF;
  IF NOT EXISTS(SELECT 1 FROM work.work_units WHERE organization_id=NEW.organization_id
    AND id=process.root_work_unit_id AND classification=manifest.classification) THEN
    RAISE EXCEPTION 'PROCESS_BIND_CLASS_CHANGED' USING ERRCODE='EN406'; END IF;
  SELECT count(*),min(value::text)::jsonb INTO matches,chosen FROM jsonb_array_elements(manifest.spec->'steps')
    WHERE value->>'key'=NEW.step_key;
  IF matches<>1 OR chosen->>'kind' IS DISTINCT FROM 'agent_task' OR NOT coalesce(chosen->>'agentDefinitionId'
    ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',false) THEN
    RAISE EXCEPTION 'PROCESS_BIND_STEP_INVALID' USING ERRCODE='EN406'; END IF;
  SELECT * INTO selected_run FROM ai.agent_runs WHERE organization_id=NEW.organization_id AND id=NEW.agent_run_id FOR SHARE NOWAIT;
  IF NOT FOUND OR selected_run.work_unit_id IS DISTINCT FROM NEW.work_unit_id
    OR selected_run.initiator_membership_id IS DISTINCT FROM process.started_by_membership_id
    OR selected_run.parent_run_id IS NOT NULL OR selected_run.depth<>0 OR selected_run.status<>'queued' THEN
    RAISE EXCEPTION 'PROCESS_BIND_RUN_INVALID' USING ERRCODE='EN406'; END IF;
  SELECT d.id,d.service_identity_id INTO definition_key,identity_key FROM ai.agent_versions v JOIN ai.agent_definitions d
    ON d.organization_id=v.organization_id AND d.id=v.definition_id
    WHERE v.organization_id=NEW.organization_id AND v.id=selected_run.agent_version_id
      AND d.id=(chosen->>'agentDefinitionId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESS_BIND_DEFINITION_CHANGED' USING ERRCODE='EN406'; END IF;
  PERFORM 1 FROM org.service_identities WHERE organization_id=NEW.organization_id AND id=identity_key
    AND status='active' AND (expires_at IS NULL OR expires_at>now()) FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESS_BIND_IDENTITY_CLOSED' USING ERRCODE='EN406'; END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ensemus:agent-publication:'||NEW.organization_id::text||':'||definition_key::text,0)) THEN
    RAISE EXCEPTION 'PROCESS_PUBLICATION_BUSY' USING ERRCODE='55P03'; END IF;
  SELECT count(*) INTO matches FROM ai.agent_publications WHERE organization_id=NEW.organization_id AND definition_id=definition_key
    AND active_from<=now() AND (active_until IS NULL OR active_until>now());
  IF matches<>1 OR NOT EXISTS(SELECT 1 FROM ai.agent_publications WHERE organization_id=NEW.organization_id
    AND definition_id=definition_key AND version_id=selected_run.agent_version_id
    AND active_from<=now() AND (active_until IS NULL OR active_until>now())) THEN
    RAISE EXCEPTION 'PROCESS_BIND_PUBLICATION_CHANGED' USING ERRCODE='EN406'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION studio.guard_process_agent_binding() FROM PUBLIC;
CREATE TRIGGER process_steps_00_agent_binding BEFORE UPDATE OF agent_run_id ON studio.process_run_steps
  FOR EACH ROW EXECUTE FUNCTION studio.guard_process_agent_binding();
--> statement-breakpoint
-- A polymorphic publication receipt must name the actual same-hash immutable row in this tenant.
CREATE FUNCTION studio.guard_review_publication_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'studio.publish_reviews'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'REVIEW_REFERENCE_TARGET_INVALID' USING ERRCODE='42501'; END IF;
  IF NEW.published_ref IS NULL THEN RETURN NEW; END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.status<>'published'
    OR (NEW.subject_kind='agent_draft' AND NOT EXISTS(SELECT 1 FROM ai.agent_versions v
      WHERE v.organization_id=NEW.organization_id AND v.id=NEW.published_ref AND v.spec_sha256=NEW.subject_sha256))
    OR (NEW.subject_kind='process_draft' AND NOT EXISTS(SELECT 1 FROM studio.process_specs s
      WHERE s.organization_id=NEW.organization_id AND s.id=NEW.published_ref AND s.spec_sha256=NEW.subject_sha256))
    OR NEW.subject_kind NOT IN ('agent_draft','process_draft') THEN
    RAISE EXCEPTION 'REVIEW_PUBLICATION_REFERENCE_INVALID' USING ERRCODE='EN406'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION studio.guard_review_publication_reference() FROM PUBLIC;
CREATE TRIGGER publish_reviews_00_reference BEFORE INSERT OR UPDATE ON studio.publish_reviews
  FOR EACH ROW EXECUTE FUNCTION studio.guard_review_publication_reference();
