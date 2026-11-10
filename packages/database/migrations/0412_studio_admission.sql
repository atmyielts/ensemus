-- Studio snapshots are private durable inputs, never imported execution or a claim about a real model.
ALTER TABLE studio.agent_drafts ADD COLUMN compiled_spec jsonb,ADD COLUMN compiled_spec_canonical text,
  ADD COLUMN compile_policy_version text;
ALTER TABLE studio.agent_drafts ADD CONSTRAINT agent_drafts_compilation CHECK(
  (compiled_spec IS NULL AND compiled_spec_canonical IS NULL AND compile_policy_version IS NULL)
  OR (compiled_spec IS NOT NULL AND compiled_spec_canonical IS NOT NULL AND compile_policy_version IS NOT NULL
    AND spec_sha256 IS NOT NULL AND length(compile_policy_version) BETWEEN 1 AND 128
    AND octet_length(compiled_spec_canonical) BETWEEN 2 AND 262144
    AND compiled_spec_canonical::jsonb=compiled_spec
    AND spec_sha256=encode(sha256(convert_to(compiled_spec_canonical,'UTF8')),'hex')));
-- Legacy draft hashes remain historical. A real save supplies the exact compilation before simulation.
GRANT UPDATE(compiled_spec,compiled_spec_canonical,compile_policy_version) ON studio.agent_drafts TO ensemus_app;
ALTER TABLE studio.publish_reviews ADD COLUMN subject_owner_membership_id uuid,ADD COLUMN subject_name text,
  ADD CONSTRAINT publish_reviews_subject_owner_fk FOREIGN KEY(organization_id,subject_owner_membership_id)
    REFERENCES org.memberships(organization_id,id);
CREATE TABLE studio.simulation_inputs(
  organization_id uuid NOT NULL,simulation_run_id uuid NOT NULL,source_version bigint NOT NULL,
  spec_canonical text NOT NULL,policy_version text NOT NULL,requested_by_membership_id uuid NOT NULL,
  requested_session_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simulation_inputs_pk PRIMARY KEY(organization_id,simulation_run_id),
  CONSTRAINT simulation_inputs_run_fk FOREIGN KEY(organization_id,simulation_run_id) REFERENCES studio.simulation_runs(organization_id,id),
  CONSTRAINT simulation_inputs_requester_fk FOREIGN KEY(organization_id,requested_by_membership_id) REFERENCES org.memberships(organization_id,id),
  CONSTRAINT simulation_inputs_bounded CHECK(source_version>0 AND octet_length(spec_canonical) BETWEEN 2 AND 262144)
);
ALTER TABLE studio.simulation_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.simulation_inputs FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON studio.simulation_inputs TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION studio.current_author() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT app.current_actor_type()='user' AND EXISTS(SELECT 1 FROM org.memberships m
   WHERE m.organization_id=app.current_organization_id() AND m.id=app.current_membership_id()
     AND m.user_id=app.current_user_id() AND m.status='active' AND m.role IN ('owner','admin'))
$$;
REVOKE ALL ON FUNCTION studio.current_author() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION studio.current_author() TO ensemus_app;

