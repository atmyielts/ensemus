-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-028). Changes here need human review, never agent approval.
-- Status: proposed. ADR-028 FD-3, FD-4 and FD-10 need outside security review before any real credential
-- is stored. Nothing in this file creates a role: ensemus_migrator has no CREATEROLE, and provision.sql
-- only runs on an empty data directory. See ADR-028 under "Role provisioning".

-- Stops here, with a message that says what to do, rather than failing later on a confusing GRANT.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ensemus_agent') THEN
    RAISE EXCEPTION 'ROLE_MISSING: ensemus_agent does not exist. Run the role provisioning step in ADR-028 as a superuser, then migrate again.';
  END IF;
  IF NOT pg_has_role('ensemus_agent', 'ensemus_app', 'MEMBER') THEN
    RAISE EXCEPTION 'ROLE_MISSING: ensemus_agent must be a member of ensemus_app. Run the role provisioning step in ADR-028 as a superuser, then migrate again.';
  END IF;
  IF (SELECT rolsuper OR rolcreaterole OR rolbypassrls FROM pg_roles WHERE rolname = 'ensemus_agent') THEN
    RAISE EXCEPTION 'ROLE_UNSAFE: ensemus_agent must have no SUPERUSER, CREATEROLE or BYPASSRLS.';
  END IF;
END $$;
--> statement-breakpoint

-- Forced RLS on every new table. A test fails if one misses it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname = 'ai'
       OR (schemaname = 'org' AND tablename = 'service_identities')
       OR (schemaname = 'work' AND tablename = 'agent_assignments')
       OR (schemaname = 'platform' AND tablename IN ('budgets','budget_reservations','usage_ledger','entitlements'))
       OR (schemaname = 'governance' AND tablename IN ('egress_decisions','policy_bundles','kill_switches'))
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    -- Prompts have a policy of their own below, and kill switches may have no tenant.
    IF t.tablename NOT IN ('step_payloads','kill_switches') THEN
      EXECUTE format(
        'CREATE POLICY tenant_scoped ON %I.%I TO ensemus_app '
        'USING (organization_id = app.current_organization_id()) '
        'WITH CHECK (organization_id = app.current_organization_id())',
        t.schemaname, t.tablename);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- The agent role is a member of ensemus_app, so every policy above applies to it and it has every grant
-- below. On top of that it alone can reach prompts, usage writes and egress decisions (FD-4). Web and the
-- base worker keep ensemus_app, so they can never read a prompt or forge a receipt. The dispatcher and
-- the secrets role get nothing here.
GRANT USAGE ON SCHEMA ai TO ensemus_app;
--> statement-breakpoint

-- Service identities.
GRANT SELECT, INSERT ON org.service_identities TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status) ON org.service_identities TO ensemus_app;
--> statement-breakpoint

-- Model profiles. `provider_kind` is fixed once written. `version` is the trigger's, and only the agent
-- role can write `qualified_at`, after a probe.
GRANT SELECT, INSERT ON ai.model_profiles TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (model_id, alias, endpoint_url, secret_ref, billing_owner, region, capabilities, limits,
              allowed_classes, allowed_purposes, retention_basis, contract_ref, fallback_profile_ids,
              cross_billing_approved_by_membership_id, status, probe_requested_by_membership_id,
              updated_at)
  ON ai.model_profiles TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, qualified_at, updated_at) ON ai.model_profiles TO ensemus_agent;
--> statement-breakpoint
GRANT SELECT, INSERT ON ai.rate_cards TO ensemus_app;
--> statement-breakpoint
GRANT SELECT ON ai.model_evaluations TO ensemus_app;
--> statement-breakpoint
GRANT INSERT ON ai.model_evaluations TO ensemus_agent;
--> statement-breakpoint

-- Agents. A published version has no UPDATE or DELETE grant for anyone, and a trigger as well.
GRANT SELECT, INSERT ON ai.agent_definitions TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (name) ON ai.agent_definitions TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON ai.agent_versions TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON ai.agent_publications TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (active_until) ON ai.agent_publications TO ensemus_app;
--> statement-breakpoint

-- Runs. Web starts a run and may do one thing to it: the base worker's upkeep, which shares this role,
-- closes a run whose workflow has gone, and the trigger allows nothing else. Limits and scopes have no
-- UPDATE grant at all, so a run cannot raise its own.
GRANT SELECT, INSERT ON ai.agent_runs TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, stop_code, ended_at, updated_at, version) ON ai.agent_runs TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (effective_classification, bound_profile_id, bound_profile_version, model_turns,
              tool_calls, input_tokens, output_tokens, cost_micros, active_ms, temporal_run_id,
              started_at)
  ON ai.agent_runs TO ensemus_agent;
