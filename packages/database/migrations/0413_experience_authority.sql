-- Source-only until the joined real-role gate. Legacy drafts without canonical bytes remain inert.
ALTER TABLE experience.outcome_drafts ADD COLUMN preview_canonical text;
ALTER TABLE experience.outcome_drafts ADD COLUMN authorized_work_version bigint;
GRANT UPDATE(preview_canonical,authorized_work_version) ON experience.outcome_drafts TO ensemus_app;
CREATE UNIQUE INDEX outcome_one_work ON experience.outcome_drafts(organization_id,work_unit_id)
 WHERE work_unit_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION experience.current_person(p_manage boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT app.current_actor_type()='user' AND EXISTS(SELECT 1 FROM org.memberships m
 WHERE m.organization_id=app.current_organization_id() AND m.id=app.current_membership_id()
 AND m.user_id=app.current_user_id() AND m.status='active'
 AND (NOT p_manage OR m.role IN ('owner','admin')))
$$;
CREATE FUNCTION experience.native_person_allowed(p_manage boolean DEFAULT false) RETURNS boolean
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE person org.memberships%ROWTYPE;enforcement text;
BEGIN
 IF current_user<>'ensemus_app' OR session_user<>'ensemus_app' OR NOT experience.current_person(p_manage) THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('interactive_policy:'||app.current_organization_id()::text,0));
 SELECT m.* INTO person FROM org.memberships m WHERE m.organization_id=app.current_organization_id()
 AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active' FOR SHARE;
 IF person.id IS NULL OR (p_manage AND person.role NOT IN ('owner','admin')) THEN RETURN false;END IF;
 SELECT p.sso_enforcement INTO enforcement FROM org.security_policies p WHERE p.organization_id=person.organization_id FOR SHARE;
 IF enforcement='required' AND person.role<>'owner'
 AND EXISTS(SELECT 1 FROM org.sso_connections c WHERE c.organization_id=person.organization_id AND c.state='active')
 AND NOT identity.lock_required_sso_effect(person.organization_id,person.id,person.user_id,app.current_interactive_session_id()) THEN
 RAISE EXCEPTION 'SSO_REQUIRED' USING ERRCODE='EN410';END IF;
 RETURN identity.lock_studio_session(person.user_id,app.current_interactive_session_id());
