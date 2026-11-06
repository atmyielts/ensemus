-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-031). Changes here need human review, never agent approval.
-- Default deny: a role reaches only what is granted below, and RLS still filters those rows. The web and
-- the worker share ensemus_app, so anything that must hold whichever of them is compromised is a trigger
-- or a missing grant, and never a rule in application code alone.

-- Forced RLS and the tenant policy on every table in the new schemas. A test fails if one misses it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename FROM pg_tables
     WHERE schemaname IN ('studio','objects','packs','experience')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format(
      'CREATE POLICY tenant_scoped ON %I.%I TO ensemus_app '
      'USING (organization_id = app.current_organization_id()) '
      'WITH CHECK (organization_id = app.current_organization_id())',
      t.schemaname, t.tablename);
  END LOOP;
  FOR t IN
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'org'
       AND tablename IN ('security_policies','sso_connections','sso_member_links','scim_tokens')
  LOOP
    EXECUTE format('ALTER TABLE org.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE org.%I FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format(
      'CREATE POLICY tenant_scoped ON org.%I TO ensemus_app '
      'USING (organization_id = app.current_organization_id()) '
      'WITH CHECK (organization_id = app.current_organization_id())',
      t.tablename);
  END LOOP;
  FOR t IN
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'identity'
       AND tablename IN ('two_factors','sso_providers','session_assurances')
  LOOP
    EXECUTE format('ALTER TABLE identity.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE identity.%I FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format(
      'CREATE POLICY auth_all ON identity.%I TO ensemus_auth USING (true) WITH CHECK (true)',
      t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

-- Only the application role comes to the new schemas. The dispatcher sees event metadata and the secrets
-- role sees sealed values, and neither has any business with drafts, records or who reviewed what.
GRANT USAGE ON SCHEMA studio, objects, packs, experience TO ensemus_app;
--> statement-breakpoint

-- identity. The TOTP secrets and provider settings stay with the auth role alone.
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.two_factors, identity.sso_providers,
  identity.session_assurances TO ensemus_auth;
--> statement-breakpoint
-- The application can ask what this person's session has proven, for that person only. It can never say
-- so itself: there is no insert or update here, so an injection in application queries cannot forge MFA.
GRANT SELECT (session_id, kind, user_id, sso_provider_id, verified_at)
  ON identity.session_assurances TO ensemus_app;
--> statement-breakpoint
CREATE POLICY session_assurances_self ON identity.session_assurances FOR SELECT TO ensemus_app
  USING (user_id = app.current_user_id());
--> statement-breakpoint
-- Whether a colleague has MFA on is something an admin's page shows. Their secret is on another table.
GRANT SELECT (two_factor_enabled) ON identity.users TO ensemus_app;
--> statement-breakpoint

-- Security settings of a tenant.
GRANT SELECT, INSERT ON org.security_policies TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (mfa_for_administration, mfa_max_age_seconds, sso_enforcement, version,
              updated_by_membership_id, updated_at)
  ON org.security_policies TO ensemus_app;
--> statement-breakpoint

-- A connection's provider and domain are fixed once written, and only the operator can verify a domain:
-- the application role has no grant on those columns. Otherwise any tenant could claim someone else's
-- email domain and sign in as its people (ADR-031 D9).
GRANT SELECT, INSERT ON org.sso_connections TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (display_name, state, auto_join, version, updated_at)
  ON org.sso_connections TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION org.check_new_sso_connection() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF current_user = 'ensemus_app'
     AND (NEW.domain_state <> 'unverified' OR NEW.domain_verified_at IS NOT NULL
          OR NEW.state <> 'draft' OR NEW.version <> 1) THEN
    RAISE EXCEPTION 'SSO_CONNECTION_INVALID_START' USING ERRCODE = 'EN401';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sso_connections_check_new
  BEFORE INSERT ON org.sso_connections
  FOR EACH ROW EXECUTE FUNCTION org.check_new_sso_connection();
--> statement-breakpoint
-- The operator's command, run with the migrator role like the setup code. It touches these two rows only.
CREATE POLICY sso_connections_operator ON org.sso_connections TO ensemus_migrator
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY sso_providers_operator ON identity.sso_providers TO ensemus_migrator
  USING (true) WITH CHECK (true);
--> statement-breakpoint
-- The other operator's command: someone lost their device and their backup codes (ADR-031 D8).
CREATE POLICY two_factors_operator ON identity.two_factors FOR DELETE TO ensemus_migrator
  USING (true);
--> statement-breakpoint
CREATE POLICY two_factors_operator_read ON identity.two_factors FOR SELECT TO ensemus_migrator
  USING (true);
--> statement-breakpoint
CREATE POLICY session_assurances_operator ON identity.session_assurances FOR DELETE TO ensemus_migrator
  USING (true);
--> statement-breakpoint
CREATE POLICY session_assurances_operator_read ON identity.session_assurances FOR SELECT TO ensemus_migrator
  USING (true);
--> statement-breakpoint
CREATE POLICY users_operator_second_factor ON identity.users FOR UPDATE TO ensemus_migrator
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY users_operator_read ON identity.users FOR SELECT TO ensemus_migrator
  USING (true);
--> statement-breakpoint

GRANT SELECT, INSERT ON org.sso_member_links TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, last_login_at, deprovisioned_at, updated_at)
  ON org.sso_member_links TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON org.scim_tokens TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, last_used_at, revoked_at) ON org.scim_tokens TO ensemus_app;