-- Definition instructions have at least internal protection. This is not a company-data grant:
-- the portable reader separately rechecks every selected source's actual class and current ACL.
-- Unknown legacy/malformed answers cannot be inferred to be exportable.
CREATE FUNCTION studio.agent_draft_class(p_answers jsonb) RETURNS text LANGUAGE sql IMMUTABLE
 SET search_path=pg_catalog AS $$
 SELECT CASE WHEN jsonb_typeof(p_answers->'dataClasses') IS DISTINCT FROM 'array' THEN 'restricted'
   WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(p_answers->'dataClasses') v
     WHERE jsonb_typeof(v)<>'string' OR (v#>>'{}') NOT IN ('public','internal','confidential')) THEN 'restricted'
   WHEN (p_answers->'dataClasses') ? 'confidential' THEN 'confidential' ELSE 'internal' END
$$;
REVOKE ALL ON FUNCTION studio.agent_draft_class(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION studio.agent_draft_class(jsonb) TO ensemus_app;

-- This is a session check, deliberately independent of MFA. Reuse the exact auth-metadata lock
-- visibility from0404; no account, token, factor secret or session body grant is added to the app.
CREATE FUNCTION identity.lock_studio_session(p_user uuid,p_session uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior_active text;prior_user text;prior_session text;person uuid;expires timestamptz;allowed boolean;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'user'
   OR p_user IS NULL OR p_user IS DISTINCT FROM app.current_user_id()
   OR p_session IS NULL OR p_session IS DISTINCT FROM app.current_interactive_session_id() THEN RETURN false;END IF;
 prior_active:=current_setting('identity.mfa_guard_active',true);prior_user:=current_setting('identity.mfa_guard_user',true);
 prior_session:=current_setting('identity.mfa_guard_session',true);
 PERFORM set_config('identity.mfa_guard_active','v1',true),set_config('identity.mfa_guard_user',p_user::text,true),
   set_config('identity.mfa_guard_session',p_session::text,true);
 BEGIN
   SELECT u.id INTO person FROM identity.users u WHERE u.id=p_user FOR SHARE;
   SELECT s.expires_at INTO expires FROM identity.sessions s WHERE s.id=p_session AND s.user_id=p_user FOR SHARE;
   allowed:=coalesce(person IS NOT NULL AND expires>clock_timestamp(),false);
 EXCEPTION WHEN OTHERS THEN
   PERFORM set_config('identity.mfa_guard_active',coalesce(prior_active,''),true),set_config('identity.mfa_guard_user',coalesce(prior_user,''),true),
     set_config('identity.mfa_guard_session',coalesce(prior_session,''),true);RAISE;
 END;
 PERFORM set_config('identity.mfa_guard_active',coalesce(prior_active,''),true),set_config('identity.mfa_guard_user',coalesce(prior_user,''),true),
   set_config('identity.mfa_guard_session',coalesce(prior_session,''),true);
 RETURN allowed;
END $$;
REVOKE ALL ON FUNCTION identity.lock_studio_session(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.lock_studio_session(uuid,uuid) TO ensemus_app;

CREATE FUNCTION studio.author_allowed() RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE person org.memberships%ROWTYPE;enforcement text;
BEGIN
 IF current_user<>'ensemus_app' OR session_user<>'ensemus_app' OR NOT studio.current_author() THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('interactive_policy:'||app.current_organization_id()::text,0));
 SELECT m.* INTO person FROM org.memberships m WHERE m.organization_id=app.current_organization_id()
   AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active' FOR SHARE;
 IF person.id IS NULL OR person.role NOT IN ('owner','admin') THEN RETURN false;END IF;
 SELECT p.sso_enforcement INTO enforcement FROM org.security_policies p WHERE p.organization_id=person.organization_id FOR SHARE;
 -- Keep0410's provider-before-session lock order for required SSO, and its documented owner recovery.
 IF enforcement='required' AND person.role<>'owner'
   AND EXISTS(SELECT 1 FROM org.sso_connections c WHERE c.organization_id=person.organization_id AND c.state='active')
   AND NOT identity.lock_required_sso_effect(person.organization_id,person.id,person.user_id,app.current_interactive_session_id()) THEN
   RAISE EXCEPTION 'SSO_REQUIRED' USING ERRCODE='EN410';END IF;
 RETURN identity.lock_studio_session(person.user_id,app.current_interactive_session_id());
END $$;
REVOKE ALL ON FUNCTION studio.author_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION studio.author_allowed() TO ensemus_app;
--> statement-breakpoint
CREATE POLICY agent_drafts_person ON studio.agent_drafts AS RESTRICTIVE TO ensemus_app
 USING(studio.current_author()) WITH CHECK(studio.current_author());
CREATE POLICY process_drafts_person ON studio.process_drafts AS RESTRICTIVE TO ensemus_app
 USING(studio.current_author() AND (classification<>'restricted' OR owner_membership_id=app.current_membership_id()))
 WITH CHECK(studio.current_author() AND (classification<>'restricted' OR owner_membership_id=app.current_membership_id()));

CREATE FUNCTION studio.simulation_readable(p_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM studio.simulation_runs s WHERE s.organization_id=app.current_organization_id() AND s.id=p_id)
$$;
REVOKE ALL ON FUNCTION studio.simulation_readable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION studio.simulation_readable(uuid) TO ensemus_app;
CREATE POLICY simulation_inputs_tenant ON studio.simulation_inputs TO ensemus_app
 USING(organization_id=app.current_organization_id() AND studio.simulation_readable(simulation_run_id))
 WITH CHECK(organization_id=app.current_organization_id() AND studio.current_author());

-- A service can read only the exact immutable simulation intent with an actual request/outbox pair.
CREATE FUNCTION studio.simulation_worker(p_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT app.current_actor_type()='service' AND current_setting('app.studio_simulation_id',true)=p_id::text
 AND EXISTS(SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o
   ON o.organization_id=e.organization_id AND o.event_id=e.id JOIN org.memberships m
   ON m.organization_id=e.organization_id AND m.id=e.actor_id AND m.status='active' AND m.role IN ('owner','admin')
   WHERE e.organization_id=app.current_organization_id() AND e.aggregate_type='simulation_run' AND e.aggregate_id=p_id
     AND e.event_type='simulation.requested' AND e.actor_type='membership')
$$;
REVOKE ALL ON FUNCTION studio.simulation_worker(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION studio.simulation_worker(uuid) TO ensemus_app;
CREATE POLICY simulations_person_or_intent ON studio.simulation_runs AS RESTRICTIVE TO ensemus_app
 USING((studio.current_author() AND (subject_kind<>'process_draft' OR EXISTS(SELECT 1 FROM studio.process_drafts d
   WHERE d.organization_id=simulation_runs.organization_id AND d.id=simulation_runs.subject_id))) OR studio.simulation_worker(id))
 WITH CHECK(studio.current_author() OR studio.simulation_worker(id));
--> statement-breakpoint
CREATE FUNCTION studio.guard_draft_author() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NOT studio.author_allowed() THEN
   RAISE EXCEPTION 'STUDIO_AUTHOR_REQUIRED' USING ERRCODE='EN412';END IF;
 IF (TG_OP='INSERT' AND NEW.status<>'editing') THEN
   RAISE EXCEPTION 'DRAFT_INVALID_START' USING ERRCODE='EN412';END IF;
 IF TG_OP='UPDATE' AND NEW.status='published' AND (OLD.status<>'published'
   OR NEW.name IS DISTINCT FROM OLD.name OR NEW.spec_sha256 IS DISTINCT FROM OLD.spec_sha256) THEN
   IF NOT app.interactive_privilege_allowed('studio.publish') OR NOT EXISTS(SELECT 1 FROM studio.publish_reviews r
     WHERE r.organization_id=NEW.organization_id AND r.subject_id=NEW.id AND r.subject_sha256=NEW.spec_sha256
       AND r.subject_kind=CASE TG_RELID WHEN 'studio.agent_drafts'::regclass THEN 'agent_draft' ELSE 'process_draft' END
       AND r.status='approved') THEN RAISE EXCEPTION 'DRAFT_APPROVED_REVISION_REQUIRED' USING ERRCODE='EN412';END IF;
   IF TG_RELID='studio.agent_drafts'::regclass THEN
     IF NOT EXISTS(SELECT 1 FROM ai.agent_versions v JOIN ai.agent_publications p
       ON p.organization_id=v.organization_id AND p.definition_id=v.definition_id AND p.version_id=v.id
       JOIN ai.agent_definitions d ON d.organization_id=v.organization_id AND d.id=v.definition_id
       JOIN org.service_identities identity ON identity.organization_id=d.organization_id AND identity.id=d.service_identity_id
       WHERE v.organization_id=NEW.organization_id AND v.definition_id=NEW.agent_definition_id
         AND d.owner_membership_id=NEW.owner_membership_id AND identity.owner_membership_id=NEW.owner_membership_id
         AND v.spec_sha256=NEW.spec_sha256 AND v.spec=NEW.compiled_spec AND p.active_from<=now()
         AND (p.active_until IS NULL OR p.active_until>now())) THEN
       RAISE EXCEPTION 'DRAFT_REAL_AGENT_VERSION_REQUIRED' USING ERRCODE='EN412';END IF;
   ELSIF NOT EXISTS(SELECT 1 FROM studio.process_specs p WHERE p.organization_id=NEW.organization_id
       AND p.spec_sha256=NEW.spec_sha256 AND p.source_ref=NEW.id::text AND p.source IN ('graph','pack')
       AND p.name=NEW.name AND p.classification=NEW.classification) THEN
     RAISE EXCEPTION 'DRAFT_REAL_PROCESS_SPEC_REQUIRED' USING ERRCODE='EN412';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_drafts_author BEFORE INSERT OR UPDATE ON studio.agent_drafts
 FOR EACH ROW EXECUTE FUNCTION studio.guard_draft_author();
CREATE TRIGGER process_drafts_author BEFORE INSERT OR UPDATE ON studio.process_drafts
 FOR EACH ROW EXECUTE FUNCTION studio.guard_draft_author();

CREATE FUNCTION studio.guard_simulation_input() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE run studio.simulation_runs%ROWTYPE;draft_hash text;draft_version bigint;
BEGIN
 IF TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
   OR NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id()
   OR NEW.requested_session_id IS DISTINCT FROM app.current_interactive_session_id() OR NOT studio.author_allowed() THEN
   RAISE EXCEPTION 'SIMULATION_INPUT_AUTHORITY_REQUIRED' USING ERRCODE='EN412';END IF;
 SELECT s.* INTO run FROM studio.simulation_runs s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.simulation_run_id FOR SHARE;
 IF run.id IS NULL OR run.status<>'queued' OR run.requested_by_membership_id<>NEW.requested_by_membership_id
   OR encode(sha256(convert_to(NEW.spec_canonical,'UTF8')),'hex')<>run.subject_sha256
   OR jsonb_typeof(NEW.spec_canonical::jsonb)<>'object' THEN
   RAISE EXCEPTION 'SIMULATION_INPUT_MISMATCH' USING ERRCODE='EN412';END IF;
 IF run.subject_kind='agent_draft' THEN
   SELECT d.spec_sha256,d.version INTO draft_hash,draft_version FROM studio.agent_drafts d
     WHERE d.organization_id=NEW.organization_id AND d.id=run.subject_id AND d.status<>'archived'
       AND d.compiled_spec_canonical=NEW.spec_canonical AND d.compile_policy_version=NEW.policy_version FOR SHARE;
 ELSIF run.subject_kind='process_draft' THEN
   SELECT d.spec_sha256,d.version INTO draft_hash,draft_version FROM studio.process_drafts d
     WHERE d.organization_id=NEW.organization_id AND d.id=run.subject_id AND d.status<>'archived' FOR SHARE;
 ELSE RETURN NEW;
 END IF;
 IF draft_hash IS DISTINCT FROM run.subject_sha256 OR draft_version IS DISTINCT FROM NEW.source_version THEN
   RAISE EXCEPTION 'SIMULATION_SUBJECT_CHANGED' USING ERRCODE='EN412';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER simulation_inputs_admission BEFORE INSERT ON studio.simulation_inputs
 FOR EACH ROW EXECUTE FUNCTION studio.guard_simulation_input();
CREATE TRIGGER simulation_inputs_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON studio.simulation_inputs
 FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();

CREATE FUNCTION studio.guard_simulation_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE requester uuid;
BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
   RAISE EXCEPTION 'SIMULATION_AUTHORITY_REQUIRED' USING ERRCODE='EN412';END IF;
 IF TG_OP='INSERT' THEN
   IF NOT studio.author_allowed() OR NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
     RAISE EXCEPTION 'SIMULATION_AUTHOR_REQUIRED' USING ERRCODE='EN412';END IF;
 ELSE
   IF NOT studio.simulation_worker(NEW.id) OR NOT EXISTS(SELECT 1 FROM studio.simulation_inputs i
     WHERE i.organization_id=NEW.organization_id AND i.simulation_run_id=NEW.id) THEN
     RAISE EXCEPTION 'SIMULATION_INTENT_REQUIRED' USING ERRCODE='EN412';END IF;
   SELECT m.id INTO requester FROM org.memberships m WHERE m.organization_id=NEW.organization_id
     AND m.id=NEW.requested_by_membership_id AND m.status='active' AND m.role IN ('owner','admin') FOR SHARE;
   IF requester IS NULL THEN RAISE EXCEPTION 'SIMULATION_REQUESTER_CHANGED' USING ERRCODE='EN412';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER simulation_runs_authority BEFORE INSERT OR UPDATE ON studio.simulation_runs
 FOR EACH ROW EXECUTE FUNCTION studio.guard_simulation_effect();
CREATE FUNCTION studio.complete_simulation_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM studio.simulation_inputs i WHERE i.organization_id=NEW.organization_id AND i.simulation_run_id=NEW.id)
 OR NOT EXISTS(SELECT 1 FROM platform.domain_events e JOIN platform.outbox_events o
   ON o.organization_id=e.organization_id AND o.event_id=e.id WHERE e.organization_id=NEW.organization_id
     AND e.aggregate_type='simulation_run' AND e.aggregate_id=NEW.id AND e.event_type='simulation.requested'
     AND e.actor_type='membership' AND e.actor_id=NEW.requested_by_membership_id) THEN
   RAISE EXCEPTION 'SIMULATION_INTENT_INCOMPLETE' USING ERRCODE='EN412';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER simulation_intent_complete AFTER INSERT ON studio.simulation_runs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio.complete_simulation_intent();
REVOKE ALL ON FUNCTION studio.guard_draft_author(),studio.guard_simulation_input(),studio.guard_simulation_effect(),
 studio.complete_simulation_intent() FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY reviews_current_person ON studio.publish_reviews AS RESTRICTIVE TO ensemus_app
 USING(studio.current_author() AND (subject_kind<>'process_draft' OR EXISTS(SELECT 1 FROM studio.process_drafts d
   WHERE d.organization_id=publish_reviews.organization_id AND d.id=publish_reviews.subject_id)))
 WITH CHECK(studio.current_author());
CREATE FUNCTION studio.guard_review_authority() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE subject_hash text;subject_status text;subject_owner uuid;subject_name text;simulation studio.simulation_runs%ROWTYPE;
  snapshot studio.simulation_inputs%ROWTYPE;reviewed_spec jsonb;requires_second boolean;reviewer uuid;definition_key uuid;identity_key uuid;
BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NOT studio.current_author() THEN
   RAISE EXCEPTION 'REVIEW_PERSON_REQUIRED' USING ERRCODE='EN412';END IF;
 IF NEW.subject_kind='agent_draft' THEN
   SELECT d.spec_sha256,d.status,d.owner_membership_id,d.name INTO subject_hash,subject_status,subject_owner,subject_name FROM studio.agent_drafts d
     WHERE d.organization_id=NEW.organization_id AND d.id=NEW.subject_id FOR SHARE;
 ELSE
   SELECT d.spec_sha256,d.status,d.owner_membership_id,d.name INTO subject_hash,subject_status,subject_owner,subject_name FROM studio.process_drafts d
     WHERE d.organization_id=NEW.organization_id AND d.id=NEW.subject_id FOR SHARE;
 END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id() OR NOT studio.author_allowed()
     OR subject_hash IS DISTINCT FROM NEW.subject_sha256 OR subject_status='archived'
     OR NEW.subject_owner_membership_id IS NULL OR NEW.subject_owner_membership_id IS DISTINCT FROM subject_owner
     OR NEW.subject_name IS NULL OR NEW.subject_name IS DISTINCT FROM subject_name THEN
     RAISE EXCEPTION 'REVIEW_SUBJECT_CHANGED' USING ERRCODE='EN412';END IF;
   SELECT s.* INTO simulation FROM studio.simulation_runs s
     WHERE s.organization_id=NEW.organization_id AND s.id=NEW.simulation_run_id FOR SHARE;
   SELECT i.* INTO snapshot FROM studio.simulation_inputs i
     WHERE i.organization_id=NEW.organization_id AND i.simulation_run_id=NEW.simulation_run_id;
   IF simulation.status IS DISTINCT FROM 'passed' OR snapshot.simulation_run_id IS NULL
     OR simulation.subject_kind IS DISTINCT FROM NEW.subject_kind OR simulation.subject_id IS DISTINCT FROM NEW.subject_id
     OR simulation.subject_sha256 IS DISTINCT FROM NEW.subject_sha256
     OR encode(sha256(convert_to(snapshot.spec_canonical,'UTF8')),'hex')<>NEW.subject_sha256 THEN
     RAISE EXCEPTION 'REVIEW_SIMULATION_MISMATCH' USING ERRCODE='EN412';END IF;
   reviewed_spec:=snapshot.spec_canonical::jsonb;
   IF NEW.subject_kind='agent_draft' THEN
     requires_second:=coalesce((reviewed_spec->'tools'->'allow') ?| ARRAY['email.send','agent.delegate'],false)
       OR coalesce((reviewed_spec->'context'->'allowed_scopes') ? 'data.confidential.read',false);
   ELSE
     requires_second:=coalesce(reviewed_spec->>'classification' IN ('confidential','restricted'),false)
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(reviewed_spec->'steps') step WHERE step->>'kind' IN ('external_action','agent_task'));
   END IF;
   IF requires_second AND NEW.risk_level<>'elevated' THEN
     RAISE EXCEPTION 'REVIEW_RISK_DOWNGRADE' USING ERRCODE='EN412';END IF;
   RETURN NEW;
 END IF;
 IF NEW.subject_name IS NULL OR NEW.subject_name IS DISTINCT FROM subject_name THEN
   IF NEW.status<>'cancelled' THEN RAISE EXCEPTION 'REVIEW_NAME_CHANGED' USING ERRCODE='EN412';END IF;
 END IF;
 IF NEW.reviewer_membership_id IS DISTINCT FROM OLD.reviewer_membership_id THEN
   RAISE EXCEPTION 'REVIEWER_ASSIGNMENT_FIXED' USING ERRCODE='EN412';END IF;
 IF NEW.status IN ('approved','rejected') AND OLD.status='pending' THEN
   IF NEW.decided_by_membership_id IS DISTINCT FROM app.current_membership_id()
     OR (NEW.reviewer_membership_id IS NOT NULL AND NEW.reviewer_membership_id<>app.current_membership_id())
     OR subject_hash IS DISTINCT FROM NEW.subject_sha256 OR subject_status='archived'
     OR NEW.subject_owner_membership_id IS NULL OR NEW.subject_owner_membership_id IS DISTINCT FROM subject_owner
     OR NOT app.interactive_privilege_allowed('studio.review_decision') THEN
     RAISE EXCEPTION 'REVIEW_DECISION_AUTHORITY_REQUIRED' USING ERRCODE='EN412';END IF;
 ELSIF NEW.status='published' AND OLD.status='approved' THEN
   IF subject_hash IS DISTINCT FROM NEW.subject_sha256 OR subject_status<>'published'
     OR NEW.subject_owner_membership_id IS NULL OR NEW.subject_owner_membership_id IS DISTINCT FROM subject_owner
     OR NOT app.interactive_privilege_allowed('studio.publish') THEN
     RAISE EXCEPTION 'REVIEW_PUBLISH_AUTHORITY_REQUIRED' USING ERRCODE='EN412';END IF;
   SELECT m.id INTO reviewer FROM org.memberships m WHERE m.organization_id=NEW.organization_id
     AND m.id=NEW.decided_by_membership_id AND m.status='active' AND m.role IN ('owner','admin') FOR SHARE;
   IF reviewer IS NULL THEN RAISE EXCEPTION 'REVIEWER_AUTHORITY_CHANGED' USING ERRCODE='EN412';END IF;
   SELECT i.* INTO snapshot FROM studio.simulation_inputs i
     WHERE i.organization_id=NEW.organization_id AND i.simulation_run_id=NEW.simulation_run_id;
   IF snapshot.simulation_run_id IS NULL THEN RAISE EXCEPTION 'REVIEW_INPUT_MISSING' USING ERRCODE='EN412';END IF;
   reviewed_spec:=snapshot.spec_canonical::jsonb;
   IF NEW.subject_kind='agent_draft' THEN
     -- Immutable metadata hashes alone cannot stand in for the actual reviewed manifest/body.
     SELECT d.id,d.service_identity_id INTO definition_key,identity_key FROM ai.agent_versions v JOIN ai.agent_definitions d
       ON d.organization_id=v.organization_id AND d.id=v.definition_id
       WHERE v.organization_id=NEW.organization_id AND v.id=NEW.published_ref AND v.spec_sha256=NEW.subject_sha256;
     IF definition_key IS NULL OR NOT pg_try_advisory_xact_lock_shared(hashtextextended(
       'ensemus:agent-publication:'||NEW.organization_id::text||':'||definition_key::text,0)) THEN
       RAISE EXCEPTION 'REVIEW_PUBLICATION_BUSY' USING ERRCODE='55P03';END IF;
     PERFORM 1 FROM org.service_identities i WHERE i.organization_id=NEW.organization_id AND i.id=identity_key
       AND i.status='active' AND (i.expires_at IS NULL OR i.expires_at>now()) FOR SHARE NOWAIT;
     IF NOT FOUND THEN RAISE EXCEPTION 'REVIEW_IDENTITY_CLOSED' USING ERRCODE='EN412';END IF;
     IF NOT EXISTS(SELECT 1 FROM ai.agent_versions v JOIN ai.agent_definitions d
       ON d.organization_id=v.organization_id AND d.id=v.definition_id JOIN org.service_identities identity
       ON identity.organization_id=d.organization_id AND identity.id=d.service_identity_id
       JOIN studio.agent_drafts draft ON draft.organization_id=v.organization_id AND draft.id=NEW.subject_id
       WHERE v.organization_id=NEW.organization_id AND v.id=NEW.published_ref AND v.spec_sha256=NEW.subject_sha256
         AND v.spec=reviewed_spec AND draft.compiled_spec=reviewed_spec AND draft.agent_definition_id=d.id AND d.slug=reviewed_spec->>'id'
         AND d.owner_membership_id=NEW.subject_owner_membership_id AND identity.owner_membership_id=NEW.subject_owner_membership_id
         AND d.name=NEW.subject_name
         AND identity.status='active' AND (identity.expires_at IS NULL OR identity.expires_at>now())
         AND (SELECT count(*) FROM ai.agent_publications p WHERE p.organization_id=v.organization_id
           AND p.definition_id=d.id AND p.active_from<=now() AND (p.active_until IS NULL OR p.active_until>now()))=1
         AND EXISTS(SELECT 1 FROM ai.agent_publications p WHERE p.organization_id=v.organization_id AND p.definition_id=d.id
           AND p.version_id=v.id AND p.active_from<=now() AND (p.active_until IS NULL OR p.active_until>now()))) THEN
       RAISE EXCEPTION 'REVIEW_AGENT_RESULT_MISMATCH' USING ERRCODE='EN412';END IF;
   ELSIF NOT EXISTS(SELECT 1 FROM studio.process_specs p JOIN studio.process_drafts d
       ON d.organization_id=p.organization_id AND d.id=NEW.subject_id WHERE p.organization_id=NEW.organization_id
       AND p.id=NEW.published_ref AND p.spec_sha256=NEW.subject_sha256 AND p.spec=reviewed_spec
       AND p.source_ref=NEW.subject_id::text AND p.source IN ('graph','pack')
       AND p.name=d.name AND p.classification=d.classification) THEN
     RAISE EXCEPTION 'REVIEW_PROCESS_RESULT_MISMATCH' USING ERRCODE='EN412';END IF;
 ELSIF NEW.status='cancelled' AND OLD.status IN ('pending','approved') THEN
   IF NOT studio.author_allowed() THEN RAISE EXCEPTION 'REVIEW_CANCEL_AUTHORITY_REQUIRED' USING ERRCODE='EN412';END IF;
 ELSIF NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'REVIEW_TRANSITION_NOT_ADMITTED' USING ERRCODE='EN412';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publish_reviews_authority BEFORE INSERT OR UPDATE ON studio.publish_reviews
 FOR EACH ROW EXECUTE FUNCTION studio.guard_review_authority();
REVOKE ALL ON FUNCTION studio.guard_review_authority() FROM PUBLIC;

--> statement-breakpoint
-- Frozen checked-in catalog bodies. No tenant data or inferred execution capability.
CREATE FUNCTION studio.bundled_publication_matches(p_key text,p_ref text,p_name text,p_class text,p_hash text,p_spec jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM (VALUES
 ('client-status-update','client-status-update@1','Client status update','internal','03855c0f0fa8b2c548e2aef96453c54d144d5b24a22166fdadd8a564f6537fe7','{"classification":"internal","schemaVersion":1,"steps":[{"after":["send_update"],"evidence":"external_receipt","key":"confirm_sent","kind":"evidence_check","label":"Confirm it was sent","labelCode":null},{"after":["gather_evidence"],"key":"draft_update","kind":"work_item","label":"Draft the update","labelCode":null},{"after":[],"key":"gather_evidence","kind":"work_item","label":"Gather the evidence","labelCode":null},{"after":["draft_update"],"approverRole":"process_owner","key":"review_update","kind":"human_approval","label":"Review the update","labelCode":null},{"after":["review_update"],"key":"send_update","kind":"external_action","label":"Send the update","labelCode":null,"toolId":"email.send"}]}'),
 ('meeting-actions','meeting-actions@1','Meeting actions','internal','fee4cb2940cc37b601ffe499bc306a4748263402e2552d13b797d9a8f976a9c6','{"classification":"internal","schemaVersion":1,"steps":[{"after":["extract_actions"],"key":"assign_owners","kind":"work_item","label":"Give each action an owner","labelCode":null},{"after":["meeting_summary"],"key":"extract_actions","kind":"work_item","label":"List the actions","labelCode":null},{"after":[],"key":"meeting_summary","kind":"work_item","label":"Bring in the meeting summary","labelCode":null},{"after":["track_due_dates"],"approverRole":"process_owner","key":"review_completion","kind":"human_approval","label":"Check the actions were done","labelCode":null},{"after":["assign_owners"],"key":"track_due_dates","kind":"work_item","label":"Track the due dates","labelCode":null},{"after":["review_completion"],"evidence":"reviewer_approved","key":"verified_completion","kind":"evidence_check","label":"Confirm a reviewer checked","labelCode":null}]}'),
 ('project-invoice-handoff','project-invoice-handoff@1','Project invoice handoff','confidential','15f8658d6b4f258438c7ed8413ee2d1bac11b3e7fc3ed96006e6d84cefb91602','{"classification":"confidential","schemaVersion":1,"steps":[{"after":["finance_handoff"],"approverRole":"process_owner","key":"approve_draft_request","kind":"human_approval","label":"Approve asking for the invoice draft","labelCode":null},{"after":[],"evidence":"artifact_attached","key":"deliverables_attached","kind":"evidence_check","label":"Attach the deliverables","labelCode":null},{"after":["review_deliverables"],"key":"finance_handoff","kind":"work_item","label":"Hand over to finance","labelCode":null},{"after":["approve_draft_request"],"key":"invoice_draft","kind":"external_action","label":"Ask for an invoice draft in the accounting system","labelCode":null,"toolId":"accounting.invoice_draft.create"},{"after":["deliverables_attached"],"approverRole":"process_owner","key":"review_deliverables","kind":"human_approval","label":"Review the deliverables","labelCode":null}]}'),
 ('new-employee-onboarding','new-employee-onboarding@1','New employee onboarding','confidential','c54c5e803ba16a8b24f83598ae027a4eb62a8b161a645c048e724eb223fe78cf','{"classification":"confidential","schemaVersion":1,"steps":[{"after":["first_tasks"],"key":"access_request","kind":"work_item","label":"File the access request","labelCode":null},{"after":["access_request"],"approverRole":"process_owner","key":"approve_access_request","kind":"human_approval","label":"Approve the access request","labelCode":null},{"after":["onboarding_checklist"],"evidence":"artifact_attached","key":"checklist_attached","kind":"evidence_check","label":"Attach the finished checklist","labelCode":null},{"after":["policy_pack"],"key":"first_tasks","kind":"work_item","label":"Set the first tasks","labelCode":null},{"after":["approve_access_request"],"key":"onboarding_checklist","kind":"work_item","label":"Complete the onboarding checklist","labelCode":null},{"after":[],"key":"policy_pack","kind":"work_item","label":"Share the policy pack","labelCode":null}]}')
 ) AS released(key,ref,name,class,hash,spec) WHERE released.key=p_key AND released.ref=p_ref
 AND released.name=p_name AND released.class=p_class AND released.hash=p_hash AND released.spec::jsonb=p_spec)
$$;
REVOKE ALL ON FUNCTION studio.bundled_publication_matches(text,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION studio.bundled_publication_matches(text,text,text,text,text,jsonb) TO ensemus_app;

CREATE FUNCTION studio.guard_process_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
   OR NEW.published_by_membership_id IS DISTINCT FROM app.current_membership_id()
   OR NOT studio.author_allowed() OR NOT app.interactive_privilege_allowed('studio.publish') THEN
   RAISE EXCEPTION 'PROCESS_NATIVE_PUBLISHER_REQUIRED' USING ERRCODE='EN412';END IF;
 IF NEW.source='bundled' THEN
   IF NOT studio.bundled_publication_matches(NEW.process_key,NEW.source_ref,NEW.name,NEW.classification,NEW.spec_sha256,NEW.spec) THEN
     RAISE EXCEPTION 'PROCESS_CATALOG_BODY_REQUIRED' USING ERRCODE='EN412';END IF;
 ELSIF NEW.source IN ('graph','pack') THEN
   IF NOT EXISTS(SELECT 1 FROM studio.publish_reviews r JOIN studio.process_drafts d
     ON d.organization_id=r.organization_id AND d.id=r.subject_id JOIN studio.simulation_inputs i
     ON i.organization_id=r.organization_id AND i.simulation_run_id=r.simulation_run_id
     JOIN studio.simulation_runs s ON s.organization_id=i.organization_id AND s.id=i.simulation_run_id
     WHERE r.organization_id=NEW.organization_id AND r.subject_kind='process_draft' AND r.status='approved'
       AND r.subject_id::text=NEW.source_ref AND NEW.process_key='process-'||r.subject_id::text
       AND r.subject_sha256=NEW.spec_sha256 AND d.spec_sha256=NEW.spec_sha256 AND d.status='in_review'
       AND r.subject_owner_membership_id=d.owner_membership_id AND r.subject_name=NEW.name AND d.name=NEW.name
       AND d.classification=NEW.classification AND i.spec_canonical::jsonb=NEW.spec
       AND encode(sha256(convert_to(i.spec_canonical,'UTF8')),'hex')=NEW.spec_sha256
       AND s.status='passed' AND s.subject_kind='process_draft' AND s.subject_id=d.id
       AND s.subject_sha256=NEW.spec_sha256 AND s.scenario_key='standard.process'
       AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=r.organization_id
         AND m.id=r.decided_by_membership_id AND m.status='active' AND m.role IN ('owner','admin'))) THEN
     RAISE EXCEPTION 'PROCESS_APPROVED_BODY_REQUIRED' USING ERRCODE='EN412';END IF;
 ELSE RAISE EXCEPTION 'PROCESS_PUBLICATION_SOURCE_REQUIRED' USING ERRCODE='EN412';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER process_specs_authority BEFORE INSERT ON studio.process_specs
 FOR EACH ROW EXECUTE FUNCTION studio.guard_process_publication();
REVOKE ALL ON FUNCTION studio.guard_process_publication() FROM PUBLIC;

CREATE FUNCTION studio.guard_process_start() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
 OR NEW.started_by_membership_id IS DISTINCT FROM app.current_membership_id()
 OR NEW.status<>'queued' OR NEW.version<>1 OR NOT studio.author_allowed()
 OR NOT EXISTS(SELECT 1 FROM studio.process_specs p JOIN work.work_units w
   ON w.organization_id=p.organization_id AND w.id=NEW.root_work_unit_id
   WHERE p.organization_id=NEW.organization_id AND p.id=NEW.spec_id
     AND p.classification=w.classification AND w.owner_membership_id=NEW.started_by_membership_id
     AND w.status='queued' AND w.run_id IS NULL AND w.execution_plan IS NULL) THEN
   RAISE EXCEPTION 'PROCESS_NATIVE_START_REQUIRED' USING ERRCODE='EN412';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER process_runs_start_authority BEFORE INSERT ON studio.process_runs
 FOR EACH ROW EXECUTE FUNCTION studio.guard_process_start();
REVOKE ALL ON FUNCTION studio.guard_process_start() FROM PUBLIC;