END $$;
REVOKE ALL ON FUNCTION experience.current_person(boolean),experience.native_person_allowed(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION experience.current_person(boolean),experience.native_person_allowed(boolean) TO ensemus_app;
CREATE POLICY outcome_author ON experience.outcome_drafts AS RESTRICTIVE TO ensemus_app
 USING(experience.current_person() AND created_by_membership_id=app.current_membership_id() AND preview_canonical IS NOT NULL)
 WITH CHECK(experience.current_person() AND created_by_membership_id=app.current_membership_id());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION experience.check_outcome_draft() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p jsonb;entry jsonb;owner_id uuid;dependency uuid;keys text[];
BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
 OR NEW.created_by_membership_id IS DISTINCT FROM app.current_membership_id()
 OR NOT experience.native_person_allowed() THEN RAISE EXCEPTION 'OUTCOME_PERSON_REQUIRED' USING ERRCODE='EN413';END IF;
 IF NEW.preview_canonical IS NULL OR octet_length(NEW.preview_canonical)>32768
 OR NEW.preview_canonical::jsonb IS DISTINCT FROM NEW.preview
 OR encode(sha256(convert_to(NEW.preview_canonical,'UTF8')),'hex') IS DISTINCT FROM NEW.preview_sha256
 OR NEW.preview_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'OUTCOME_PREVIEW_CHANGED' USING ERRCODE='EN413';END IF;
 p:=NEW.preview;
 SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(p) key;
 IF keys IS DISTINCT FROM ARRAY['classification','dataAccess','dependencyWorkUnitIds','dueAt','objective','ownerMembershipId','successCriteria','suggestedProcessKey','title','uncertainties']::text[]
 OR jsonb_typeof(p->'title')<>'string' OR length(btrim(p->>'title')) NOT BETWEEN 1 AND 200
 OR jsonb_typeof(p->'objective')<>'string' OR length(btrim(p->>'objective')) NOT BETWEEN 1 AND 2000
 OR NOT coalesce(p->>'classification' IN ('public','internal','confidential','restricted'),false)
 OR jsonb_typeof(p->'successCriteria')<>'array' OR jsonb_array_length(p->'successCriteria')>20
 OR jsonb_typeof(p->'dependencyWorkUnitIds')<>'array' OR jsonb_array_length(p->'dependencyWorkUnitIds')>20
 OR jsonb_typeof(p->'dataAccess')<>'object' OR jsonb_typeof(p->'uncertainties')<>'array'
 OR (p->'dueAt'<>'null'::jsonb AND (p->>'dueAt' !~ '^\d{4}-\d{2}-\d{2}$'
 OR to_char((p->>'dueAt')::date,'YYYY-MM-DD')<>p->>'dueAt')) THEN RAISE EXCEPTION 'OUTCOME_PREVIEW_INVALID' USING ERRCODE='EN413';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p->'successCriteria') LOOP
 IF jsonb_typeof(entry)<>'object' OR NOT coalesce(entry->>'kind' IN ('artifact_named','reviewer_approved','none'),false)
 OR jsonb_typeof(entry->'label')<>'string' OR length(btrim(entry->>'label')) NOT BETWEEN 1 AND 200
 OR (SELECT count(*) FROM jsonb_object_keys(entry))<>2 THEN RAISE EXCEPTION 'OUTCOME_CRITERION_INVALID' USING ERRCODE='EN413';END IF;
 END LOOP;
 owner_id:=(p->>'ownerMembershipId')::uuid;
 PERFORM 1 FROM org.memberships m WHERE m.organization_id=NEW.organization_id AND m.id=owner_id AND m.status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OUTCOME_OWNER_CHANGED' USING ERRCODE='EN413';END IF;
 IF TG_OP='INSERT' THEN
 IF NEW.status<>'draft' OR NEW.version<>1 OR NEW.work_unit_id IS NOT NULL OR NEW.authorized_at IS NOT NULL
 OR NEW.authorized_by_membership_id IS NOT NULL OR NEW.authorized_work_version IS NOT NULL THEN RAISE EXCEPTION 'OUTCOME_INVALID_START' USING ERRCODE='EN413';END IF;
 ELSE
 IF OLD.status<>'draft' OR NEW.version<>OLD.version+1 OR NEW.organization_id<>OLD.organization_id OR NEW.id<>OLD.id
 OR NEW.created_by_membership_id<>OLD.created_by_membership_id OR NEW.objective<>OLD.objective OR NEW.created_at<>OLD.created_at
 THEN RAISE EXCEPTION 'OUTCOME_IMMUTABLE' USING ERRCODE='EN413';END IF;
 IF NEW.status IN ('authorized','discarded') AND (NEW.preview IS DISTINCT FROM OLD.preview
 OR NEW.preview_canonical IS DISTINCT FROM OLD.preview_canonical OR NEW.preview_sha256 IS DISTINCT FROM OLD.preview_sha256)
 THEN RAISE EXCEPTION 'OUTCOME_CONFIRM_CHANGED' USING ERRCODE='EN413';END IF;
 END IF;
 IF NEW.status='authorized' THEN
 IF NEW.authorized_by_membership_id IS DISTINCT FROM app.current_membership_id() OR NEW.authorized_at IS NULL
 OR NEW.authorized_work_version IS NULL OR NEW.work_unit_id IS NULL THEN RAISE EXCEPTION 'OUTCOME_BINDING_REQUIRED' USING ERRCODE='EN413';END IF;
 ELSIF NEW.work_unit_id IS NOT NULL OR NEW.authorized_by_membership_id IS NOT NULL OR NEW.authorized_at IS NOT NULL
 OR NEW.authorized_work_version IS NOT NULL THEN RAISE EXCEPTION 'OUTCOME_NO_EFFECT' USING ERRCODE='EN413';END IF;
 RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
 RAISE EXCEPTION 'OUTCOME_PREVIEW_INVALID' USING ERRCODE='EN413';