--> statement-breakpoint

-- A caller holding a SCIM token is nobody yet, and a person coming back from a provider is not in a
-- tenant yet. Each finds exactly the one row their value names, and nothing else, as webhook URLs do.
CREATE FUNCTION app.current_scim_token_hash() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.scim_token_hash', true), '') $$;
--> statement-breakpoint
CREATE POLICY scim_tokens_by_hash ON org.scim_tokens FOR SELECT TO ensemus_app
  USING (token_hash = app.current_scim_token_hash());
--> statement-breakpoint
CREATE FUNCTION app.current_sso_provider_id() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.sso_provider_id', true), '') $$;
--> statement-breakpoint
CREATE POLICY sso_connections_by_provider ON org.sso_connections FOR SELECT TO ensemus_app
  USING (provider_id = app.current_sso_provider_id());
--> statement-breakpoint

-- Studio: drafts. Who made one is fixed.
GRANT SELECT, INSERT ON studio.agent_drafts TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (name, owner_membership_id, agent_definition_id, answers, spec_sha256, status, version,
              updated_at)
  ON studio.agent_drafts TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON studio.process_drafts TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (name, owner_membership_id, classification, graph, spec_sha256, status, version, updated_at)
  ON studio.process_drafts TO ensemus_app;
--> statement-breakpoint

-- Studio: a simulation binds one hash, which no role can change, and a finished one is a record.
GRANT SELECT, INSERT ON studio.simulation_runs TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, outcome_code, report, report_sha256, started_at, finished_at)
  ON studio.simulation_runs TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION studio.check_simulation_run() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' OR NEW.report IS NOT NULL THEN
      RAISE EXCEPTION 'SIMULATION_INVALID_START' USING ERRCODE = 'EN401';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('passed','failed','errored')
     OR NOT (
       (OLD.status = NEW.status)
       OR (OLD.status = 'queued' AND NEW.status IN ('running','errored'))
       OR (OLD.status = 'running' AND NEW.status IN ('passed','failed','errored'))
     ) THEN
    RAISE EXCEPTION 'SIMULATION_INVALID_TRANSITION' USING ERRCODE = 'EN401';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER simulation_runs_check
  BEFORE INSERT OR UPDATE ON studio.simulation_runs
  FOR EACH ROW EXECUTE FUNCTION studio.check_simulation_run();
--> statement-breakpoint
CREATE TRIGGER simulation_runs_keep
  BEFORE DELETE OR TRUNCATE ON studio.simulation_runs
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- Studio: a review. What it is about, its risk and the simulation behind it are fixed. A review needs a
-- passed simulation of exactly the same hash, and elevated risk needs a second person (ADR-031 D6).
GRANT SELECT, INSERT ON studio.publish_reviews TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (reviewer_membership_id, status, decided_by_membership_id, decision_reason, decided_at,
              published_ref, published_at, version, updated_at)
  ON studio.publish_reviews TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION studio.check_publish_review() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE simulation record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT s.status, s.subject_kind, s.subject_id, s.subject_sha256 INTO simulation
      FROM studio.simulation_runs s
     WHERE s.organization_id = NEW.organization_id AND s.id = NEW.simulation_run_id;
    IF NOT FOUND
       OR simulation.status <> 'passed'
       OR simulation.subject_kind <> NEW.subject_kind
       OR simulation.subject_id <> NEW.subject_id
       OR simulation.subject_sha256 <> NEW.subject_sha256 THEN
      RAISE EXCEPTION 'REVIEW_SIMULATION_MISMATCH' USING ERRCODE = 'EN402';
    END IF;
    IF NEW.status <> 'pending' OR NEW.version <> 1 OR NEW.decided_by_membership_id IS NOT NULL THEN
      RAISE EXCEPTION 'REVIEW_INVALID_START' USING ERRCODE = 'EN401';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> NEW.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('approved','rejected','cancelled'))
       OR (OLD.status = 'approved' AND NEW.status IN ('published','cancelled'))
     ) THEN
    RAISE EXCEPTION 'REVIEW_INVALID_TRANSITION' USING ERRCODE = 'EN401';
  END IF;
  IF OLD.status = 'pending' AND NEW.status IN ('approved','rejected') THEN
    IF NEW.decided_by_membership_id IS NULL OR NEW.decided_at IS NULL THEN
      RAISE EXCEPTION 'REVIEW_NEEDS_A_PERSON' USING ERRCODE = 'EN402';
    END IF;
    IF NEW.risk_level = 'elevated' AND NEW.decided_by_membership_id = NEW.requested_by_membership_id THEN
      RAISE EXCEPTION 'REVIEW_SELF_DECISION' USING ERRCODE = 'EN402';
    END IF;
  ELSIF NEW.decided_by_membership_id IS DISTINCT FROM OLD.decided_by_membership_id
        OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
    RAISE EXCEPTION 'REVIEW_DECISION_FIXED' USING ERRCODE = 'EN402';
  END IF;
  IF NEW.status = 'published' AND (NEW.published_ref IS NULL OR NEW.published_at IS NULL) THEN
    RAISE EXCEPTION 'REVIEW_NEEDS_A_RESULT' USING ERRCODE = 'EN402';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER publish_reviews_check
  BEFORE INSERT OR UPDATE ON studio.publish_reviews
  FOR EACH ROW EXECUTE FUNCTION studio.check_publish_review();
