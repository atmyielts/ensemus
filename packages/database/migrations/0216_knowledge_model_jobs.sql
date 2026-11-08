-- Explicit, bounded standalone model authority. No provider credential or company text in metadata.
-- Source-only until the joined real-role/security gate. The agent role still has no BYPASSRLS.
CREATE FUNCTION ai.valid_model_bounds(calls integer, input_tokens integer, output_tokens integer,
  total_tokens bigint, cost_micros bigint, timeout_seconds integer) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(calls between 1 and 1000 and input_tokens>0
  and output_tokens>0 and total_tokens>=input_tokens and total_tokens>=output_tokens
  and total_tokens<=9007199254740991 and cost_micros between 0 and 9007199254740991
  and timeout_seconds between 1 and 86400,false) $$;
REVOKE ALL ON FUNCTION ai.valid_model_bounds(integer,integer,integer,bigint,bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.valid_model_bounds(integer,integer,integer,bigint,bigint,integer) TO ensemus_app;
--> statement-breakpoint
CREATE TABLE ai.model_operation_qualifications (
  organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL,profile_version integer NOT NULL,purpose text NOT NULL,protocol text NOT NULL,
  dimension integer,vector_space_version text,state text NOT NULL DEFAULT 'requested',
  requested_by_membership_id uuid NOT NULL,request_key uuid NOT NULL,max_calls integer NOT NULL,
  max_input_tokens integer NOT NULL,max_output_tokens integer NOT NULL,max_total_tokens bigint NOT NULL,
  max_cost_micros bigint NOT NULL,timeout_seconds integer NOT NULL,result_digest text,
  qualified_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_operation_qualifications_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT model_qualifications_org_fk FOREIGN KEY(organization_id) REFERENCES org.organizations(id),
  CONSTRAINT model_operation_qualifications_profile_fk FOREIGN KEY(organization_id,profile_id) REFERENCES ai.model_profiles(organization_id,id),
  CONSTRAINT model_operation_qualifications_requester_fk FOREIGN KEY(organization_id,requested_by_membership_id) REFERENCES org.memberships(organization_id,id),
  CONSTRAINT model_operation_qualifications_request_key UNIQUE(organization_id,requested_by_membership_id,request_key),
  CONSTRAINT model_operation_qualifications_state CHECK(state in('requested','passed','failed')),
  CONSTRAINT model_operation_qualifications_shape CHECK(
    (purpose='embed' and protocol='native_embedding_v1' and dimension is not null and dimension between 1 and 8192 and vector_space_version is not null and char_length(vector_space_version) between 1 and 256)
    or(purpose='rerank' and protocol='structured_ranking_v1' and dimension is null and vector_space_version is null)
    or(purpose='answer' and protocol='text_answer_v1' and dimension is null and vector_space_version is null)),
  CONSTRAINT model_operation_qualifications_receipt CHECK((state='passed')=(qualified_at is not null) and(result_digest is null or result_digest ~ '^[0-9a-f]{64}$')),
  CONSTRAINT model_operation_qualifications_bounds CHECK(ai.valid_model_bounds(max_calls,max_input_tokens,max_output_tokens,max_total_tokens,max_cost_micros,timeout_seconds) and max_calls=1)
);
CREATE INDEX model_operation_qualifications_profile_idx ON ai.model_operation_qualifications(organization_id,profile_id,profile_version,purpose);
--> statement-breakpoint
CREATE TABLE ai.model_workload_approvals (
  organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,scope text NOT NULL,source_id uuid,connection_id uuid,purposes text[] NOT NULL,
  max_classification text NOT NULL,max_calls integer NOT NULL,max_input_tokens integer NOT NULL,
  max_output_tokens integer NOT NULL,max_total_tokens bigint NOT NULL,max_cost_micros bigint NOT NULL,
  timeout_seconds integer NOT NULL,approved_by_membership_id uuid NOT NULL,request_key uuid NOT NULL,
  expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_workload_approvals_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT model_workload_approvals_org_fk FOREIGN KEY(organization_id) REFERENCES org.organizations(id),
  CONSTRAINT model_workload_approvals_source_fk FOREIGN KEY(organization_id,source_id) REFERENCES knowledge.sources(organization_id,id),
  CONSTRAINT model_workload_approvals_connection_fk FOREIGN KEY(organization_id,connection_id) REFERENCES integrations.connections(organization_id,id),
  CONSTRAINT model_workload_approvals_approver_fk FOREIGN KEY(organization_id,approved_by_membership_id) REFERENCES org.memberships(organization_id,id),
  CONSTRAINT model_workload_approvals_request_key UNIQUE(organization_id,approved_by_membership_id,request_key),
  CONSTRAINT model_workload_approvals_kind CHECK(kind in('document_embed','query','answer','agent_context')),
  CONSTRAINT model_workload_approvals_purposes CHECK(cardinality(purposes) between 1 and 3 and purposes <@ array['embed','rerank','answer']::text[]),
  CONSTRAINT model_workload_approvals_scope CHECK(
    (scope='organization' and kind<>'document_embed' and source_id is null and connection_id is null)
    or(scope='source' and kind='document_embed' and source_id is not null and connection_id is null)
    or(scope='connection' and kind='document_embed' and source_id is null and connection_id is not null)),
  CONSTRAINT model_workload_approvals_class CHECK(max_classification in('public','internal','confidential','restricted')),
  CONSTRAINT model_workload_approvals_bounds CHECK(ai.valid_model_bounds(max_calls,max_input_tokens,max_output_tokens,max_total_tokens,max_cost_micros,timeout_seconds))
);
CREATE TABLE ai.model_workload_profiles (
  organization_id uuid NOT NULL,approval_id uuid NOT NULL,qualification_id uuid NOT NULL,
  CONSTRAINT model_workload_profiles_pk PRIMARY KEY(organization_id,approval_id,qualification_id),
  CONSTRAINT model_workload_profiles_approval_fk FOREIGN KEY(organization_id,approval_id) REFERENCES ai.model_workload_approvals(organization_id,id),
  CONSTRAINT model_workload_profiles_qualification_fk FOREIGN KEY(organization_id,qualification_id) REFERENCES ai.model_operation_qualifications(organization_id,id)
);
--> statement-breakpoint
CREATE TABLE ai.model_jobs (
  organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),
  requester_membership_id uuid NOT NULL,approval_id uuid,qualification_id uuid,kind text NOT NULL,
  document_id uuid,answer_id uuid,request_key uuid NOT NULL,request_hash text NOT NULL,classification text NOT NULL,
  max_calls integer NOT NULL,max_input_tokens integer NOT NULL,max_output_tokens integer NOT NULL,
  max_total_tokens bigint NOT NULL,max_cost_micros bigint NOT NULL,timeout_seconds integer NOT NULL,
  state text NOT NULL DEFAULT 'prepared',deadline_at timestamptz NOT NULL,calls integer NOT NULL DEFAULT 0,
  reserved_micros bigint NOT NULL DEFAULT 0,spent_micros bigint NOT NULL DEFAULT 0,
  reserved_tokens bigint NOT NULL DEFAULT 0,used_tokens bigint NOT NULL DEFAULT 0,fenced_at timestamptz,
  fence_generation integer NOT NULL DEFAULT 0,payloads_purged_at timestamptz,purged_fence_generation integer,
  refusal_code text,result_package_id uuid,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
  CONSTRAINT model_jobs_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT model_jobs_org_fk FOREIGN KEY(organization_id) REFERENCES org.organizations(id),
  CONSTRAINT model_jobs_requester_fk FOREIGN KEY(organization_id,requester_membership_id) REFERENCES org.memberships(organization_id,id),
  CONSTRAINT model_jobs_approval_fk FOREIGN KEY(organization_id,approval_id) REFERENCES ai.model_workload_approvals(organization_id,id),
  CONSTRAINT model_jobs_qualification_fk FOREIGN KEY(organization_id,qualification_id) REFERENCES ai.model_operation_qualifications(organization_id,id),
  CONSTRAINT model_jobs_request_key UNIQUE(organization_id,requester_membership_id,request_key),
  CONSTRAINT model_jobs_shape CHECK(
    (kind='qualification' and qualification_id is not null and approval_id is null and document_id is null and answer_id is null)
    or(kind='document_embed' and approval_id is not null and qualification_id is null and document_id is not null and answer_id is null)
    or(kind='answer' and approval_id is not null and qualification_id is null and document_id is null and answer_id is not null)
    or(kind='query' and approval_id is not null and qualification_id is null and document_id is null and answer_id is null)),
  CONSTRAINT model_jobs_state CHECK(state in('prepared','running','completed','refused','fenced')),
  CONSTRAINT model_jobs_hash CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT model_jobs_class CHECK(classification in('public','internal','confidential','restricted')),
  CONSTRAINT model_jobs_counters CHECK(calls>=0 and reserved_micros>=0 and spent_micros>=0 and reserved_tokens>=0 and used_tokens>=0),
  CONSTRAINT model_jobs_payload_receipt CHECK(((fenced_at is null and fence_generation=0)or(fenced_at is not null and fence_generation=1))
    and((payloads_purged_at is null and purged_fence_generation is null)or(payloads_purged_at is not null and purged_fence_generation is not null and purged_fence_generation=fence_generation and fence_generation=1))),
  CONSTRAINT model_jobs_refusal_code CHECK(refusal_code is null or refusal_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT model_jobs_bounds CHECK(ai.valid_model_bounds(max_calls,max_input_tokens,max_output_tokens,max_total_tokens,max_cost_micros,timeout_seconds))
);
CREATE INDEX model_jobs_active_idx ON ai.model_jobs(organization_id,state,deadline_at);
CREATE UNIQUE INDEX model_jobs_one_qualification ON ai.model_jobs(organization_id,qualification_id) WHERE qualification_id is not null;
CREATE UNIQUE INDEX model_jobs_one_answer ON ai.model_jobs(organization_id,answer_id) WHERE answer_id is not null;
CREATE UNIQUE INDEX model_jobs_one_document_approval ON ai.model_jobs(organization_id,document_id,approval_id) WHERE kind='document_embed';
--> statement-breakpoint
CREATE TABLE ai.model_call_attempts (
  organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid,run_id uuid,step_id uuid,operation_key text NOT NULL,request_hash text NOT NULL,input_inventory_hash text NOT NULL,purpose text NOT NULL,
  profile_id uuid NOT NULL,profile_version integer NOT NULL,qualification_id uuid NOT NULL,approval_id uuid,
  classification text NOT NULL,policy_version text NOT NULL,rate_card_id uuid NOT NULL,rate_card_version integer NOT NULL,
  commercial_mode text NOT NULL,billing_owner text NOT NULL,billing_period text NOT NULL,
  max_input_tokens integer NOT NULL,max_output_tokens integer NOT NULL,reserved_micros bigint NOT NULL,
  state text NOT NULL DEFAULT 'prepared',input_tokens bigint,output_tokens bigint,cost_micros bigint,status text,
  reason_code text,result_kind text,result_id uuid,created_at timestamptz NOT NULL DEFAULT now(),dispatched_at timestamptz,received_at timestamptz,accepted_at timestamptz,
  CONSTRAINT model_call_attempts_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT model_call_attempts_org_fk FOREIGN KEY(organization_id) REFERENCES org.organizations(id),
  CONSTRAINT model_call_attempts_job_fk FOREIGN KEY(organization_id,job_id) REFERENCES ai.model_jobs(organization_id,id),
  CONSTRAINT model_call_attempts_run_fk FOREIGN KEY(organization_id,run_id) REFERENCES ai.agent_runs(organization_id,id),
  CONSTRAINT model_call_attempts_step_fk FOREIGN KEY(organization_id,step_id) REFERENCES ai.execution_steps(organization_id,id),
  CONSTRAINT model_call_attempts_profile_fk FOREIGN KEY(organization_id,profile_id) REFERENCES ai.model_profiles(organization_id,id),
  CONSTRAINT model_call_attempts_qualification_fk FOREIGN KEY(organization_id,qualification_id) REFERENCES ai.model_operation_qualifications(organization_id,id),
  CONSTRAINT model_call_attempts_approval_fk FOREIGN KEY(organization_id,approval_id) REFERENCES ai.model_workload_approvals(organization_id,id),
  CONSTRAINT model_call_attempts_rate_fk FOREIGN KEY(organization_id,rate_card_id) REFERENCES ai.rate_cards(organization_id,id),
  CONSTRAINT model_call_attempts_principal CHECK((job_id is not null and run_id is null and step_id is null) or(job_id is null and run_id is not null and step_id is not null and approval_id is not null)),
  CONSTRAINT model_call_attempts_purpose CHECK(purpose in('embed','rerank','answer')),
  CONSTRAINT model_call_attempts_state CHECK(state in('prepared','dispatched','response_received','accepted','unknown','refused')),
  CONSTRAINT model_call_attempts_hashes CHECK(operation_key ~ '^[0-9a-f]{64}$' and request_hash ~ '^[0-9a-f]{64}$' and input_inventory_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT model_call_attempts_amounts CHECK(profile_version>0 and rate_card_version>0 and max_input_tokens>=0 and max_output_tokens>=0 and reserved_micros between 0 and 9007199254740991
    and(input_tokens is null or input_tokens between 0 and 9007199254740991) and(output_tokens is null or output_tokens between 0 and 9007199254740991) and(cost_micros is null or cost_micros between 0 and 9007199254740991)),
  CONSTRAINT model_call_attempts_class CHECK(classification in('public','internal','confidential','restricted')),
  CONSTRAINT model_call_attempts_billing CHECK(commercial_mode in('cloud','byom','sovereign') and billing_owner in('customer','ensemus') and billing_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT model_call_attempts_reason CHECK(reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT model_call_attempts_result CHECK((state='accepted' and accepted_at is not null and result_id is not null and result_kind is not null and result_kind in('embeddings','answer','evidence','qualification'))or(state<>'accepted' and accepted_at is null and result_id is null and result_kind is null))
);
CREATE UNIQUE INDEX model_call_attempts_job_key ON ai.model_call_attempts(organization_id,job_id,operation_key) WHERE job_id is not null;
CREATE UNIQUE INDEX model_call_attempts_run_key ON ai.model_call_attempts(organization_id,run_id,step_id,operation_key) WHERE run_id is not null;
--> statement-breakpoint
CREATE TABLE ai.model_call_inputs (
  organization_id uuid NOT NULL,call_id uuid NOT NULL,kind text NOT NULL,input_id uuid NOT NULL,source_id uuid,
  sha256 text NOT NULL,classification text NOT NULL,
  CONSTRAINT model_call_inputs_pk PRIMARY KEY(organization_id,call_id,kind,input_id,sha256),
  CONSTRAINT model_call_inputs_call_fk FOREIGN KEY(organization_id,call_id) REFERENCES ai.model_call_attempts(organization_id,id),
  CONSTRAINT model_call_inputs_source_fk FOREIGN KEY(organization_id,source_id) REFERENCES knowledge.sources(organization_id,id),
  CONSTRAINT model_call_inputs_kind CHECK(kind in('chunk','work_unit','project','client')),
  CONSTRAINT model_call_inputs_source_shape CHECK((kind='chunk')=(source_id is not null)),
  CONSTRAINT model_call_inputs_hash CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT model_call_inputs_class CHECK(classification in('public','internal','confidential','restricted'))
);
CREATE INDEX model_call_inputs_source_idx ON ai.model_call_inputs(organization_id,source_id,call_id);
CREATE TABLE ai.model_job_payloads (
  organization_id uuid NOT NULL,job_id uuid NOT NULL,query text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_job_payloads_pk PRIMARY KEY(organization_id,job_id),
  CONSTRAINT model_job_payloads_job_fk FOREIGN KEY(organization_id,job_id) REFERENCES ai.model_jobs(organization_id,id),
  CONSTRAINT model_job_payloads_size CHECK(octet_length(query) between 1 and 8192)
);
--> statement-breakpoint
ALTER TABLE platform.budget_reservations ALTER COLUMN run_id DROP NOT NULL,ALTER COLUMN step_id DROP NOT NULL;
ALTER TABLE platform.budget_reservations DROP CONSTRAINT budget_reservations_step_key;
ALTER TABLE platform.budget_reservations ADD COLUMN model_job_id uuid,ADD COLUMN model_call_id uuid,
  ADD CONSTRAINT budget_reservations_model_job_fk FOREIGN KEY(organization_id,model_job_id) REFERENCES ai.model_jobs(organization_id,id),
  ADD CONSTRAINT budget_reservations_model_call_fk FOREIGN KEY(organization_id,model_call_id) REFERENCES ai.model_call_attempts(organization_id,id),
  ADD CONSTRAINT budget_reservations_call_key UNIQUE(organization_id,budget_id,model_call_id),
  ADD CONSTRAINT budget_reservations_principal CHECK((model_call_id is null and model_job_id is null and run_id is not null and step_id is not null)
    or(model_call_id is not null and((model_job_id is not null and run_id is null and step_id is null)or(model_job_id is null and run_id is not null and step_id is not null))));
CREATE UNIQUE INDEX budget_reservations_step_key ON platform.budget_reservations(organization_id,budget_id,step_id,attempt) WHERE model_call_id is null;
ALTER TABLE platform.usage_ledger ALTER COLUMN run_id DROP NOT NULL,ALTER COLUMN work_unit_id DROP NOT NULL;
ALTER TABLE platform.usage_ledger ADD COLUMN model_job_id uuid,ADD COLUMN model_call_id uuid,
  ADD CONSTRAINT usage_ledger_model_job_fk FOREIGN KEY(organization_id,model_job_id) REFERENCES ai.model_jobs(organization_id,id),
  ADD CONSTRAINT usage_ledger_model_call_fk FOREIGN KEY(organization_id,model_call_id) REFERENCES ai.model_call_attempts(organization_id,id),
  ADD CONSTRAINT usage_ledger_principal CHECK((model_job_id is null and run_id is not null and work_unit_id is not null)
    or(model_job_id is not null and model_call_id is not null and run_id is null and work_unit_id is null and step_id is null));
CREATE INDEX usage_ledger_model_job_idx ON platform.usage_ledger(organization_id,model_job_id);
--> statement-breakpoint
-- Every new table is forced-RLS. Metadata is tenant-readable like existing egress/usage records.
-- Private query text is deliberately excluded from the metadata grant and all web SELECT policies.
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['model_operation_qualifications','model_workload_approvals','model_workload_profiles','model_jobs','model_call_attempts','model_call_inputs'] LOOP
    EXECUTE format('ALTER TABLE ai.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE ai.%I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY tenant_read ON ai.%I FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id())',target);
  END LOOP;
END $$;
GRANT SELECT ON ai.model_operation_qualifications,ai.model_workload_approvals,ai.model_workload_profiles,ai.model_jobs,ai.model_call_attempts,ai.model_call_inputs TO ensemus_app;
GRANT INSERT ON ai.model_operation_qualifications,ai.model_workload_approvals,ai.model_workload_profiles,ai.model_jobs TO ensemus_app;
GRANT UPDATE(revoked_at) ON ai.model_workload_approvals TO ensemus_app;
GRANT UPDATE(state,result_digest,qualified_at) ON ai.model_operation_qualifications TO ensemus_agent;
GRANT UPDATE(state,calls,reserved_micros,spent_micros,reserved_tokens,used_tokens,fenced_at,fence_generation,payloads_purged_at,purged_fence_generation,refusal_code,result_package_id,finished_at) ON ai.model_jobs TO ensemus_agent;
GRANT UPDATE(state,refusal_code) ON ai.model_jobs TO ensemus_app;
GRANT INSERT ON ai.model_call_attempts,ai.model_call_inputs TO ensemus_agent;
GRANT UPDATE(state,input_tokens,output_tokens,cost_micros,status,reason_code,result_kind,result_id,dispatched_at,received_at,accepted_at) ON ai.model_call_attempts TO ensemus_agent;
--> statement-breakpoint
CREATE POLICY person_request ON ai.model_operation_qualifications FOR INSERT TO ensemus_app WITH CHECK(organization_id=app.current_organization_id() and app.current_actor_type()='user' and requested_by_membership_id=app.current_membership_id());
CREATE POLICY agent_result ON ai.model_operation_qualifications FOR UPDATE TO ensemus_agent USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE POLICY person_approval ON ai.model_workload_approvals FOR INSERT TO ensemus_app WITH CHECK(organization_id=app.current_organization_id() and app.current_actor_type()='user' and approved_by_membership_id=app.current_membership_id());
-- PostgreSQL FOR SHARE also applies UPDATE USING: actual model workers must be able to pin the
-- same tenant metadata already visible to SELECT. Mutation remains actual app-login/user only;
-- guard_model_approval additionally rechecks the current active manager and immutable revoke shape.
CREATE POLICY person_revoke ON ai.model_workload_approvals FOR UPDATE TO ensemus_app
  USING(organization_id=app.current_organization_id())
  WITH CHECK(organization_id=app.current_organization_id() and app.current_actor_type()='user'
    and current_user='ensemus_app' and session_user='ensemus_app');
CREATE POLICY person_profile ON ai.model_workload_profiles FOR INSERT TO ensemus_app WITH CHECK(organization_id=app.current_organization_id() and app.current_actor_type()='user');
CREATE POLICY job_request ON ai.model_jobs FOR INSERT TO ensemus_app WITH CHECK(organization_id=app.current_organization_id());
CREATE POLICY job_agent ON ai.model_jobs FOR UPDATE TO ensemus_agent USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE POLICY job_unclaimed_refusal ON ai.model_jobs FOR UPDATE TO ensemus_app USING(organization_id=app.current_organization_id() and(state='prepared') and(app.current_actor_type()='service' or requester_membership_id=app.current_membership_id())) WITH CHECK(organization_id=app.current_organization_id());
CREATE POLICY call_agent ON ai.model_call_attempts FOR ALL TO ensemus_agent USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE POLICY input_agent ON ai.model_call_inputs FOR INSERT TO ensemus_agent WITH CHECK(organization_id=app.current_organization_id());
ALTER TABLE ai.model_job_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.model_job_payloads FORCE ROW LEVEL SECURITY;
GRANT INSERT ON ai.model_job_payloads TO ensemus_app;
GRANT SELECT,DELETE ON ai.model_job_payloads TO ensemus_agent;
CREATE POLICY query_insert ON ai.model_job_payloads FOR INSERT TO ensemus_app WITH CHECK(organization_id=app.current_organization_id() and app.current_actor_type() in('user','delegated'));
CREATE POLICY query_agent ON ai.model_job_payloads FOR SELECT TO ensemus_agent USING(organization_id=app.current_organization_id());
CREATE POLICY query_purge ON ai.model_job_payloads FOR DELETE TO ensemus_agent USING(organization_id=app.current_organization_id());
--> statement-breakpoint
CREATE FUNCTION ai.model_manager() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_user='ensemus_app' and session_user='ensemus_app'
    and app.current_actor_type()='user' and EXISTS(SELECT 1 FROM org.memberships m
    WHERE m.organization_id=app.current_organization_id() and m.id=app.current_membership_id()
      and m.status='active' and m.role in('owner','admin')),false)
$$;
REVOKE ALL ON FUNCTION ai.model_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.model_manager() TO ensemus_app;
CREATE FUNCTION ai.guard_model_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;a record;p record;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NOT ai.model_manager() THEN
    RAISE EXCEPTION 'MODEL_AUTHORITY_REQUIRED' USING ERRCODE='42501';END IF;
  IF TG_RELID='ai.model_operation_qualifications'::regclass THEN
    IF TG_OP<>'INSERT' OR NEW.state<>'requested' OR NEW.qualified_at IS NOT NULL OR NEW.result_digest IS NOT NULL
      OR NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
      RAISE EXCEPTION 'MODEL_QUALIFICATION_REQUEST' USING ERRCODE='EN120';END IF;
    SELECT * INTO p FROM ai.model_profiles WHERE organization_id=NEW.organization_id and id=NEW.profile_id FOR SHARE;
    IF NOT FOUND OR p.version<>NEW.profile_version OR NOT(NEW.purpose=ANY(p.allowed_purposes)) THEN
      RAISE EXCEPTION 'MODEL_PROFILE_CHANGED' USING ERRCODE='EN120';END IF;
  ELSIF TG_RELID='ai.model_workload_approvals'::regclass THEN
    IF TG_OP='UPDATE' THEN
      IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM(to_jsonb(OLD)-'revoked_at') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'MODEL_APPROVAL_IMMUTABLE' USING ERRCODE='EN120';END IF;
      NEW.revoked_at:=clock_timestamp();RETURN NEW;
    END IF;
    IF TG_OP<>'INSERT' OR NEW.approved_by_membership_id IS DISTINCT FROM app.current_membership_id()
      OR NEW.revoked_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'MODEL_APPROVAL_INVALID' USING ERRCODE='EN120';END IF;
    IF NEW.source_id IS NOT NULL AND NEW.source_id NOT IN(SELECT knowledge.readable_source_ids(app.current_membership_id())) THEN
      RAISE EXCEPTION 'MODEL_SOURCE_UNREADABLE' USING ERRCODE='EN120';END IF;
  ELSIF TG_RELID='ai.model_workload_profiles'::regclass THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MODEL_APPROVAL_IMMUTABLE' USING ERRCODE='EN120';END IF;
    SELECT * INTO a FROM ai.model_workload_approvals WHERE organization_id=NEW.organization_id and id=NEW.approval_id FOR SHARE;
    IF NOT FOUND OR a.approved_by_membership_id<>app.current_membership_id() OR a.revoked_at IS NOT NULL OR a.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'MODEL_APPROVAL_INVALID' USING ERRCODE='EN120';END IF;
    SELECT * INTO q FROM ai.model_operation_qualifications WHERE organization_id=NEW.organization_id and id=NEW.qualification_id;
    IF NOT FOUND OR q.state<>'passed' OR NOT(q.purpose=ANY(a.purposes)) THEN RAISE EXCEPTION 'MODEL_QUALIFICATION_REQUIRED' USING ERRCODE='EN120';END IF;
    SELECT * INTO p FROM ai.model_profiles WHERE organization_id=NEW.organization_id and id=q.profile_id FOR SHARE;
    IF NOT FOUND OR p.version<>q.profile_version OR p.status<>'active' THEN RAISE EXCEPTION 'MODEL_PROFILE_CHANGED' USING ERRCODE='EN120';END IF;
  ELSE RAISE EXCEPTION 'MODEL_AUTHORITY_TARGET' USING ERRCODE='42501';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_model_approval() FROM PUBLIC;
CREATE TRIGGER model_qualification_request BEFORE INSERT ON ai.model_operation_qualifications FOR EACH ROW EXECUTE FUNCTION ai.guard_model_approval();
CREATE TRIGGER model_approval_guard BEFORE INSERT OR UPDATE ON ai.model_workload_approvals FOR EACH ROW EXECUTE FUNCTION ai.guard_model_approval();
CREATE TRIGGER model_approval_profile_guard BEFORE INSERT ON ai.model_workload_profiles FOR EACH ROW EXECUTE FUNCTION ai.guard_model_approval();
CREATE TRIGGER model_approval_profiles_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.model_workload_profiles FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION ai.guard_model_job_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;q record;d record;answer_row record;
BEGIN
  IF TG_RELID<>'ai.model_jobs'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.state<>'prepared' OR NEW.calls<>0 OR NEW.reserved_micros<>0 OR NEW.spent_micros<>0
    OR NEW.reserved_tokens<>0 OR NEW.used_tokens<>0 OR NEW.fenced_at IS NOT NULL OR NEW.finished_at IS NOT NULL
    OR NEW.refusal_code IS NOT NULL OR NEW.result_package_id IS NOT NULL OR NEW.fence_generation<>0 OR NEW.payloads_purged_at is not null OR NEW.purged_fence_generation is not null OR NEW.deadline_at<=clock_timestamp()
    OR NEW.deadline_at>clock_timestamp()+make_interval(secs=>NEW.timeout_seconds) THEN
    RAISE EXCEPTION 'MODEL_JOB_REQUEST_INVALID' USING ERRCODE='EN120';END IF;
  IF NEW.kind='qualification' THEN
    IF NOT ai.model_manager() OR NEW.requester_membership_id IS DISTINCT FROM app.current_membership_id() OR NEW.classification<>'public' THEN
      RAISE EXCEPTION 'MODEL_AUTHORITY_REQUIRED' USING ERRCODE='42501';END IF;
    SELECT * INTO q FROM ai.model_operation_qualifications WHERE organization_id=NEW.organization_id and id=NEW.qualification_id;
    IF NOT FOUND OR q.state<>'requested' OR q.requested_by_membership_id<>NEW.requester_membership_id OR q.request_key<>NEW.request_key
      OR ROW(NEW.max_calls,NEW.max_input_tokens,NEW.max_output_tokens,NEW.max_total_tokens,NEW.max_cost_micros,NEW.timeout_seconds)
        IS DISTINCT FROM ROW(q.max_calls,q.max_input_tokens,q.max_output_tokens,q.max_total_tokens,q.max_cost_micros,q.timeout_seconds) THEN
      RAISE EXCEPTION 'MODEL_QUALIFICATION_REQUEST' USING ERRCODE='EN120';END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO a FROM ai.model_workload_approvals WHERE organization_id=NEW.organization_id and id=NEW.approval_id FOR SHARE;
  IF NOT FOUND OR a.kind<>NEW.kind OR a.revoked_at IS NOT NULL OR a.expires_at<=clock_timestamp()
    OR NEW.deadline_at>a.expires_at OR NEW.max_calls>a.max_calls OR NEW.max_input_tokens>a.max_input_tokens
    OR NEW.max_output_tokens>a.max_output_tokens OR NEW.max_total_tokens>a.max_total_tokens
    OR NEW.max_cost_micros>a.max_cost_micros OR NEW.timeout_seconds>a.timeout_seconds
    OR knowledge.class_rank(NEW.classification)>knowledge.class_rank(a.max_classification) THEN
    RAISE EXCEPTION 'MODEL_APPROVAL_REQUIRED' USING ERRCODE='EN120';END IF;
  IF NOT EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=NEW.organization_id and m.id=NEW.requester_membership_id and m.status='active') THEN
    RAISE EXCEPTION 'MODEL_REQUESTER_INACTIVE' USING ERRCODE='EN120';END IF;
  IF NEW.kind='document_embed' THEN
    IF app.current_actor_type() IS DISTINCT FROM 'service' OR NEW.requester_membership_id<>a.approved_by_membership_id THEN RAISE EXCEPTION 'MODEL_DOCUMENT_AUTHORITY' USING ERRCODE='42501';END IF;
    SELECT d.*,s.connection_id,s.state source_state,s.classification source_class INTO d FROM knowledge.documents d JOIN knowledge.sources s ON s.organization_id=d.organization_id and s.id=d.source_id
      WHERE d.organization_id=NEW.organization_id and d.id=NEW.document_id;
    IF NOT FOUND OR d.state<>'searchable' OR d.superseded_at IS NOT NULL OR d.source_state<>'active'
      OR d.source_id NOT IN(SELECT knowledge.readable_source_ids(NEW.requester_membership_id))
      OR NOT((a.scope='source' and a.source_id=d.source_id)OR(a.scope='connection' and a.connection_id=d.connection_id))
      OR NOT('embed'=ANY(a.purposes)) OR greatest(knowledge.class_rank(d.classification),knowledge.class_rank(d.source_class))>knowledge.class_rank(NEW.classification) THEN
      RAISE EXCEPTION 'MODEL_DOCUMENT_UNREADABLE' USING ERRCODE='EN120';END IF;
  ELSE
    IF app.current_actor_type() NOT IN('user','delegated') OR NEW.requester_membership_id IS DISTINCT FROM app.current_membership_id() THEN RAISE EXCEPTION 'MODEL_REQUESTER_REQUIRED' USING ERRCODE='42501';END IF;
    IF NEW.kind='answer' THEN
      SELECT * INTO answer_row FROM knowledge.answers WHERE organization_id=NEW.organization_id and id=NEW.answer_id;
      IF NOT FOUND OR answer_row.requester_membership_id<>NEW.requester_membership_id OR answer_row.question_classification<>NEW.classification THEN
        RAISE EXCEPTION 'MODEL_ANSWER_UNREADABLE' USING ERRCODE='EN120';END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_model_job_request() FROM PUBLIC;
CREATE TRIGGER model_job_request_guard BEFORE INSERT ON ai.model_jobs FOR EACH ROW EXECUTE FUNCTION ai.guard_model_job_request();
--> statement-breakpoint
CREATE FUNCTION ai.model_job_admitted(p_job uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_user='ensemus_agent' and current_setting('app.knowledge_model_protocol',true)='v1'
    and current_setting('app.model_job_id',true)=p_job::text and EXISTS(
      SELECT 1 FROM ai.model_jobs j JOIN org.memberships m ON m.organization_id=j.organization_id and m.id=j.requester_membership_id and m.status='active'
      WHERE j.organization_id=app.current_organization_id() and j.id=p_job and j.requester_membership_id=app.current_membership_id()
        and j.state in('prepared','running') and j.fenced_at is null and j.deadline_at>clock_timestamp()),false)
$$;
REVOKE ALL ON FUNCTION ai.model_job_admitted(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.model_job_admitted(uuid) TO ensemus_agent;
CREATE FUNCTION ai.model_call_inputs_readable(p_call uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM ai.model_call_attempts c WHERE c.organization_id=app.current_organization_id() and c.id=p_call
    and NOT EXISTS(SELECT 1 FROM ai.model_call_inputs i WHERE i.organization_id=c.organization_id and i.call_id=c.id and (
      knowledge.class_rank(i.classification)>knowledge.class_rank(c.classification) OR
      CASE WHEN i.kind='chunk' THEN NOT EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=i.organization_id and s.id=i.source_id and s.state='active'
        and s.id IN(SELECT knowledge.readable_source_ids(p_viewer)) and knowledge.class_rank(s.classification)<=knowledge.class_rank(c.classification))
        OR NOT EXISTS(SELECT 1 FROM knowledge.chunks ch JOIN knowledge.documents d ON d.organization_id=ch.organization_id and d.id=ch.document_id
          WHERE ch.organization_id=i.organization_id and ch.id=i.input_id and ch.source_id=i.source_id and ch.content_sha256=i.sha256
            and d.state='searchable' and d.superseded_at is null and knowledge.class_rank(d.classification)<=knowledge.class_rank(c.classification))
      ELSE NOT knowledge.structured_record_readable(i.kind,i.input_id,p_viewer)
        OR knowledge.structured_record_class(i.kind,i.input_id) is null
        OR knowledge.class_rank(knowledge.structured_record_class(i.kind,i.input_id))>knowledge.class_rank(c.classification) END
    ))),false)
$$;
REVOKE ALL ON FUNCTION ai.model_call_inputs_readable(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.model_call_inputs_readable(uuid,uuid) TO ensemus_agent;
--> statement-breakpoint
CREATE FUNCTION ai.assert_model_call(c ai.model_call_attempts) RETURNS void LANGUAGE plpgsql AS $$
DECLARE j record;a record;q record;p record;r record;is_qualification boolean:=false;
BEGIN
  IF current_user<>'ensemus_agent' OR c.organization_id IS DISTINCT FROM app.current_organization_id()
    OR current_setting('app.knowledge_model_protocol',true) IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'MODEL_RUNTIME_REQUIRED' USING ERRCODE='42501';END IF;
  IF c.job_id IS NOT NULL THEN
    PERFORM 1 FROM ai.model_jobs WHERE organization_id=c.organization_id and id=c.job_id FOR SHARE NOWAIT;
    IF NOT ai.model_job_admitted(c.job_id) THEN RAISE EXCEPTION 'MODEL_JOB_CLOSED' USING ERRCODE='EN120';END IF;
    SELECT * INTO j FROM ai.model_jobs WHERE organization_id=c.organization_id and id=c.job_id;
    IF c.max_input_tokens>j.max_input_tokens OR c.max_output_tokens>j.max_output_tokens THEN RAISE EXCEPTION 'MODEL_JOB_LIMIT' USING ERRCODE='EN120';END IF;
    IF c.state='accepted' AND(j.spent_micros>j.max_cost_micros OR j.used_tokens>j.max_total_tokens) THEN RAISE EXCEPTION 'MODEL_JOB_LIMIT' USING ERRCODE='EN120';END IF;
    IF j.kind='qualification' THEN
      is_qualification:=true;
      IF c.qualification_id<>j.qualification_id OR c.approval_id IS NOT NULL OR c.classification<>'public' THEN RAISE EXCEPTION 'MODEL_QUALIFICATION_REQUEST' USING ERRCODE='EN120';END IF;
    ELSIF c.approval_id IS DISTINCT FROM j.approval_id THEN RAISE EXCEPTION 'MODEL_APPROVAL_REQUIRED' USING ERRCODE='EN120';END IF;
    IF j.kind='document_embed' THEN
      IF c.purpose<>'embed' OR NOT EXISTS(SELECT 1 FROM knowledge.documents d JOIN knowledge.sources s ON s.organization_id=d.organization_id and s.id=d.source_id
        WHERE d.organization_id=j.organization_id and d.id=j.document_id and d.state='searchable' and d.superseded_at is null and s.state='active' and s.id IN(SELECT knowledge.readable_source_ids(j.requester_membership_id)))
        OR EXISTS(SELECT 1 FROM ai.model_call_inputs i WHERE i.organization_id=c.organization_id and i.call_id=c.id and i.kind='chunk' and NOT EXISTS(SELECT 1 FROM knowledge.chunks ch WHERE ch.organization_id=i.organization_id and ch.id=i.input_id and ch.document_id=j.document_id)) THEN RAISE EXCEPTION 'MODEL_DOCUMENT_UNREADABLE' USING ERRCODE='EN120';END IF;
    ELSIF j.kind='answer' THEN
      IF NOT EXISTS(SELECT 1 FROM knowledge.answers a WHERE a.organization_id=j.organization_id and a.id=j.answer_id and a.requester_membership_id=j.requester_membership_id and(a.state in('queued','running')or(c.state='accepted' and a.state='answered'))) THEN RAISE EXCEPTION 'MODEL_ANSWER_UNREADABLE' USING ERRCODE='EN120';END IF;
    END IF;
  ELSE
    IF NOT ai.run_input_admitted(c.run_id) OR NOT ai.run_inputs_readable(c.run_id,app.current_membership_id()) THEN RAISE EXCEPTION 'MODEL_RUN_CLOSED' USING ERRCODE='EN119';END IF;
    SELECT * INTO r FROM ai.agent_runs WHERE organization_id=c.organization_id and id=c.run_id FOR SHARE NOWAIT;
    IF NOT FOUND OR r.status<>'running' OR NOT EXISTS(SELECT 1 FROM ai.execution_steps s WHERE s.organization_id=c.organization_id and s.id=c.step_id and s.run_id=r.id and s.kind='model_turn' and s.state='in_flight') THEN
      RAISE EXCEPTION 'MODEL_RUN_STEP_REQUIRED' USING ERRCODE='EN120';END IF;
    IF knowledge.class_rank(c.classification)<knowledge.class_rank(r.effective_classification) THEN RAISE EXCEPTION 'MODEL_RUN_CLASS_RAISED' USING ERRCODE='EN120';END IF;
    IF c.state in('prepared','dispatched') AND EXISTS(SELECT 1 FROM ai.model_call_attempts prior WHERE prior.organization_id=c.organization_id and prior.run_id=c.run_id and prior.id<>c.id and prior.state in('dispatched','unknown')) THEN RAISE EXCEPTION 'MODEL_RUN_RESPONSE_UNCONFIRMED' USING ERRCODE='EN120';END IF;
    IF c.state='accepted' AND(r.cost_micros>r.max_cost_micros OR r.input_tokens::bigint+r.output_tokens::bigint>r.max_total_tokens) THEN RAISE EXCEPTION 'MODEL_RUN_LIMIT' USING ERRCODE='EN120';END IF;
  END IF;
  SELECT * INTO q FROM ai.model_operation_qualifications WHERE organization_id=c.organization_id and id=c.qualification_id FOR SHARE NOWAIT;
  IF NOT FOUND OR q.profile_id<>c.profile_id OR q.profile_version<>c.profile_version OR q.purpose<>c.purpose THEN RAISE EXCEPTION 'MODEL_QUALIFICATION_REQUIRED' USING ERRCODE='EN120';END IF;
  SELECT * INTO p FROM ai.model_profiles WHERE organization_id=c.organization_id and id=c.profile_id FOR SHARE NOWAIT;
  IF NOT FOUND OR p.version<>c.profile_version OR NOT(c.purpose=ANY(p.allowed_purposes)) OR c.max_input_tokens>(p.limits->>'maxInputTokens')::integer OR c.max_output_tokens>(p.limits->>'maxOutputTokens')::integer THEN RAISE EXCEPTION 'MODEL_PROFILE_CHANGED' USING ERRCODE='EN120';END IF;
  IF is_qualification THEN
    IF q.state<>'requested' OR p.status<>'probing' THEN RAISE EXCEPTION 'MODEL_QUALIFICATION_REQUEST' USING ERRCODE='EN120';END IF;
  ELSE
    IF q.state<>'passed' OR p.status<>'active' THEN RAISE EXCEPTION 'MODEL_QUALIFICATION_REQUIRED' USING ERRCODE='EN120';END IF;
    SELECT * INTO a FROM ai.model_workload_approvals WHERE organization_id=c.organization_id and id=c.approval_id FOR SHARE NOWAIT;
    IF NOT FOUND OR a.revoked_at IS NOT NULL OR a.expires_at<=clock_timestamp() OR NOT(c.purpose=ANY(a.purposes))
      OR knowledge.class_rank(c.classification)>knowledge.class_rank(a.max_classification)
      OR c.max_input_tokens>a.max_input_tokens OR c.max_output_tokens>a.max_output_tokens
      OR NOT EXISTS(SELECT 1 FROM ai.model_workload_profiles b WHERE b.organization_id=c.organization_id and b.approval_id=a.id and b.qualification_id=q.id)
      OR(c.run_id IS NOT NULL and a.kind<>'agent_context') THEN RAISE EXCEPTION 'MODEL_APPROVAL_REQUIRED' USING ERRCODE='EN120';END IF;
  END IF;
  IF c.state='accepted' AND(c.input_tokens>c.max_input_tokens OR c.output_tokens>c.max_output_tokens) THEN RAISE EXCEPTION 'MODEL_CALL_LIMIT' USING ERRCODE='EN120';END IF;
END $$;
REVOKE ALL ON FUNCTION ai.assert_model_call(ai.model_call_attempts) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.assert_model_call(ai.model_call_attempts) TO ensemus_agent;
CREATE FUNCTION ai.guard_model_call() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accounting_only boolean:=false;
BEGIN
  IF TG_RELID<>'ai.model_call_attempts'::regclass OR current_user<>'ensemus_agent' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'MODEL_RUNTIME_REQUIRED' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' THEN
    accounting_only:=app.current_actor_type()='service' and current_setting('app.knowledge_model_protocol',true)='accounting-v1'
      and((OLD.state='prepared' and NEW.state='refused')or(OLD.state='dispatched' and NEW.state='unknown'));
  END IF;
  IF accounting_only THEN
    IF NEW.job_id IS NOT NULL THEN
      IF NEW.job_id::text IS DISTINCT FROM current_setting('app.model_job_id',true) OR NOT EXISTS(SELECT 1 FROM ai.model_jobs j WHERE j.organization_id=NEW.organization_id and j.id=NEW.job_id and j.fenced_at is not null) THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_TARGET' USING ERRCODE='42501';END IF;
    ELSE
      IF NEW.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR NOT EXISTS(
        SELECT 1 FROM ai.agent_runs r JOIN ai.run_input_checkpoints p ON p.organization_id=r.organization_id and p.run_id=r.id
        WHERE r.organization_id=NEW.organization_id and r.id=NEW.run_id and r.status in('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')
          and p.fenced_at is not null and p.fence_generation=1) THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_TARGET' USING ERRCODE='42501';END IF;
    END IF;
    IF NEW.input_tokens<>0 OR NEW.output_tokens<>0 OR NEW.cost_micros IS DISTINCT FROM CASE WHEN OLD.state='dispatched' THEN OLD.reserved_micros ELSE 0 END
      OR NEW.status IS DISTINCT FROM CASE WHEN OLD.state='dispatched' THEN 'estimated' ELSE 'final' END THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_ESTIMATE_REQUIRED' USING ERRCODE='EN120';END IF;
  ELSE
    IF current_setting('app.knowledge_model_protocol',true) IS DISTINCT FROM 'v1' THEN RAISE EXCEPTION 'MODEL_RUNTIME_REQUIRED' USING ERRCODE='42501';END IF;
    IF NEW.job_id IS NOT NULL THEN
    IF NEW.job_id::text IS DISTINCT FROM current_setting('app.model_job_id',true) OR NOT EXISTS(SELECT 1 FROM ai.model_jobs j WHERE j.organization_id=NEW.organization_id and j.id=NEW.job_id and j.requester_membership_id=app.current_membership_id()) THEN RAISE EXCEPTION 'MODEL_JOB_PRINCIPAL' USING ERRCODE='42501';END IF;
    ELSE
    IF app.current_actor_type() IS DISTINCT FROM 'agent' OR NEW.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR NOT EXISTS(SELECT 1 FROM ai.agent_runs r WHERE r.organization_id=NEW.organization_id and r.id=NEW.run_id and r.initiator_membership_id=app.current_membership_id()) THEN RAISE EXCEPTION 'MODEL_RUN_PRINCIPAL' USING ERRCODE='42501';END IF;
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'prepared' OR NEW.input_tokens IS NOT NULL OR NEW.output_tokens IS NOT NULL OR NEW.cost_micros IS NOT NULL OR NEW.status IS NOT NULL
      OR NEW.dispatched_at IS NOT NULL OR NEW.received_at IS NOT NULL OR NEW.accepted_at IS NOT NULL OR NEW.result_kind IS NOT NULL OR NEW.result_id IS NOT NULL THEN RAISE EXCEPTION 'MODEL_CALL_INVALID_START' USING ERRCODE='EN120';END IF;
    PERFORM ai.assert_model_call(NEW::ai.model_call_attempts);RETURN NEW;
  END IF;
  IF TG_OP<>'UPDATE' OR(to_jsonb(NEW)-ARRAY['state','input_tokens','output_tokens','cost_micros','status','reason_code','result_kind','result_id','dispatched_at','received_at','accepted_at'])
    IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','input_tokens','output_tokens','cost_micros','status','reason_code','result_kind','result_id','dispatched_at','received_at','accepted_at']) THEN
    RAISE EXCEPTION 'MODEL_CALL_IMMUTABLE' USING ERRCODE='EN120';END IF;
  IF to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW;END IF;
  IF NEW.state<>'accepted' AND ROW(NEW.result_kind,NEW.result_id) IS DISTINCT FROM ROW(OLD.result_kind,OLD.result_id) THEN RAISE EXCEPTION 'MODEL_RESULT_IMMUTABLE' USING ERRCODE='EN120';END IF;
  IF OLD.state='response_received' AND ROW(NEW.input_tokens,NEW.output_tokens,NEW.cost_micros,NEW.status,NEW.received_at) IS DISTINCT FROM ROW(OLD.input_tokens,OLD.output_tokens,OLD.cost_micros,OLD.status,OLD.received_at) THEN RAISE EXCEPTION 'MODEL_USAGE_IMMUTABLE' USING ERRCODE='EN120';END IF;
  IF NOT((OLD.state='prepared' and NEW.state in('dispatched','refused'))OR(OLD.state='dispatched' and NEW.state in('response_received','unknown','refused'))OR(OLD.state='response_received' and NEW.state in('accepted','refused'))) THEN
    RAISE EXCEPTION 'MODEL_CALL_INVALID_TRANSITION' USING ERRCODE='EN120';END IF;
  IF NEW.state='dispatched' THEN
    IF NEW.input_inventory_hash IS DISTINCT FROM(SELECT encode(sha256(convert_to(coalesce(string_agg(i.kind||':'||i.input_id::text||':'||coalesce(i.source_id::text,'')||':'||i.sha256||':'||i.classification,E'\n' order by i.kind COLLATE "C",i.input_id,i.sha256 COLLATE "C",i.classification COLLATE "C"),''),'UTF8')),'hex') FROM ai.model_call_inputs i WHERE i.organization_id=NEW.organization_id and i.call_id=NEW.id) THEN RAISE EXCEPTION 'MODEL_INPUT_INVENTORY_INCOMPLETE' USING ERRCODE='EN120';END IF;
    PERFORM ai.assert_model_call(NEW::ai.model_call_attempts);
    IF NOT ai.model_call_inputs_readable(NEW.id,app.current_membership_id()) THEN RAISE EXCEPTION 'MODEL_INPUT_UNREADABLE' USING ERRCODE='EN120';END IF;
    NEW.dispatched_at:=clock_timestamp();
  ELSIF NEW.state='accepted' THEN
    PERFORM ai.assert_model_call(NEW::ai.model_call_attempts);
    IF NOT ai.model_call_inputs_readable(NEW.id,app.current_membership_id()) OR ROW(NEW.input_tokens,NEW.output_tokens,NEW.cost_micros,NEW.status,NEW.received_at)
      IS DISTINCT FROM ROW(OLD.input_tokens,OLD.output_tokens,OLD.cost_micros,OLD.status,OLD.received_at) THEN RAISE EXCEPTION 'MODEL_INPUT_UNREADABLE' USING ERRCODE='EN120';END IF;
    NEW.accepted_at:=clock_timestamp();
    IF NEW.result_kind='answer' THEN
      IF NOT EXISTS(SELECT 1 FROM ai.model_jobs j JOIN knowledge.answers a ON a.organization_id=j.organization_id and a.id=j.answer_id
        WHERE j.organization_id=NEW.organization_id and j.id=NEW.job_id and a.id=NEW.result_id and a.requester_membership_id=app.current_membership_id() and a.state='answered' and a.model_profile_ref=NEW.profile_id and knowledge.class_rank(a.strongest_classification)>=knowledge.class_rank(NEW.classification)) THEN RAISE EXCEPTION 'MODEL_RESULT_REQUIRED' USING ERRCODE='EN120';END IF;
    ELSIF NEW.result_kind='evidence' THEN
      IF NOT EXISTS(SELECT 1 FROM knowledge.evidence_packages p WHERE p.organization_id=NEW.organization_id and p.id=NEW.result_id and p.viewer_membership_id=app.current_membership_id() and p.run_id IS NOT DISTINCT FROM NEW.run_id and knowledge.class_rank(p.strongest_classification)>=knowledge.class_rank(NEW.classification)) THEN RAISE EXCEPTION 'MODEL_RESULT_REQUIRED' USING ERRCODE='EN120';END IF;
    ELSIF NEW.result_kind='embeddings' THEN
      IF NEW.purpose<>'embed' OR NOT EXISTS(SELECT 1 FROM ai.model_jobs j WHERE j.organization_id=NEW.organization_id and j.id=NEW.job_id and j.document_id=NEW.result_id)
        OR NOT EXISTS(SELECT 1 FROM ai.model_call_inputs i WHERE i.organization_id=NEW.organization_id and i.call_id=NEW.id and i.kind='chunk')
        OR EXISTS(SELECT 1 FROM ai.model_call_inputs i WHERE i.organization_id=NEW.organization_id and i.call_id=NEW.id and i.kind='chunk' and NOT EXISTS(
          SELECT 1 FROM knowledge.embeddings e JOIN knowledge.embedding_spaces sp ON sp.organization_id=e.organization_id and sp.id=e.space_id
          JOIN knowledge.chunks ch ON ch.organization_id=e.organization_id and ch.id=e.chunk_id
          WHERE e.organization_id=i.organization_id and e.chunk_id=i.input_id and e.content_sha256=i.sha256 and ch.document_id=NEW.result_id and sp.qualification_id=NEW.qualification_id)) THEN RAISE EXCEPTION 'MODEL_RESULT_REQUIRED' USING ERRCODE='EN120';END IF;
    ELSIF NEW.result_kind='qualification' THEN
      IF NEW.result_id<>NEW.qualification_id OR NEW.status<>'final' OR NOT EXISTS(SELECT 1 FROM ai.model_jobs j WHERE j.organization_id=NEW.organization_id and j.id=NEW.job_id and j.kind='qualification' and j.qualification_id=NEW.result_id) THEN RAISE EXCEPTION 'MODEL_RESULT_REQUIRED' USING ERRCODE='EN120';END IF;
    ELSE RAISE EXCEPTION 'MODEL_RESULT_REQUIRED' USING ERRCODE='EN120';END IF;
  ELSIF NEW.state IN('response_received','unknown') THEN
    IF NEW.input_tokens IS NULL OR NEW.output_tokens IS NULL OR NEW.cost_micros IS NULL OR NEW.status NOT IN('final','estimated') THEN RAISE EXCEPTION 'MODEL_USAGE_REQUIRED' USING ERRCODE='EN120';END IF;
    IF NEW.state='unknown' AND(NEW.input_tokens<>0 OR NEW.output_tokens<>0 OR NEW.cost_micros<>NEW.reserved_micros OR NEW.status<>'estimated') THEN RAISE EXCEPTION 'MODEL_UNKNOWN_USAGE' USING ERRCODE='EN120';END IF;
    NEW.received_at:=clock_timestamp();
  END IF;
  IF NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at AND NEW.state<>'dispatched'
    OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at AND NEW.state<>'accepted' THEN RAISE EXCEPTION 'MODEL_CALL_RECEIPT_IMMUTABLE' USING ERRCODE='EN120';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_model_call() FROM PUBLIC;
CREATE TRIGGER model_call_guard BEFORE INSERT OR UPDATE ON ai.model_call_attempts FOR EACH ROW EXECUTE FUNCTION ai.guard_model_call();
CREATE TRIGGER model_call_no_delete BEFORE DELETE OR TRUNCATE ON ai.model_call_attempts FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION ai.guard_model_call_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c ai.model_call_attempts%ROWTYPE;current_class text;
BEGIN
  IF TG_RELID<>'ai.model_call_inputs'::regclass OR TG_OP<>'INSERT' OR current_user<>'ensemus_agent'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'MODEL_INPUT_TARGET' USING ERRCODE='42501';END IF;
  -- Never wait for a body/ACL lock after a call/job row. Callers normally acquire these in sorted
  -- order before metadata; NOWAIT also makes a direct late insertion fail closed instead of deadlock.
  IF NEW.kind='chunk' THEN
    PERFORM 1 FROM knowledge.sources WHERE organization_id=NEW.organization_id and id=NEW.source_id FOR SHARE NOWAIT;
    SELECT greatest(knowledge.class_rank(s.classification),knowledge.class_rank(d.classification))::text INTO current_class
      FROM knowledge.chunks ch JOIN knowledge.documents d ON d.organization_id=ch.organization_id and d.id=ch.document_id
      JOIN knowledge.sources s ON s.organization_id=ch.organization_id and s.id=ch.source_id
      WHERE ch.organization_id=NEW.organization_id and ch.id=NEW.input_id and ch.source_id=NEW.source_id
        and ch.content_sha256=NEW.sha256 and s.state='active' and d.state='searchable' and d.superseded_at is null
        and s.id IN(SELECT knowledge.readable_source_ids(app.current_membership_id()));
    IF NOT FOUND OR current_class::integer>knowledge.class_rank(NEW.classification) THEN RAISE EXCEPTION 'MODEL_INPUT_UNREADABLE' USING ERRCODE='EN120';END IF;
  ELSE
    IF NOT knowledge.lock_structured_record(NEW.kind,NEW.input_id) OR NOT knowledge.structured_record_readable(NEW.kind,NEW.input_id,app.current_membership_id())
      OR knowledge.structured_record_class(NEW.kind,NEW.input_id) is null
      OR knowledge.class_rank(knowledge.structured_record_class(NEW.kind,NEW.input_id))>knowledge.class_rank(NEW.classification) THEN RAISE EXCEPTION 'MODEL_INPUT_UNREADABLE' USING ERRCODE='EN120';END IF;
  END IF;
  SELECT * INTO c FROM ai.model_call_attempts WHERE organization_id=NEW.organization_id and id=NEW.call_id FOR SHARE NOWAIT;
  IF NOT FOUND OR c.state<>'prepared' OR knowledge.class_rank(NEW.classification)>knowledge.class_rank(c.classification)
    OR(SELECT count(*) FROM ai.model_call_inputs WHERE organization_id=NEW.organization_id and call_id=NEW.call_id)>=1000 THEN RAISE EXCEPTION 'MODEL_INPUT_CLOSED' USING ERRCODE='EN120';END IF;
  IF c.run_id IS NOT NULL AND NEW.kind<>'chunk' AND NOT EXISTS(
    SELECT 1 FROM ai.run_input_observations o WHERE o.organization_id=NEW.organization_id and o.run_id=c.run_id
      and o.input_kind=NEW.kind and o.input_id=NEW.input_id and o.input_sha256=NEW.sha256
      and knowledge.class_rank(o.classification)>=knowledge.class_rank(NEW.classification)) THEN
    RAISE EXCEPTION 'MODEL_INPUT_NOT_CAPTURED' USING ERRCODE='EN119';END IF;
  PERFORM ai.assert_model_call(c);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_model_call_input() FROM PUBLIC;
CREATE TRIGGER model_call_input_guard BEFORE INSERT ON ai.model_call_inputs FOR EACH ROW EXECUTE FUNCTION ai.guard_model_call_input();
CREATE TRIGGER model_call_inputs_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.model_call_inputs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION ai.guard_model_job_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user='ensemus_app' THEN
    IF NOT knowledge.is_service_actor() AND NOT(app.current_actor_type() in('user','delegated') and OLD.requester_membership_id=app.current_membership_id() and EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=OLD.organization_id and m.id=app.current_membership_id() and m.status='active')) THEN RAISE EXCEPTION 'MODEL_JOB_PRINCIPAL' USING ERRCODE='42501';END IF;
    IF TG_RELID<>'ai.model_jobs'::regclass OR TG_OP<>'UPDATE' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR OLD.state<>'prepared' OR NEW.state<>'refused' OR OLD.calls<>0 OR OLD.reserved_micros<>0 OR OLD.spent_micros<>0 OR OLD.reserved_tokens<>0 OR OLD.used_tokens<>0
      OR(to_jsonb(NEW)-ARRAY['state','refusal_code']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','refusal_code'])
      OR EXISTS(SELECT 1 FROM ai.model_call_attempts c WHERE c.organization_id=OLD.organization_id and c.job_id=OLD.id) THEN RAISE EXCEPTION 'MODEL_JOB_CLAIMED' USING ERRCODE='EN120';END IF;
    NEW.fenced_at:=clock_timestamp();NEW.fence_generation:=1;NEW.finished_at:=clock_timestamp();RETURN NEW;
  END IF;
  IF TG_RELID<>'ai.model_jobs'::regclass OR TG_OP<>'UPDATE' OR current_user<>'ensemus_agent'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR(to_jsonb(NEW)-ARRAY['state','calls','reserved_micros','spent_micros','reserved_tokens','used_tokens','fenced_at','fence_generation','payloads_purged_at','purged_fence_generation','refusal_code','result_package_id','finished_at'])
      IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','calls','reserved_micros','spent_micros','reserved_tokens','used_tokens','fenced_at','fence_generation','payloads_purged_at','purged_fence_generation','refusal_code','result_package_id','finished_at'])
    OR NEW.calls<OLD.calls OR NEW.calls>NEW.max_calls OR NEW.spent_micros<OLD.spent_micros OR NEW.used_tokens<OLD.used_tokens
    OR(OLD.fenced_at IS NOT NULL AND NEW.fenced_at IS DISTINCT FROM OLD.fenced_at)
    OR(OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at) THEN RAISE EXCEPTION 'MODEL_JOB_IMMUTABLE' USING ERRCODE='EN120';END IF;
  IF OLD.payloads_purged_at IS NOT NULL AND ROW(NEW.payloads_purged_at,NEW.purged_fence_generation) IS DISTINCT FROM ROW(OLD.payloads_purged_at,OLD.purged_fence_generation) THEN RAISE EXCEPTION 'MODEL_JOB_RECEIPT_IMMUTABLE' USING ERRCODE='EN120';END IF;
  IF NEW.payloads_purged_at IS DISTINCT FROM OLD.payloads_purged_at THEN
    IF app.current_actor_type() IS DISTINCT FROM 'service' OR NEW.fenced_at IS NULL OR NEW.fence_generation<>1 OR NEW.purged_fence_generation<>NEW.fence_generation
      OR NEW.purged_fence_generation IS DISTINCT FROM NEW.fence_generation OR EXISTS(SELECT 1 FROM ai.model_job_payloads p WHERE p.organization_id=NEW.organization_id and p.job_id=NEW.id) THEN RAISE EXCEPTION 'MODEL_JOB_PAYLOADS_REMAIN' USING ERRCODE='EN120';END IF;
    NEW.payloads_purged_at:=clock_timestamp();
  END IF;
  IF NEW.state<>OLD.state AND NOT((OLD.state='prepared' and NEW.state in('running','completed','refused','fenced'))OR(OLD.state='running' and NEW.state in('completed','refused','fenced'))OR(OLD.state in('completed','refused') and NEW.state='fenced')) THEN
    RAISE EXCEPTION 'MODEL_JOB_CLOSED' USING ERRCODE='EN120';END IF;
  IF NEW.state in('completed','refused','fenced') AND NEW.fenced_at IS NULL THEN NEW.fenced_at:=clock_timestamp();NEW.fence_generation:=1;END IF;
  IF NEW.state in('completed','refused') AND NEW.finished_at IS NULL THEN NEW.finished_at:=clock_timestamp();END IF;
  IF NEW.state='completed' AND(NEW.reserved_micros<>0 OR NEW.reserved_tokens<>0 OR EXISTS(SELECT 1 FROM ai.model_call_attempts c WHERE c.organization_id=NEW.organization_id and c.job_id=NEW.id and c.state in('prepared','dispatched','unknown'))) THEN
    RAISE EXCEPTION 'MODEL_JOB_UNRESOLVED' USING ERRCODE='EN120';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_model_job_change() FROM PUBLIC;
CREATE TRIGGER model_job_change_guard BEFORE UPDATE ON ai.model_jobs FOR EACH ROW EXECUTE FUNCTION ai.guard_model_job_change();
CREATE FUNCTION ai.guard_model_payload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j record;
BEGIN
  IF TG_RELID<>'ai.model_job_payloads'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'MODEL_PAYLOAD_TARGET' USING ERRCODE='42501';END IF;
  SELECT * INTO j FROM ai.model_jobs WHERE organization_id=NEW.organization_id and id=NEW.job_id FOR SHARE NOWAIT;
  IF NOT FOUND OR j.kind<>'query' OR j.requester_membership_id IS DISTINCT FROM app.current_membership_id()
    OR j.state NOT IN('prepared','running') OR j.fenced_at IS NOT NULL OR j.deadline_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=NEW.organization_id and m.id=j.requester_membership_id and m.status='active') THEN
    RAISE EXCEPTION 'MODEL_JOB_CLOSED' USING ERRCODE='EN120';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_model_payload() FROM PUBLIC;
CREATE TRIGGER model_payload_fence BEFORE INSERT ON ai.model_job_payloads FOR EACH ROW EXECUTE FUNCTION ai.guard_model_payload();
CREATE FUNCTION ai.guard_model_qualification_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'ai.model_operation_qualifications'::regclass OR TG_OP<>'UPDATE' OR current_user<>'ensemus_agent'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR OLD.state<>'requested' OR NEW.state NOT IN('passed','failed')
    OR(to_jsonb(NEW)-ARRAY['state','result_digest','qualified_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','result_digest','qualified_at']) THEN RAISE EXCEPTION 'MODEL_QUALIFICATION_IMMUTABLE' USING ERRCODE='EN120';END IF;
  IF NEW.state='passed' THEN
    IF NEW.result_digest IS NULL OR NOT EXISTS(SELECT 1 FROM ai.model_jobs j JOIN ai.model_call_attempts c ON c.organization_id=j.organization_id and c.job_id=j.id
      WHERE j.organization_id=NEW.organization_id and j.qualification_id=NEW.id and c.qualification_id=NEW.id and c.state='accepted' and c.status='final') THEN RAISE EXCEPTION 'MODEL_QUALIFICATION_PROOF_REQUIRED' USING ERRCODE='EN120';END IF;
    NEW.qualified_at:=clock_timestamp();
  ELSE NEW.qualified_at:=NULL;END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_model_qualification_result() FROM PUBLIC;
CREATE TRIGGER model_qualification_result_guard BEFORE UPDATE ON ai.model_operation_qualifications FOR EACH ROW EXECUTE FUNCTION ai.guard_model_qualification_result();
CREATE TRIGGER model_qualification_no_delete BEFORE DELETE OR TRUNCATE ON ai.model_operation_qualifications FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER model_approval_no_delete BEFORE DELETE OR TRUNCATE ON ai.model_workload_approvals FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER model_job_no_delete BEFORE DELETE OR TRUNCATE ON ai.model_jobs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
-- Auxiliary calls cannot masquerade as an old unscoped reservation, a different job or another
-- run's step. Existing legacy agent rows retain their original independent checks and constraints.
CREATE FUNCTION ai.main_reservation_admitted(p_run uuid,p_step uuid,p_attempt integer,p_amount bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_user='ensemus_agent' and app.current_actor_type()='agent' and p_run::text=current_setting('app.agent_run_id',true) and(
    NOT EXISTS(SELECT 1 FROM ai.model_call_attempts c WHERE c.organization_id=app.current_organization_id() and c.run_id=p_run)
    OR(current_setting('app.knowledge_model_protocol',true)=('main-v1:'||p_run::text||':'||p_step::text||':'||p_attempt::text||':'||p_amount::text)
      and ai.run_input_admitted(p_run) and EXISTS(SELECT 1 FROM ai.agent_runs r JOIN ai.execution_steps s ON s.organization_id=r.organization_id and s.run_id=r.id
        WHERE r.organization_id=app.current_organization_id() and r.id=p_run and r.status='running' and r.initiator_membership_id=app.current_membership_id()
          and s.id=p_step and s.kind='model_turn' and s.state='in_flight' and p_attempt>=s.attempt and(p_attempt-s.attempt)%1000=0))),false)
$$;
REVOKE ALL ON FUNCTION ai.main_reservation_admitted(uuid,uuid,integer,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.main_reservation_admitted(uuid,uuid,integer,bigint) TO ensemus_agent;
CREATE FUNCTION ai.guard_model_money_principal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c ai.model_call_attempts%ROWTYPE;r record;b record;card record;expected_cost numeric;expected_quantity bigint;
BEGIN
  IF TG_OP<>'INSERT' OR TG_RELID NOT IN('platform.usage_ledger'::regclass,'platform.budget_reservations'::regclass) THEN RAISE EXCEPTION 'MODEL_MONEY_TARGET' USING ERRCODE='42501';END IF;
  IF NEW.model_call_id IS NULL THEN
    IF TG_RELID='platform.budget_reservations'::regclass AND EXISTS(SELECT 1 FROM ai.model_call_attempts prior_call WHERE prior_call.organization_id=NEW.organization_id and prior_call.run_id=NEW.run_id) THEN
      IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NOT ai.main_reservation_admitted(NEW.run_id,NEW.step_id,NEW.attempt,NEW.amount_micros) THEN
        RAISE EXCEPTION 'MAIN_MODEL_ADMISSION_REQUIRED' USING ERRCODE='EN120';END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF current_user<>'ensemus_agent' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'MODEL_RUNTIME_REQUIRED' USING ERRCODE='42501';END IF;
  SELECT * INTO c FROM ai.model_call_attempts WHERE organization_id=NEW.organization_id and id=NEW.model_call_id;
  IF NOT FOUND OR NEW.model_job_id IS DISTINCT FROM c.job_id OR NEW.run_id IS DISTINCT FROM c.run_id OR NEW.step_id IS DISTINCT FROM c.step_id THEN RAISE EXCEPTION 'MODEL_MONEY_PRINCIPAL' USING ERRCODE='EN120';END IF;
  IF TG_RELID='platform.budget_reservations'::regclass THEN
    IF NEW.amount_micros<>c.reserved_micros OR NEW.status<>'held' OR c.state NOT IN('prepared','dispatched') THEN RAISE EXCEPTION 'MODEL_RESERVATION_INVALID' USING ERRCODE='EN120';END IF;
    SELECT * INTO b FROM platform.budgets WHERE organization_id=NEW.organization_id and id=NEW.budget_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'MODEL_BUDGET_REQUIRED' USING ERRCODE='EN120';END IF;
    IF c.job_id IS NOT NULL AND b.scope<>'organization' THEN RAISE EXCEPTION 'MODEL_BUDGET_PRINCIPAL' USING ERRCODE='EN120';END IF;
    IF c.run_id IS NOT NULL THEN
      SELECT * INTO r FROM ai.agent_runs WHERE organization_id=c.organization_id and id=c.run_id;
      IF b.scope='agent_version' AND b.agent_version_id<>r.agent_version_id THEN RAISE EXCEPTION 'MODEL_BUDGET_PRINCIPAL' USING ERRCODE='EN120';END IF;
    END IF;
  ELSE
    IF c.state NOT IN('response_received','accepted','unknown','refused') OR NEW.profile_id IS DISTINCT FROM c.profile_id
      OR NEW.profile_version IS DISTINCT FROM c.profile_version OR NEW.request_hash IS DISTINCT FROM c.request_hash
      OR NEW.rate_card_id IS DISTINCT FROM c.rate_card_id OR NEW.rate_card_version IS DISTINCT FROM c.rate_card_version THEN RAISE EXCEPTION 'MODEL_USAGE_PRINCIPAL' USING ERRCODE='EN120';END IF;
    IF NEW.meter NOT IN('model_input_tokens','model_output_tokens') OR NEW.unit<>'token' OR NEW.status IS DISTINCT FROM c.status
      OR NEW.billing_period IS DISTINCT FROM c.billing_period OR NEW.commercial_mode IS DISTINCT FROM c.commercial_mode
      OR NEW.billable IS DISTINCT FROM(c.commercial_mode='cloud' and c.billing_owner='ensemus')
      OR NEW.corrects_id is not null OR NOT EXISTS(SELECT 1 FROM platform.budget_reservations h WHERE h.organization_id=NEW.organization_id and h.id=NEW.reservation_id and h.model_call_id=c.id) THEN RAISE EXCEPTION 'MODEL_USAGE_RECEIPT' USING ERRCODE='EN120';END IF;
    SELECT * INTO card FROM ai.rate_cards WHERE organization_id=c.organization_id and id=c.rate_card_id and version=c.rate_card_version;
    IF NOT FOUND THEN RAISE EXCEPTION 'MODEL_RATE_CARD_REQUIRED' USING ERRCODE='EN120';END IF;
    IF NEW.meter='model_input_tokens' THEN
      expected_quantity:=c.input_tokens;
      expected_cost:=CASE WHEN c.status='estimated' THEN c.reserved_micros ELSE ceil(c.input_tokens::numeric*card.input_micros_per_mtok::numeric/1000000) END;
    ELSE
      expected_quantity:=c.output_tokens;
      expected_cost:=CASE WHEN c.status='estimated' THEN 0 ELSE ceil(c.output_tokens::numeric*card.output_micros_per_mtok::numeric/1000000) END;
    END IF;
    IF NEW.quantity IS DISTINCT FROM expected_quantity OR NEW.cost_micros::numeric IS DISTINCT FROM expected_cost THEN RAISE EXCEPTION 'MODEL_USAGE_RECEIPT' USING ERRCODE='EN120';END IF;
    IF c.run_id IS NOT NULL THEN
      SELECT * INTO r FROM ai.agent_runs WHERE organization_id=c.organization_id and id=c.run_id;
      IF NEW.work_unit_id IS DISTINCT FROM r.work_unit_id THEN RAISE EXCEPTION 'MODEL_USAGE_WORK' USING ERRCODE='EN120';END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_model_money_principal() FROM PUBLIC;
CREATE TRIGGER model_reservation_principal BEFORE INSERT ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION ai.guard_model_money_principal();
CREATE TRIGGER model_usage_principal BEFORE INSERT ON platform.usage_ledger FOR EACH ROW EXECUTE FUNCTION ai.guard_model_money_principal();
-- Old bundled workers cannot reuse an existing main hold by taking over an auxiliary-influenced
-- step without the new runtime. INSERT admission alone would miss the existing-hold fast path.
CREATE FUNCTION ai.guard_auxiliary_main_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'ai.execution_steps'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN RAISE EXCEPTION 'MAIN_RUNTIME_TARGET' USING ERRCODE='42501';END IF;
  IF NEW.kind='model_turn' AND NEW.state='in_flight' AND EXISTS(SELECT 1 FROM ai.model_call_attempts c WHERE c.organization_id=NEW.organization_id and c.run_id=NEW.run_id) THEN
    IF TG_OP='UPDATE' THEN
      IF NEW.attempt IS NOT DISTINCT FROM OLD.attempt THEN RETURN NEW;END IF;
    END IF;
    IF current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR NEW.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true)
      OR current_setting('app.knowledge_model_protocol',true) IS DISTINCT FROM 'main-runtime-v1' THEN
      RAISE EXCEPTION 'MAIN_MODEL_RUNTIME_REQUIRED' USING ERRCODE='EN120';END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_auxiliary_main_runtime() FROM PUBLIC;
CREATE TRIGGER auxiliary_main_runtime BEFORE INSERT OR UPDATE OF attempt,state ON ai.execution_steps FOR EACH ROW EXECUTE FUNCTION ai.guard_auxiliary_main_runtime();
CREATE FUNCTION ai.guard_auxiliary_model_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  IF TG_OP<>'INSERT' OR TG_RELID NOT IN('ai.step_payloads'::regclass,'ai.tool_proposals'::regclass) THEN RAISE EXCEPTION 'MODEL_RESULT_TARGET' USING ERRCODE='42501';END IF;
  SELECT id,run_id,kind,state,attempt INTO s FROM ai.execution_steps WHERE organization_id=NEW.organization_id and id=NEW.step_id FOR SHARE NOWAIT;
  IF s.kind='model_turn' AND EXISTS(SELECT 1 FROM ai.model_call_attempts c WHERE c.organization_id=NEW.organization_id and c.run_id=s.run_id) THEN
    IF current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR s.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR s.state<>'in_flight'
      OR current_setting('app.knowledge_model_protocol',true) IS DISTINCT FROM('model-result-v1:'||s.run_id::text||':'||s.id::text||':'||s.attempt::text)
      OR NOT ai.run_input_admitted(s.run_id) THEN RAISE EXCEPTION 'MODEL_RESULT_ATTEMPT_STALE' USING ERRCODE='EN119';END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_auxiliary_model_result() FROM PUBLIC;
CREATE TRIGGER auxiliary_model_payload BEFORE INSERT ON ai.step_payloads FOR EACH ROW EXECUTE FUNCTION ai.guard_auxiliary_model_result();
CREATE TRIGGER auxiliary_model_proposal BEFORE INSERT ON ai.tool_proposals FOR EACH ROW EXECUTE FUNCTION ai.guard_auxiliary_model_result();
--> statement-breakpoint
-- Historical unqualified spaces remain for provenance but cannot be reactivated or mixed with an
-- identically named model behind another profile/endpoint. No legacy embedding precision is guessed.
ALTER TABLE knowledge.embedding_spaces ADD COLUMN qualification_id uuid,
  ADD CONSTRAINT embedding_spaces_qualification_fk FOREIGN KEY(organization_id,qualification_id) REFERENCES ai.model_operation_qualifications(organization_id,id);
ALTER TABLE knowledge.embedding_spaces DROP CONSTRAINT knowledge_embedding_spaces_identity;
ALTER TABLE knowledge.embedding_spaces ADD CONSTRAINT knowledge_embedding_spaces_identity UNIQUE(organization_id,model_profile_ref,model_profile_version,qualification_id,model_id,dimension,vector_space_version);
CREATE FUNCTION ai.guard_qualified_embedding_space() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.state='retired' AND(to_jsonb(NEW)-ARRAY['state','retired_at'])=(to_jsonb(OLD)-ARRAY['state','retired_at']) THEN RETURN NEW;END IF;
  END IF;
  IF TG_RELID<>'knowledge.embedding_spaces'::regclass OR TG_OP NOT IN('INSERT','UPDATE') OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NOT EXISTS(
    SELECT 1 FROM ai.model_operation_qualifications q JOIN ai.model_profiles p ON p.organization_id=q.organization_id and p.id=q.profile_id
    WHERE q.organization_id=NEW.organization_id and q.id=NEW.qualification_id and q.state='passed' and q.purpose='embed' and q.protocol='native_embedding_v1'
      and q.profile_id=NEW.model_profile_ref and q.profile_version=NEW.model_profile_version and p.version=q.profile_version and p.status='active'
      and p.model_id=NEW.model_id and q.dimension=NEW.dimension and q.vector_space_version=NEW.vector_space_version) THEN RAISE EXCEPTION 'EMBEDDING_QUALIFICATION_REQUIRED' USING ERRCODE='EN120';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_qualified_embedding_space() FROM PUBLIC;
CREATE TRIGGER embedding_space_qualified BEFORE INSERT OR UPDATE ON knowledge.embedding_spaces FOR EACH ROW EXECUTE FUNCTION ai.guard_qualified_embedding_space();
--> statement-breakpoint
ALTER TABLE knowledge.evidence_packages DROP CONSTRAINT knowledge_evidence_packages_purpose;
ALTER TABLE knowledge.evidence_packages ADD CONSTRAINT knowledge_evidence_packages_purpose CHECK(purpose in('answer','agent_turn','query'));
--> statement-breakpoint
CREATE FUNCTION ai.model_source_payloads_purged(p_source uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM ai.model_call_inputs i JOIN ai.model_call_attempts c ON c.organization_id=i.organization_id and c.id=i.call_id
    JOIN ai.model_jobs j ON j.organization_id=c.organization_id and j.id=c.job_id
    WHERE i.organization_id=app.current_organization_id() and i.source_id=p_source
      and(j.fenced_at is null or j.fence_generation<>1 or j.payloads_purged_at is null or j.purged_fence_generation is distinct from j.fence_generation))
$$;
REVOKE ALL ON FUNCTION ai.model_source_payloads_purged(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.model_source_payloads_purged(uuid) TO ensemus_app;
CREATE FUNCTION ai.guard_model_source_purge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'knowledge.purge_jobs'::regclass OR TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'MODEL_PURGE_TARGET' USING ERRCODE='42501';END IF;
  IF NEW.state='completed' AND NOT ai.model_source_payloads_purged(NEW.source_id) THEN RAISE EXCEPTION 'MODEL_JOB_PURGE_UNCONFIRMED' USING ERRCODE='EN120';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_model_source_purge() FROM PUBLIC;
CREATE TRIGGER model_job_source_purge_guard BEFORE UPDATE OF state ON knowledge.purge_jobs FOR EACH ROW EXECUTE FUNCTION ai.guard_model_source_purge();
CREATE FUNCTION ai.certify_model_job_payload_erasure(p_job uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_user='ensemus_eraser' AND EXISTS(SELECT 1 FROM ai.model_jobs j WHERE j.organization_id=app.current_organization_id()
    and j.id=p_job and j.fenced_at is not null and j.fence_generation=1 and j.payloads_purged_at is not null and j.purged_fence_generation=j.fence_generation),false)
$$;
REVOKE ALL ON FUNCTION ai.certify_model_job_payload_erasure(uuid) FROM PUBLIC;
CREATE FUNCTION ai.guard_model_metadata_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c ai.model_call_attempts%ROWTYPE;
BEGIN
  IF TG_OP<>'DELETE' OR current_user<>'ensemus_eraser' OR OLD.organization_id IS DISTINCT FROM app.current_organization_id()
    OR TG_RELID NOT IN('ai.model_jobs'::regclass,'ai.model_call_attempts'::regclass,'ai.model_call_inputs'::regclass) THEN RAISE EXCEPTION 'RETAIN_MODEL_INPUT_PROOF' USING ERRCODE='42501';END IF;
  IF TG_RELID='ai.model_jobs'::regclass THEN
    IF NOT ai.certify_model_job_payload_erasure(OLD.id) THEN RAISE EXCEPTION 'MODEL_PAYLOAD_ERASURE_UNCONFIRMED' USING ERRCODE='EN120';END IF;
  ELSE
    IF TG_RELID='ai.model_call_inputs'::regclass THEN SELECT * INTO c FROM ai.model_call_attempts WHERE organization_id=OLD.organization_id and id=OLD.call_id;
    ELSE c:=OLD;END IF;
    IF c.id is null OR c.state in('prepared','dispatched') OR EXISTS(SELECT 1 FROM platform.budget_reservations b WHERE b.organization_id=c.organization_id and b.model_call_id=c.id and b.status='held') THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_UNCONFIRMED' USING ERRCODE='EN120';END IF;
    IF c.job_id is not null THEN
      IF NOT ai.certify_model_job_payload_erasure(c.job_id) THEN RAISE EXCEPTION 'MODEL_PAYLOAD_ERASURE_UNCONFIRMED' USING ERRCODE='EN120';END IF;
    ELSE
      IF NOT ai.certify_run_payload_erasure(c.run_id) THEN RAISE EXCEPTION 'RUN_PAYLOAD_ERASURE_UNCONFIRMED' USING ERRCODE='EN119';END IF;
    END IF;
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION ai.guard_model_metadata_erasure() FROM PUBLIC;
CREATE TRIGGER model_job_erasure_proof BEFORE DELETE ON ai.model_jobs FOR EACH ROW EXECUTE FUNCTION ai.guard_model_metadata_erasure();
CREATE TRIGGER model_call_erasure_proof BEFORE DELETE ON ai.model_call_attempts FOR EACH ROW EXECUTE FUNCTION ai.guard_model_metadata_erasure();
CREATE TRIGGER model_input_erasure_proof BEFORE DELETE ON ai.model_call_inputs FOR EACH ROW EXECUTE FUNCTION ai.guard_model_metadata_erasure();
-- 0999 must repeat this narrow metadata receipt capability if the eraser is provisioned afterward.
-- It must also keep append-only row guards and FK order; no trigger-disable/body SELECT shortcut.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ensemus_eraser') THEN
  GRANT SELECT ON ai.model_jobs,ai.model_call_attempts,ai.model_call_inputs TO ensemus_eraser;
  GRANT EXECUTE ON FUNCTION ai.certify_model_job_payload_erasure(uuid) TO ensemus_eraser;
  CREATE POLICY model_job_eraser_read ON ai.model_jobs FOR SELECT TO ensemus_eraser USING(organization_id=app.current_organization_id());
  CREATE POLICY model_call_eraser_read ON ai.model_call_attempts FOR SELECT TO ensemus_eraser USING(organization_id=app.current_organization_id());
  CREATE POLICY model_input_eraser_read ON ai.model_call_inputs FOR SELECT TO ensemus_eraser USING(organization_id=app.current_organization_id());
END IF;END $$;
--> statement-breakpoint
-- Result serving uses all retained actual inputs, rather than just final model-selected citations.
-- This invoker-rights predicate returns no body and grants no broader reader capability.
CREATE FUNCTION ai.model_job_inputs_readable(p_job uuid,p_viewer uuid,p_class text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(knowledge.class_rank(p_class) is not null and(p_viewer=app.current_membership_id() or knowledge.is_service_actor())
    and EXISTS(SELECT 1 FROM ai.model_jobs j JOIN org.memberships m ON m.organization_id=j.organization_id and m.id=j.requester_membership_id and m.status='active'
      WHERE j.organization_id=app.current_organization_id() and j.id=p_job and j.requester_membership_id=p_viewer)
    and NOT EXISTS(SELECT 1 FROM ai.model_call_attempts c JOIN ai.model_call_inputs i ON i.organization_id=c.organization_id and i.call_id=c.id
      WHERE c.organization_id=app.current_organization_id() and c.job_id=p_job and(
        knowledge.class_rank(i.classification)>knowledge.class_rank(p_class) OR
        CASE WHEN i.kind='chunk' THEN NOT EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=i.organization_id and s.id=i.source_id and s.state='active'
          and s.id IN(SELECT knowledge.readable_source_ids(p_viewer)) and knowledge.class_rank(s.classification)<=knowledge.class_rank(p_class))
          OR NOT EXISTS(SELECT 1 FROM knowledge.chunks ch JOIN knowledge.documents d ON d.organization_id=ch.organization_id and d.id=ch.document_id
            WHERE ch.organization_id=i.organization_id and ch.id=i.input_id and ch.source_id=i.source_id and ch.content_sha256=i.sha256 and d.state='searchable' and d.superseded_at is null and knowledge.class_rank(d.classification)<=knowledge.class_rank(p_class))
        ELSE NOT knowledge.structured_record_readable(i.kind,i.input_id,p_viewer) OR knowledge.structured_record_class(i.kind,i.input_id) is null
          OR knowledge.class_rank(knowledge.structured_record_class(i.kind,i.input_id))>knowledge.class_rank(p_class) END)),false)
$$;
REVOKE ALL ON FUNCTION ai.model_job_inputs_readable(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.model_job_inputs_readable(uuid,uuid,text) TO ensemus_app;
CREATE POLICY model_job_inputs_live ON knowledge.answers AS RESTRICTIVE FOR SELECT TO ensemus_app USING(
  knowledge.is_service_actor() OR NOT EXISTS(SELECT 1 FROM ai.model_jobs j WHERE j.organization_id=answers.organization_id and j.answer_id=answers.id
    and NOT ai.model_job_inputs_readable(j.id,answers.requester_membership_id,coalesce(answers.strongest_classification,answers.question_classification))));