END $$;
--> statement-breakpoint
CREATE TABLE experience.outcome_work_births(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),draft_id uuid NOT NULL,work_unit_id uuid NOT NULL,
 preview_version bigint NOT NULL CHECK(preview_version>0),preview_sha256 text NOT NULL CHECK(preview_sha256~'^[0-9a-f]{64}$'),
 created_by_membership_id uuid NOT NULL,birth_nonce uuid NOT NULL DEFAULT gen_random_uuid(),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,draft_id),UNIQUE(organization_id,work_unit_id),
 FOREIGN KEY(organization_id,draft_id) REFERENCES experience.outcome_drafts(organization_id,id),
 FOREIGN KEY(organization_id,work_unit_id) REFERENCES work.work_units(organization_id,id),
 FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES org.memberships(organization_id,id));
ALTER TABLE experience.outcome_work_births ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.outcome_work_births FORCE ROW LEVEL SECURITY;
CREATE POLICY birth_author_read ON experience.outcome_work_births FOR SELECT TO ensemus_app
 USING(organization_id=app.current_organization_id() AND experience.current_person() AND created_by_membership_id=app.current_membership_id());
CREATE POLICY birth_fixed_insert ON experience.outcome_work_births FOR INSERT TO ensemus_migrator
 WITH CHECK(session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND created_by_membership_id=app.current_membership_id() AND draft_id::text=current_setting('app.outcome_draft_id',true));
-- The fixed AFTER trigger reads only the current author's selected draft; it exposes no callable body port.
CREATE POLICY outcome_birth_mirror_read ON experience.outcome_drafts FOR SELECT TO ensemus_migrator
 USING(session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND created_by_membership_id=app.current_membership_id() AND id::text=current_setting('app.outcome_draft_id',true));
GRANT SELECT ON experience.outcome_work_births TO ensemus_app;
CREATE TRIGGER birth_receipt_immutable BEFORE UPDATE OR DELETE ON experience.outcome_work_births
 FOR EACH ROW EXECUTE FUNCTION app.reject_change();