--> statement-breakpoint
CREATE TRIGGER publish_reviews_keep
  BEFORE DELETE OR TRUNCATE ON studio.publish_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- Studio: a process spec is immutable for every role, including its owner.
GRANT SELECT, INSERT ON studio.process_specs TO ensemus_app;
--> statement-breakpoint
CREATE TRIGGER process_specs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON studio.process_specs
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- Studio: a run. Which spec, which work and who started it are fixed.
GRANT SELECT, INSERT ON studio.process_runs TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, stop_code, temporal_run_id, version, updated_at, finished_at)
  ON studio.process_runs TO ensemus_app;
--> statement-breakpoint
CREATE TRIGGER process_runs_keep
  BEFORE DELETE OR TRUNCATE ON studio.process_runs
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
GRANT SELECT, INSERT ON studio.process_run_steps TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, stop_code, work_unit_id, approval_id, external_action_id, agent_run_id, artifact_id,
              updated_at)
  ON studio.process_run_steps TO ensemus_app;
--> statement-breakpoint
-- What a step made is written once, so a retried step can find it and can never quietly point elsewhere.
CREATE FUNCTION studio.check_process_step() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (OLD.work_unit_id IS NOT NULL AND NEW.work_unit_id IS DISTINCT FROM OLD.work_unit_id)
     OR (OLD.approval_id IS NOT NULL AND NEW.approval_id IS DISTINCT FROM OLD.approval_id)
     OR (OLD.external_action_id IS NOT NULL AND NEW.external_action_id IS DISTINCT FROM OLD.external_action_id)
     OR (OLD.agent_run_id IS NOT NULL AND NEW.agent_run_id IS DISTINCT FROM OLD.agent_run_id)
     OR (OLD.artifact_id IS NOT NULL AND NEW.artifact_id IS DISTINCT FROM OLD.artifact_id) THEN
    RAISE EXCEPTION 'PROCESS_STEP_REFERENCE_FIXED' USING ERRCODE = 'EN401';
  END IF;
  IF OLD.status IN ('done','failed','skipped') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'PROCESS_STEP_FINISHED' USING ERRCODE = 'EN401';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER process_run_steps_check
  BEFORE UPDATE ON studio.process_run_steps
  FOR EACH ROW EXECUTE FUNCTION studio.check_process_step();
--> statement-breakpoint

-- Custom objects. A type can only get stricter, a record can never be looser than its type, and an old
-- shape is never rewritten, because records and pack upgrades refer to it (KNOW-07).
GRANT SELECT, INSERT ON objects.types TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (display_name, classification, current_version_number, state, version, updated_at)
  ON objects.types TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON objects.type_versions TO ensemus_app;
--> statement-breakpoint
CREATE TRIGGER type_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON objects.type_versions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
GRANT SELECT, INSERT ON objects.records TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (type_version_number, display_name, attributes, classification, owner_membership_id, version,
              updated_at, deleted_at)
  ON objects.records TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON objects.record_values TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON objects.relations TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON objects.migrations TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, migrated_count, failed_count, error_code, finished_at)
  ON objects.migrations TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION app.classification_rank(value text) RETURNS integer
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT array_position(ARRAY['public','internal','confidential','restricted'], value) $$;
--> statement-breakpoint
CREATE FUNCTION objects.check_type_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF app.classification_rank(NEW.classification) < app.classification_rank(OLD.classification) THEN
    RAISE EXCEPTION 'OBJECT_CLASSIFICATION_LOWERED' USING ERRCODE = 'EN403';
  END IF;
  -- Raising a type raises the floor for records below it, and records already stricter stay as they are.
  IF NEW.classification <> OLD.classification THEN
    UPDATE objects.records r
       SET classification = NEW.classification, updated_at = now()
     WHERE r.organization_id = NEW.organization_id
       AND r.type_id = NEW.id
       AND app.classification_rank(r.classification) < app.classification_rank(NEW.classification);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER types_check_change
  BEFORE UPDATE ON objects.types
  FOR EACH ROW EXECUTE FUNCTION objects.check_type_change();