--> statement-breakpoint
GRANT SELECT, INSERT ON ai.run_controls TO ensemus_app;
--> statement-breakpoint
GRANT SELECT ON ai.execution_steps TO ensemus_app;
--> statement-breakpoint
GRANT INSERT ON ai.execution_steps TO ensemus_agent;
--> statement-breakpoint
GRANT UPDATE (state, outcome, label_code, decision_code, attempt, ended_at)
  ON ai.execution_steps TO ensemus_agent;
--> statement-breakpoint

-- Prompts and answers. Not one grant to ensemus_app, and the policy names the agent role alone, so a
-- bug in a web page cannot read this even with a tenant bound (FD-5).
GRANT SELECT, INSERT, DELETE ON ai.step_payloads TO ensemus_agent;
--> statement-breakpoint
CREATE POLICY step_payloads_agent ON ai.step_payloads TO ensemus_agent
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

GRANT SELECT ON ai.tool_proposals TO ensemus_app;
--> statement-breakpoint
GRANT INSERT ON ai.tool_proposals TO ensemus_agent;
--> statement-breakpoint
GRANT UPDATE (approval_id, external_action_id, status, decision_code, updated_at)
  ON ai.tool_proposals TO ensemus_agent;
--> statement-breakpoint
GRANT SELECT ON ai.artifact_evidence TO ensemus_app;
--> statement-breakpoint
GRANT INSERT ON ai.artifact_evidence TO ensemus_agent;
--> statement-breakpoint
GRANT SELECT ON work.agent_assignments TO ensemus_app;
--> statement-breakpoint
GRANT INSERT, DELETE ON work.agent_assignments TO ensemus_agent;
--> statement-breakpoint

-- Money. A person sets a limit, and only the agent role moves what is reserved and spent.
GRANT SELECT, INSERT ON platform.budgets TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (limit_micros, updated_at) ON platform.budgets TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (reserved_micros, spent_micros) ON platform.budgets TO ensemus_agent;
--> statement-breakpoint
GRANT SELECT ON platform.budget_reservations TO ensemus_app;
--> statement-breakpoint
GRANT INSERT ON platform.budget_reservations TO ensemus_agent;
--> statement-breakpoint
GRANT UPDATE (status, settled_at) ON platform.budget_reservations TO ensemus_agent;
--> statement-breakpoint
GRANT SELECT ON platform.usage_ledger TO ensemus_app;
--> statement-breakpoint
GRANT INSERT ON platform.usage_ledger TO ensemus_agent;
--> statement-breakpoint
GRANT SELECT ON platform.entitlements TO ensemus_app;
--> statement-breakpoint

-- Governance.
GRANT SELECT ON governance.egress_decisions TO ensemus_app;
--> statement-breakpoint
GRANT INSERT ON governance.egress_decisions TO ensemus_agent;
--> statement-breakpoint
GRANT SELECT, INSERT ON governance.policy_bundles TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (active) ON governance.policy_bundles TO ensemus_app;
--> statement-breakpoint