CREATE FUNCTION experience.guard_outcome_work_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scope text;draft experience.outcome_drafts%ROWTYPE;objective text;criteria jsonb;
BEGIN
 scope:=nullif(current_setting('app.outcome_draft_id',true),'');IF scope IS NULL THEN RETURN NEW;END IF;
 IF NOT experience.native_person_allowed() THEN RAISE EXCEPTION 'OUTCOME_PERSON_REQUIRED' USING ERRCODE='EN413';END IF;
 SELECT d.* INTO draft FROM experience.outcome_drafts d WHERE d.organization_id=app.current_organization_id()
 AND d.id=scope::uuid AND d.created_by_membership_id=app.current_membership_id() AND d.status='draft' FOR SHARE;
 IF draft.id IS NULL OR draft.preview_canonical IS NULL OR draft.preview_canonical::jsonb IS DISTINCT FROM draft.preview
 OR encode(sha256(convert_to(draft.preview_canonical,'UTF8')),'hex') IS DISTINCT FROM draft.preview_sha256 THEN
 RAISE EXCEPTION 'OUTCOME_SOURCE_CHANGED' USING ERRCODE='EN413';END IF;
 PERFORM 1 FROM org.memberships m WHERE m.organization_id=draft.organization_id
 AND m.id=(draft.preview->>'ownerMembershipId')::uuid AND m.status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OUTCOME_OWNER_CHANGED' USING ERRCODE='EN413';END IF;
 objective:=draft.preview->>'objective';
 IF jsonb_array_length(draft.preview->'successCriteria')>0 THEN
 SELECT objective||E'\n\nSuccess requirements (checked by a person):\n'||string_agg('- '||(c->>'label')||
 CASE WHEN c->>'kind'='artifact_named' THEN ' [File attached; a person checks the requested name and content]' ELSE '' END,E'\n' ORDER BY n)
 INTO objective FROM jsonb_array_elements(draft.preview->'successCriteria') WITH ORDINALITY e(c,n);END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind) ORDER BY kind),'[]'::jsonb) INTO criteria FROM(
 SELECT DISTINCT CASE c->>'kind' WHEN 'artifact_named' THEN 'artifact_exists' WHEN 'reviewer_approved' THEN 'reviewer_approved' END kind
 FROM jsonb_array_elements(draft.preview->'successCriteria') c WHERE c->>'kind'<>'none') k;
 IF NEW.organization_id IS DISTINCT FROM draft.organization_id OR NEW.created_by_membership_id IS DISTINCT FROM draft.created_by_membership_id
 OR NEW.owner_membership_id IS DISTINCT FROM (draft.preview->>'ownerMembershipId')::uuid OR NEW.title IS DISTINCT FROM draft.preview->>'title'
 OR NEW.objective IS DISTINCT FROM objective OR NEW.classification IS DISTINCT FROM draft.preview->>'classification'
 OR NEW.due_at IS DISTINCT FROM (CASE WHEN draft.preview->'dueAt'='null'::jsonb THEN NULL ELSE (draft.preview->>'dueAt')::date::timestamp AT TIME ZONE 'UTC' END)
 OR NEW.completion_criteria IS DISTINCT FROM criteria OR NEW.version<>1 OR NEW.status<>'queued'
 OR NEW.project_id IS NOT NULL OR NEW.parent_id IS NOT NULL OR NEW.execution_plan IS NOT NULL
 OR NEW.run_requested_at IS NOT NULL OR NEW.run_id IS NOT NULL THEN RAISE EXCEPTION 'OUTCOME_BIRTH_MISMATCH' USING ERRCODE='EN413';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outcome_work_birth_guard BEFORE INSERT ON work.work_units
 FOR EACH ROW EXECUTE FUNCTION experience.guard_outcome_work_birth();
CREATE FUNCTION experience.record_outcome_work_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope text;draft experience.outcome_drafts%ROWTYPE;
BEGIN
 scope:=nullif(current_setting('app.outcome_draft_id',true),'');IF scope IS NULL THEN RETURN NEW;END IF;
 -- The fixed invoker BEFORE trigger already locked and verified the native author and exact new body.
 IF session_user<>'ensemus_app' OR app.current_actor_type()<>'user' OR NEW.organization_id<>app.current_organization_id()
 OR NEW.created_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN RAISE EXCEPTION 'OUTCOME_BIRTH_DENIED' USING ERRCODE='EN413';END IF;
 SELECT d.* INTO draft FROM experience.outcome_drafts d WHERE d.organization_id=NEW.organization_id AND d.id=scope::uuid
 AND d.created_by_membership_id=app.current_membership_id() AND d.status='draft';
 IF draft.id IS NULL THEN RAISE EXCEPTION 'OUTCOME_SOURCE_CHANGED' USING ERRCODE='EN413';END IF;
 INSERT INTO experience.outcome_work_births(organization_id,draft_id,work_unit_id,preview_version,preview_sha256,created_by_membership_id)
 VALUES(NEW.organization_id,draft.id,NEW.id,draft.version,draft.preview_sha256,draft.created_by_membership_id);
 RETURN NEW;
END $$;
CREATE TRIGGER outcome_work_birth_record AFTER INSERT ON work.work_units
 FOR EACH ROW EXECUTE FUNCTION experience.record_outcome_work_birth();