--> statement-breakpoint
CREATE FUNCTION objects.check_record() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE floor_class text;
BEGIN
  SELECT t.classification INTO floor_class
    FROM objects.types t
   WHERE t.organization_id = NEW.organization_id AND t.id = NEW.type_id;
  IF NOT FOUND
     OR app.classification_rank(NEW.classification) < app.classification_rank(floor_class) THEN
    RAISE EXCEPTION 'OBJECT_RECORD_BELOW_TYPE' USING ERRCODE = 'EN403';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER records_check
  BEFORE INSERT OR UPDATE ON objects.records
  FOR EACH ROW EXECUTE FUNCTION objects.check_record();
--> statement-breakpoint

-- Packs. Nothing activates while anything it asks for is undecided, whoever is asking (AGENT-14).
GRANT SELECT, INSERT ON packs.installations TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, version, activated_by_membership_id, updated_at, activated_at)
  ON packs.installations TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON packs.capability_reviews TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (decision, decided_by_membership_id, decided_at) ON packs.capability_reviews TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON packs.installed_items TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION packs.check_installation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reviewing' OR NEW.version <> 1 OR NEW.activated_at IS NOT NULL THEN
      RAISE EXCEPTION 'PACK_INVALID_START' USING ERRCODE = 'EN401';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'reviewing' AND NEW.status IN ('active','cancelled'))
       OR (OLD.status = 'active' AND NEW.status IN ('superseded','rolled_back'))
       OR (OLD.status = 'superseded' AND NEW.status = 'active')
     ) THEN
    RAISE EXCEPTION 'PACK_INVALID_TRANSITION' USING ERRCODE = 'EN401';
  END IF;
  IF NEW.status = 'active' AND OLD.status <> 'active' THEN
    IF NEW.activated_by_membership_id IS NULL THEN
      RAISE EXCEPTION 'PACK_NEEDS_A_PERSON' USING ERRCODE = 'EN404';
    END IF;
    IF EXISTS (
      SELECT 1 FROM packs.capability_reviews r
       WHERE r.organization_id = NEW.organization_id
         AND r.installation_id = NEW.id
         AND r.decision = 'pending'
    ) THEN
      RAISE EXCEPTION 'PACK_CAPABILITY_UNREVIEWED' USING ERRCODE = 'EN404';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER installations_check
  BEFORE INSERT OR UPDATE ON packs.installations
  FOR EACH ROW EXECUTE FUNCTION packs.check_installation();
--> statement-breakpoint
CREATE TRIGGER installations_keep
  BEFORE DELETE OR TRUNCATE ON packs.installations
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- Experience. A dismissal belongs to the person who made it, so one colleague cannot silence a signal for
-- another. Restrictive, so this applies on top of the tenant policy and not instead of it.
GRANT SELECT, INSERT, UPDATE, DELETE ON experience.pulse_signal_states TO ensemus_app;
--> statement-breakpoint
CREATE POLICY pulse_signal_states_own ON experience.pulse_signal_states AS RESTRICTIVE TO ensemus_app
  USING (membership_id IN (
    SELECT m.id FROM org.memberships m
     WHERE m.organization_id = app.current_organization_id() AND m.user_id = app.current_user_id()
  ))
  WITH CHECK (membership_id IN (
    SELECT m.id FROM org.memberships m
     WHERE m.organization_id = app.current_organization_id() AND m.user_id = app.current_user_id()
  ));
--> statement-breakpoint

GRANT SELECT, INSERT ON experience.outcome_drafts TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (objective, preview, preview_sha256, status, work_unit_id, authorized_by_membership_id,
              authorized_at, version, updated_at)
  ON experience.outcome_drafts TO ensemus_app;
--> statement-breakpoint
-- What was authorized stays as it was authorized.
CREATE FUNCTION experience.check_outcome_draft() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.work_unit_id IS NOT NULL THEN
      RAISE EXCEPTION 'OUTCOME_INVALID_START' USING ERRCODE = 'EN401';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'OUTCOME_FINISHED' USING ERRCODE = 'EN401';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER outcome_drafts_check
  BEFORE INSERT OR UPDATE ON experience.outcome_drafts
  FOR EACH ROW EXECUTE FUNCTION experience.check_outcome_draft();
--> statement-breakpoint

GRANT SELECT, INSERT ON experience.onboarding_steps TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by_membership_id, decided_at) ON experience.onboarding_steps TO ensemus_app;