-- Kill switches. Every tenant can read an operator's switch, because each one has to obey it, and none
-- can write or release one. The migrator role owns the table, and forced RLS confines it to rows with no
-- tenant, so the operator's command can reach no tenant's switch.
GRANT SELECT, INSERT ON governance.kill_switches TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (released_at, released_by_membership_id) ON governance.kill_switches TO ensemus_app;
--> statement-breakpoint
CREATE POLICY kill_switches_read ON governance.kill_switches FOR SELECT TO ensemus_app
  USING (organization_id IS NULL OR organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY kill_switches_tenant_insert ON governance.kill_switches FOR INSERT TO ensemus_app
  WITH CHECK (organization_id = app.current_organization_id()
              AND scope IN ('organization','agent_version'));
--> statement-breakpoint
CREATE POLICY kill_switches_tenant_release ON governance.kill_switches FOR UPDATE TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY kill_switches_operator ON governance.kill_switches TO ensemus_migrator
  USING (organization_id IS NULL)
  WITH CHECK (organization_id IS NULL);
--> statement-breakpoint

-- Records, kept as written, for everyone including the owner. `app.reject_change` is from migration 0003.
CREATE TRIGGER usage_ledger_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.usage_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER egress_decisions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON governance.egress_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER agent_versions_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.agent_versions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER rate_cards_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.rate_cards
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER run_controls_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.run_controls
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER model_evaluations_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.model_evaluations
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER agent_runs_keep
  BEFORE DELETE OR TRUNCATE ON ai.agent_runs
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER kill_switches_keep
  BEFORE DELETE OR TRUNCATE ON governance.kill_switches
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- A new profile starts as a draft that has never been tested.
CREATE FUNCTION ai.check_new_model_profile() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.qualified_at IS NOT NULL OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'MODEL_PROFILE_INVALID_START' USING ERRCODE = 'EN006';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER model_profiles_check_new
  BEFORE INSERT ON ai.model_profiles
  FOR EACH ROW EXECUTE FUNCTION ai.check_new_model_profile();
--> statement-breakpoint

-- FD-10. The sealed key's purpose already names the profile and endpoint, so a tampered row cannot make
-- the broker open it. This is the same rule for an honest edit: a new address means the old key is gone,
-- and it is a draft again. A new key or model means testing again. Anything else a pinned run has to
-- notice bumps the version, which stops that run at its next turn (FD-13, BYOM-TS-01).
CREATE FUNCTION ai.check_model_profile_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  must_retest boolean;
  policy_changed boolean;
BEGIN
  must_retest := NEW.endpoint_url IS DISTINCT FROM OLD.endpoint_url
              OR NEW.secret_ref IS DISTINCT FROM OLD.secret_ref
              OR NEW.model_id IS DISTINCT FROM OLD.model_id;
  policy_changed := must_retest
              OR NEW.billing_owner IS DISTINCT FROM OLD.billing_owner
              OR NEW.region IS DISTINCT FROM OLD.region
              OR NEW.capabilities IS DISTINCT FROM OLD.capabilities
              OR NEW.limits IS DISTINCT FROM OLD.limits
              OR NEW.allowed_classes IS DISTINCT FROM OLD.allowed_classes
              OR NEW.allowed_purposes IS DISTINCT FROM OLD.allowed_purposes
              OR NEW.retention_basis IS DISTINCT FROM OLD.retention_basis
              OR NEW.contract_ref IS DISTINCT FROM OLD.contract_ref
              OR NEW.fallback_profile_ids IS DISTINCT FROM OLD.fallback_profile_ids
              OR NEW.cross_billing_approved_by_membership_id
                 IS DISTINCT FROM OLD.cross_billing_approved_by_membership_id;

  IF NEW.endpoint_url IS DISTINCT FROM OLD.endpoint_url THEN
    NEW.secret_ref := NULL;
  END IF;
  IF must_retest THEN
    NEW.status := 'draft';
    NEW.qualified_at := NULL;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (CASE OLD.status
      WHEN 'draft' THEN NEW.status IN ('probing','disabled')
      WHEN 'probing' THEN NEW.status IN ('active','probe_failed','draft','disabled')
      WHEN 'probe_failed' THEN NEW.status IN ('probing','draft','disabled')
      WHEN 'active' THEN NEW.status IN ('probing','disabled','draft')
      WHEN 'disabled' THEN NEW.status IN ('probing','draft')
      ELSE false
    END) THEN
      RAISE EXCEPTION 'MODEL_PROFILE_INVALID_TRANSITION' USING ERRCODE = 'EN006';
    END IF;
    -- A probe's result is the agent role's to write, so web can never declare a profile good.
    IF NEW.status IN ('active','probe_failed') AND current_user <> 'ensemus_agent' THEN
      RAISE EXCEPTION 'MODEL_PROFILE_PROBE_REQUIRED' USING ERRCODE = 'EN006';
    END IF;
    IF NEW.status = 'active' AND NEW.qualified_at IS NULL THEN
      RAISE EXCEPTION 'MODEL_PROFILE_PROBE_REQUIRED' USING ERRCODE = 'EN006';
    END IF;
    IF OLD.status = 'active' THEN
      NEW.qualified_at := CASE WHEN NEW.status = 'active' THEN NEW.qualified_at ELSE NULL END;
    END IF;
  END IF;
  IF policy_changed THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER model_profiles_check_change
  BEFORE UPDATE ON ai.model_profiles
  FOR EACH ROW EXECUTE FUNCTION ai.check_model_profile_change();
--> statement-breakpoint

CREATE FUNCTION ai.classification_rank(class text) RETURNS integer
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT array_position(ARRAY['public','internal','confidential','restricted'], class) $$;
--> statement-breakpoint

-- A run starts queued, with nothing spent. A child can only ever have less than its parent: the same
-- initiator, one level deeper, no more money, no extra tools. The application checks this too, and says
-- so properly. This is what holds if it does not.
CREATE FUNCTION ai.check_new_agent_run() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE parent record;
BEGIN
  IF NEW.status <> 'queued' OR NEW.stop_code IS NOT NULL OR NEW.version <> 1
     OR NEW.model_turns <> 0 OR NEW.tool_calls <> 0 OR NEW.input_tokens <> 0
     OR NEW.output_tokens <> 0 OR NEW.cost_micros <> 0 OR NEW.active_ms <> 0
     OR NEW.temporal_run_id IS NOT NULL OR NEW.bound_profile_id IS NOT NULL
     OR NEW.bound_profile_version IS NOT NULL OR NEW.started_at IS NOT NULL
     OR NEW.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'AGENT_RUN_INVALID_START' USING ERRCODE = 'EN006';
  END IF;
  IF jsonb_typeof(NEW.delegated_scopes -> 'tools') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'AGENT_RUN_INVALID_START' USING ERRCODE = 'EN006';
  END IF;
  IF NEW.parent_run_id IS NULL THEN
    IF NEW.depth <> 0 THEN
      RAISE EXCEPTION 'AGENT_RUN_INVALID_START' USING ERRCODE = 'EN006';
    END IF;
    RETURN NEW;
  END IF;
  SELECT r.depth, r.initiator_membership_id, r.max_cost_micros, r.max_delegation_depth,
         r.delegated_scopes, r.effective_classification, r.status
    INTO parent
    FROM ai.agent_runs r
   WHERE r.organization_id = NEW.organization_id AND r.id = NEW.parent_run_id;
  IF NOT FOUND
     OR NEW.depth <> parent.depth + 1
     OR parent.max_delegation_depth < 1
     OR NEW.max_delegation_depth > parent.max_delegation_depth - 1
     OR NEW.initiator_membership_id <> parent.initiator_membership_id
     OR NEW.max_cost_micros > parent.max_cost_micros
     OR NOT ((NEW.delegated_scopes -> 'tools') <@ (parent.delegated_scopes -> 'tools'))
     OR ai.classification_rank(NEW.effective_classification)
        < ai.classification_rank(parent.effective_classification)
     OR parent.status IN ('completed','failed','cancelled','budget_exhausted','policy_denied',
                          'timed_out','outcome_unverified') THEN
    RAISE EXCEPTION 'AGENT_RUN_DELEGATION_WIDENED' USING ERRCODE = 'EN006';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_runs_check_new
  BEFORE INSERT ON ai.agent_runs
  FOR EACH ROW EXECUTE FUNCTION ai.check_new_agent_run();
--> statement-breakpoint

-- The state machine, matching AGENT_RUN_TRANSITIONS in @ensemus/domain/ai, and a test holds the two
-- together. Counters only rise and a class only rises. A run binds to one profile, once. The app role
-- may do one thing, which is close a run whose workflow is gone: see ADR-028 under "Stranded runs".
CREATE FUNCTION ai.check_agent_run_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE allowed boolean;
BEGIN
  IF current_user = 'ensemus_app' AND NOT (NEW.status = 'failed' AND NEW.stop_code = 'STRANDED') THEN
    RAISE EXCEPTION 'AGENT_RUN_NOT_YOURS' USING ERRCODE = 'EN006';
  END IF;
  IF NEW.model_turns < OLD.model_turns OR NEW.tool_calls < OLD.tool_calls
     OR NEW.input_tokens < OLD.input_tokens OR NEW.output_tokens < OLD.output_tokens
     OR NEW.cost_micros < OLD.cost_micros OR NEW.active_ms < OLD.active_ms THEN
    RAISE EXCEPTION 'AGENT_RUN_COUNTER_FELL' USING ERRCODE = 'EN006';
  END IF;
  IF ai.classification_rank(NEW.effective_classification)
     < ai.classification_rank(OLD.effective_classification) THEN
    RAISE EXCEPTION 'AGENT_RUN_CLASS_FELL' USING ERRCODE = 'EN006';
  END IF;
  IF OLD.bound_profile_id IS NOT NULL
     AND (NEW.bound_profile_id IS DISTINCT FROM OLD.bound_profile_id
          OR NEW.bound_profile_version IS DISTINCT FROM OLD.bound_profile_version) THEN
    RAISE EXCEPTION 'AGENT_RUN_ALREADY_BOUND' USING ERRCODE = 'EN006';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'queued' THEN NEW.status IN ('preparing','failed','cancelled','budget_exhausted','policy_denied','timed_out')
      WHEN 'preparing' THEN NEW.status IN ('running','failed','cancelled','budget_exhausted','policy_denied','timed_out')
      WHEN 'running' THEN NEW.status IN ('paused','waiting_for_approval','waiting_for_child','verifying','outcome_unverified','failed','cancelled','budget_exhausted','policy_denied','timed_out')
      WHEN 'paused' THEN NEW.status IN ('running','failed','cancelled','budget_exhausted','policy_denied','timed_out')
      WHEN 'waiting_for_approval' THEN NEW.status IN ('running','paused','outcome_unverified','failed','cancelled','budget_exhausted','policy_denied','timed_out')
      WHEN 'waiting_for_child' THEN NEW.status IN ('running','paused','failed','cancelled','budget_exhausted','policy_denied','timed_out')
      WHEN 'verifying' THEN NEW.status IN ('completed','outcome_unverified','failed','cancelled','budget_exhausted','policy_denied','timed_out')
      ELSE false
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'AGENT_RUN_INVALID_TRANSITION' USING ERRCODE = 'EN006';
    END IF;
    IF NEW.status IN ('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified') THEN
      NEW.ended_at := coalesce(NEW.ended_at, now());
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_runs_check_change
  BEFORE UPDATE ON ai.agent_runs
  FOR EACH ROW EXECUTE FUNCTION ai.check_agent_run_change();
--> statement-breakpoint

-- ADR-024's "every side effect rechecks PostgreSQL immediately beforehand", for an effect an agent asked
-- for. M3 sends it on its own workflow, and its recheck knows nothing of runs or kill switches. This holds
-- at the same point it commits an attempt, below all application code. A failure here rolls the attempt
-- back, so nothing was sent (ADR-027 D2). Actions no agent proposed are untouched.
CREATE FUNCTION ai.check_attempt_for_agent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  run record;
  halted boolean;
BEGIN
  SELECT r.id, r.status, r.agent_version_id, r.initiator_membership_id INTO run
    FROM ai.tool_proposals p
    JOIN ai.agent_runs r ON r.organization_id = p.organization_id AND r.id = p.run_id
   WHERE p.organization_id = NEW.organization_id AND p.external_action_id = NEW.external_action_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF run.status NOT IN ('running','waiting_for_approval') THEN
    RAISE EXCEPTION 'AGENT_RUN_NOT_RUNNING' USING ERRCODE = 'EN007';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM org.memberships m
     WHERE m.organization_id = NEW.organization_id
       AND m.id = run.initiator_membership_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'AGENT_INITIATOR_INACTIVE' USING ERRCODE = 'EN007';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM governance.kill_switches k
     WHERE k.released_at IS NULL
       AND (k.scope = 'global'
            OR (k.scope = 'organization' AND k.organization_id = NEW.organization_id)
            OR (k.scope = 'agent_version' AND k.organization_id = NEW.organization_id
                AND k.target_ref = run.agent_version_id::text))
  ) INTO halted;
  IF halted THEN
    RAISE EXCEPTION 'AGENT_HALTED' USING ERRCODE = 'EN007';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER external_action_attempts_check_agent
  BEFORE INSERT ON integrations.external_action_attempts
  FOR EACH ROW EXECUTE FUNCTION ai.check_attempt_for_agent();
--> statement-breakpoint

-- A switch is released once, and a release is never taken back. Engaging again is a new row.
CREATE FUNCTION governance.check_kill_switch_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'KILL_SWITCH_ALREADY_RELEASED' USING ERRCODE = 'EN006';
  END IF;
  IF NEW.id <> OLD.id OR NEW.scope <> OLD.scope
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.target_ref IS DISTINCT FROM OLD.target_ref
     OR NEW.reason_code <> OLD.reason_code
     OR NEW.engaged_at <> OLD.engaged_at THEN
    RAISE EXCEPTION 'KILL_SWITCH_IMMUTABLE' USING ERRCODE = 'EN006';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER kill_switches_check_change
  BEFORE UPDATE ON governance.kill_switches
  FOR EACH ROW EXECUTE FUNCTION governance.check_kill_switch_change();