REVOKE ALL ON FUNCTION experience.guard_outcome_work_birth(),experience.record_outcome_work_birth() FROM PUBLIC;
CREATE FUNCTION experience.complete_outcome_birth_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM experience.outcome_drafts d WHERE d.organization_id=NEW.organization_id AND d.id=NEW.draft_id
 AND d.status='authorized' AND d.work_unit_id=NEW.work_unit_id AND d.preview_sha256=NEW.preview_sha256
 AND d.version=NEW.preview_version+1 AND d.created_by_membership_id=NEW.created_by_membership_id) THEN
 RAISE EXCEPTION 'OUTCOME_BIRTH_INTENT_INCOMPLETE' USING ERRCODE='EN413';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER outcome_birth_intent_complete AFTER INSERT ON experience.outcome_work_births
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION experience.complete_outcome_birth_intent();
REVOKE ALL ON FUNCTION experience.complete_outcome_birth_intent() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION experience.complete_outcome_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actual work.work_units%ROWTYPE;expected_objective text;expected_criteria jsonb;expected_dependencies uuid[];actual_dependencies uuid[];dependency uuid;
BEGIN
 IF NEW.status<>'authorized' THEN RETURN NULL;END IF;
 SELECT coalesce(array_agg(value::uuid ORDER BY value::uuid),ARRAY[]::uuid[]) INTO expected_dependencies
 FROM jsonb_array_elements_text(NEW.preview->'dependencyWorkUnitIds');
 IF cardinality(expected_dependencies)<>(SELECT count(DISTINCT id) FROM unnest(expected_dependencies) id) THEN
 RAISE EXCEPTION 'OUTCOME_DEPENDENCY_INVALID' USING ERRCODE='EN413';END IF;
 FOREACH dependency IN ARRAY expected_dependencies LOOP
 IF NOT knowledge.lock_structured_record('work_unit',dependency) OR NOT knowledge.can_read_work(dependency,NEW.created_by_membership_id)
 THEN RAISE EXCEPTION 'OUTCOME_DEPENDENCY_CHANGED' USING ERRCODE='EN413';END IF;
 END LOOP;
 SELECT w.* INTO actual FROM work.work_units w WHERE w.organization_id=NEW.organization_id AND w.id=NEW.work_unit_id FOR SHARE;
 expected_objective:=NEW.preview->>'objective';
 IF jsonb_array_length(NEW.preview->'successCriteria')>0 THEN
 SELECT expected_objective||E'\n\nSuccess requirements (checked by a person):\n'||string_agg('- '||(c->>'label')||
 CASE WHEN c->>'kind'='artifact_named' THEN ' [File attached; a person checks the requested name and content]' ELSE '' END,E'\n' ORDER BY n)
 INTO expected_objective FROM jsonb_array_elements(NEW.preview->'successCriteria') WITH ORDINALITY e(c,n);END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind) ORDER BY kind),'[]'::jsonb) INTO expected_criteria FROM(
 SELECT DISTINCT CASE c->>'kind' WHEN 'artifact_named' THEN 'artifact_exists' WHEN 'reviewer_approved' THEN 'reviewer_approved' END kind
 FROM jsonb_array_elements(NEW.preview->'successCriteria') c WHERE c->>'kind'<>'none') k;
 SELECT coalesce(array_agg(d.prerequisite_id ORDER BY d.prerequisite_id),ARRAY[]::uuid[]) INTO actual_dependencies
 FROM work.work_dependencies d WHERE d.organization_id=NEW.organization_id AND d.dependent_id=NEW.work_unit_id;
 IF actual.id IS NULL OR NOT EXISTS(SELECT 1 FROM experience.outcome_work_births b WHERE b.organization_id=NEW.organization_id
 AND b.draft_id=NEW.id AND b.work_unit_id=NEW.work_unit_id AND b.preview_version=NEW.version-1
 AND b.preview_sha256=NEW.preview_sha256 AND b.created_by_membership_id=NEW.created_by_membership_id)
 OR actual.version<>NEW.authorized_work_version OR actual.status<>'queued'
 OR actual.created_by_membership_id IS DISTINCT FROM NEW.created_by_membership_id
 OR actual.title IS DISTINCT FROM NEW.preview->>'title' OR actual.objective IS DISTINCT FROM expected_objective
 OR actual.owner_membership_id IS DISTINCT FROM (NEW.preview->>'ownerMembershipId')::uuid
 OR actual.classification IS DISTINCT FROM NEW.preview->>'classification'
 OR actual.due_at IS DISTINCT FROM (CASE WHEN NEW.preview->'dueAt'='null'::jsonb THEN NULL ELSE (NEW.preview->>'dueAt')::date::timestamp AT TIME ZONE 'UTC' END)
 OR actual.completion_criteria IS DISTINCT FROM expected_criteria OR actual_dependencies IS DISTINCT FROM expected_dependencies
 OR actual.execution_plan IS NOT NULL OR actual.run_requested_at IS NOT NULL OR actual.run_id IS NOT NULL
 OR actual.parent_id IS NOT NULL OR actual.project_id IS NOT NULL THEN RAISE EXCEPTION 'OUTCOME_WORK_MISMATCH' USING ERRCODE='EN413';END IF;
 IF NOT EXISTS(SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id
 WHERE e.organization_id=NEW.organization_id AND e.event_type='work.created' AND e.aggregate_type='work_unit'
 AND e.aggregate_id=actual.id AND e.actor_type='membership' AND e.actor_id=NEW.created_by_membership_id AND e.aggregate_version=1)
 OR NOT EXISTS(SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id
 WHERE e.organization_id=NEW.organization_id AND e.event_type='outcome.authorized' AND e.aggregate_type='outcome_draft'
 AND e.aggregate_id=NEW.id AND e.actor_type='membership' AND e.actor_id=NEW.created_by_membership_id
 AND e.aggregate_version=NEW.version AND e.payload=jsonb_build_object('draft_id',NEW.id,'work_unit_id',actual.id))
 THEN RAISE EXCEPTION 'OUTCOME_INTENT_INCOMPLETE' USING ERRCODE='EN413';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER outcome_binding_complete AFTER UPDATE ON experience.outcome_drafts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION experience.complete_outcome_binding();
REVOKE ALL ON FUNCTION experience.complete_outcome_binding() FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY setup_person ON experience.onboarding_steps AS RESTRICTIVE TO ensemus_app
 USING(experience.current_person(true)) WITH CHECK(experience.current_person(true));
CREATE FUNCTION experience.guard_setup_choice() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NOT experience.native_person_allowed(true)
 OR NEW.decided_by_membership_id IS DISTINCT FROM app.current_membership_id()
 OR NOT ((NEW.step_key='responsibility_statement' AND NEW.status='acknowledged')
 OR (NEW.step_key IN ('first_knowledge_source','model_provider') AND NEW.status='skipped'))
 OR (TG_OP='UPDATE' AND (NEW.organization_id<>OLD.organization_id OR NEW.step_key<>OLD.step_key)) THEN
 RAISE EXCEPTION 'SETUP_DECISION_REQUIRED' USING ERRCODE='EN413';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ensemus:company-onboarding:'||NEW.organization_id::text,0));
 NEW.decided_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER setup_choice_authority BEFORE INSERT OR UPDATE ON experience.onboarding_steps
 FOR EACH ROW EXECUTE FUNCTION experience.guard_setup_choice();
REVOKE ALL ON FUNCTION experience.guard_setup_choice() FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE experience.onboarding_completions(
 organization_id uuid PRIMARY KEY REFERENCES org.organizations(id),version integer NOT NULL DEFAULT 1 CHECK(version=1),
 completed_by_membership_id uuid NOT NULL,first_simulation_id uuid NOT NULL,
 first_simulation_sha256 text NOT NULL CHECK(first_simulation_sha256~'^[0-9a-f]{64}$'),completed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,completed_by_membership_id) REFERENCES org.memberships(organization_id,id),
 FOREIGN KEY(organization_id,first_simulation_id) REFERENCES studio.simulation_runs(organization_id,id));
ALTER TABLE experience.onboarding_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.onboarding_completions FORCE ROW LEVEL SECURITY;
CREATE POLICY completion_tenant ON experience.onboarding_completions TO ensemus_app
 USING(organization_id=app.current_organization_id() AND experience.current_person(true))
 WITH CHECK(organization_id=app.current_organization_id() AND experience.current_person(true));
GRANT SELECT,INSERT ON experience.onboarding_completions TO ensemus_app;
CREATE TRIGGER completion_immutable BEFORE UPDATE OR DELETE ON experience.onboarding_completions
 FOR EACH ROW EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
-- Exact compiler output for bundled client-status-update v1. A source unit compares these bytes with
-- the real module/compiler; a catalog change requires a new migration rather than blessing stale runs.
CREATE FUNCTION experience.first_setup_spec() RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT '{"classification":"internal","schemaVersion":1,"steps":[{"after":["send_update"],"evidence":"external_receipt","key":"confirm_sent","kind":"evidence_check","label":"Confirm it was sent","labelCode":null},{"after":["gather_evidence"],"key":"draft_update","kind":"work_item","label":"Draft the update","labelCode":null},{"after":[],"key":"gather_evidence","kind":"work_item","label":"Gather the evidence","labelCode":null},{"after":["draft_update"],"approverRole":"process_owner","key":"review_update","kind":"human_approval","label":"Review the update","labelCode":null},{"after":["review_update"],"key":"send_update","kind":"external_action","label":"Send the update","labelCode":null,"toolId":"email.send"}]}'::text
$$;
CREATE FUNCTION experience.guard_setup_completion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE witness uuid;other_member uuid;structure uuid;simulation studio.simulation_runs%ROWTYPE;snapshot studio.simulation_inputs%ROWTYPE;
BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.version<>1
 OR NEW.completed_by_membership_id IS DISTINCT FROM app.current_membership_id()
 OR NOT experience.native_person_allowed(true) THEN RAISE EXCEPTION 'SETUP_PERSON_REQUIRED' USING ERRCODE='EN413';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ensemus:company-onboarding:'||NEW.organization_id::text,0));
 PERFORM 1 FROM experience.onboarding_steps c WHERE c.organization_id=NEW.organization_id AND c.step_key='responsibility_statement' AND c.status='acknowledged';
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM identity.users u WHERE u.id=app.current_user_id() AND u.two_factor_enabled)
 THEN RAISE EXCEPTION 'SETUP_REQUIRED_FACTS_MISSING' USING ERRCODE='EN413';END IF;
 SELECT m.id INTO other_member FROM org.memberships m WHERE m.organization_id=NEW.organization_id
 AND m.id<>app.current_membership_id() AND m.status='active' ORDER BY m.id LIMIT 1 FOR SHARE;
 IF other_member IS NULL THEN
 PERFORM 1 FROM org.invitations i WHERE i.organization_id=NEW.organization_id AND i.accepted_at IS NULL
 AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp() ORDER BY i.id LIMIT 1 FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SETUP_INVITE_REQUIRED' USING ERRCODE='EN413';END IF;END IF;
 SELECT t.id INTO structure FROM org.teams t WHERE t.organization_id=NEW.organization_id ORDER BY t.id LIMIT 1 FOR SHARE;
 IF structure IS NULL THEN
 SELECT p.id INTO structure FROM work.projects p WHERE p.organization_id=NEW.organization_id ORDER BY p.id LIMIT 1;
 IF structure IS NULL OR NOT knowledge.lock_structured_record('project',structure)
 OR NOT knowledge.structured_record_readable('project',structure,app.current_membership_id()) THEN
 RAISE EXCEPTION 'SETUP_STRUCTURE_REQUIRED' USING ERRCODE='EN413';END IF;END IF;
 SELECT w.id INTO witness FROM work.work_units w WHERE w.organization_id=NEW.organization_id
 AND knowledge.can_read_work(w.id,app.current_membership_id()) ORDER BY w.id LIMIT 1;
 IF witness IS NULL OR NOT knowledge.lock_structured_record('work_unit',witness)
 OR NOT knowledge.can_read_work(witness,app.current_membership_id()) THEN RAISE EXCEPTION 'SETUP_WORK_REQUIRED' USING ERRCODE='EN413';END IF;
 SELECT s.* INTO simulation FROM studio.simulation_runs s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.first_simulation_id FOR SHARE;
 SELECT i.* INTO snapshot FROM studio.simulation_inputs i WHERE i.organization_id=NEW.organization_id AND i.simulation_run_id=NEW.first_simulation_id;
 IF simulation.id IS NULL OR snapshot.simulation_run_id IS NULL OR simulation.subject_kind<>'bundled_workflow'
 OR simulation.subject_key<>'client-status-update' OR simulation.scenario_key<>'standard' OR simulation.status<>'passed'
 OR snapshot.source_version<>1 OR snapshot.policy_version<>'bundled-v1' OR snapshot.spec_canonical<>experience.first_setup_spec()
 OR NEW.first_simulation_sha256<>encode(sha256(convert_to(experience.first_setup_spec(),'UTF8')),'hex')
 OR simulation.subject_sha256<>NEW.first_simulation_sha256 OR simulation.report IS NULL OR simulation.report->>'outcome' IS DISTINCT FROM 'passed'
 OR simulation.report->>'subjectSha256' IS DISTINCT FROM NEW.first_simulation_sha256 OR simulation.report_sha256 IS NULL
 OR simulation.id IS DISTINCT FROM (SELECT s.id FROM studio.simulation_runs s JOIN studio.simulation_inputs i
 ON i.organization_id=s.organization_id AND i.simulation_run_id=s.id WHERE s.organization_id=NEW.organization_id
 AND s.subject_kind='bundled_workflow' AND s.subject_key='client-status-update' AND s.scenario_key='standard'
 AND s.subject_sha256=NEW.first_simulation_sha256 AND i.source_version=1 AND i.policy_version='bundled-v1'
 AND i.spec_canonical=experience.first_setup_spec() ORDER BY s.created_at DESC,s.id DESC LIMIT 1)
 THEN RAISE EXCEPTION 'SETUP_SIMULATION_REQUIRED' USING ERRCODE='EN413';END IF;
 NEW.completed_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER setup_completion_authority BEFORE INSERT ON experience.onboarding_completions
 FOR EACH ROW EXECUTE FUNCTION experience.guard_setup_completion();
CREATE FUNCTION experience.complete_setup_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o ON o.organization_id=e.organization_id AND o.event_id=e.id
 WHERE e.organization_id=NEW.organization_id AND e.event_type='onboarding.finished' AND e.aggregate_type='company_onboarding'
 AND e.aggregate_id=NEW.organization_id AND e.aggregate_version=1 AND e.actor_type='membership'
 AND e.actor_id=NEW.completed_by_membership_id AND e.payload=jsonb_build_object('simulation_id',NEW.first_simulation_id)) THEN
 RAISE EXCEPTION 'SETUP_EVENT_REQUIRED' USING ERRCODE='EN413';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER setup_completion_event AFTER INSERT ON experience.onboarding_completions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION experience.complete_setup_event();
REVOKE ALL ON FUNCTION experience.first_setup_spec(),experience.guard_setup_completion(),experience.complete_setup_event() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION experience.first_setup_spec() TO ensemus_app;
