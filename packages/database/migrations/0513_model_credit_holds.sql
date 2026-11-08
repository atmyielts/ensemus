-- INCOMPLETE/UNREGISTERED source: fixed birth/admission/native-outcome/settlement functions are still
-- being composed. Never apply or relax the common Cloud refusal from this table foundation alone.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'MODEL_CREDIT_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('app.current_auth_restore_generation()') IS NULL THEN
  RAISE EXCEPTION 'MODEL_CREDIT_RESTORE_GUARD_REQUIRED' USING ERRCODE='EN422';END IF;
END $$;
--> statement-breakpoint
ALTER TABLE ai.main_input_snapshots ADD COLUMN max_input_tokens integer,ADD COLUMN max_output_tokens integer;
ALTER TABLE ai.main_input_snapshots ADD CONSTRAINT main_input_snapshots_token_ceiling CHECK(
 (max_input_tokens IS NULL AND max_output_tokens IS NULL) OR
 (max_input_tokens IS NOT NULL AND max_input_tokens>=0 AND max_output_tokens IS NOT NULL AND max_output_tokens>=0));
-- Only the existing actual agent may create these values; the original generic immutable tuple guard
-- also makes the new fields immutable on UPDATE. Legacy NULL is deliberately not backfilled.
GRANT SELECT(max_input_tokens,max_output_tokens) ON ai.main_input_snapshots TO ensemus_agent;
--> statement-breakpoint
CREATE TABLE billing.model_credit_holds(
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),main_snapshot_id uuid,model_call_id uuid,usd_reservation_id uuid,
 birth_transaction text NOT NULL,writer_token uuid NOT NULL,restore_generation uuid NOT NULL,
 request_sha256 text NOT NULL,profile_id uuid NOT NULL,profile_version integer NOT NULL,max_input_tokens integer NOT NULL,max_output_tokens integer NOT NULL,
 billing_period_id uuid NOT NULL,plan_version_id uuid NOT NULL,rate_card_id uuid NOT NULL,rate_card_version integer NOT NULL,
 input_microcredits_per_token bigint NOT NULL,output_microcredits_per_token bigint NOT NULL,ceiling_microcredits bigint NOT NULL,
 state text NOT NULL DEFAULT 'pending',input_usage_id uuid,output_usage_id uuid,charged_microcredits bigint,
 outcome_token_sha256 text,outcome_kind text,outcome_input_tokens integer,outcome_output_tokens integer,outcome_sha256 text,
 outcome_restore_generation uuid,outcome_issued_at timestamptz,outcome_expires_at timestamptz,outcome_consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),dispatched_at timestamptz,settled_at timestamptz,
 CONSTRAINT model_credit_holds_pk PRIMARY KEY(organization_id,id),
 CONSTRAINT model_credit_main_once UNIQUE(organization_id,main_snapshot_id),
 CONSTRAINT model_credit_call_once UNIQUE(organization_id,model_call_id),
 CONSTRAINT model_credit_outcome_token UNIQUE(outcome_token_sha256),
 CONSTRAINT model_credit_org FOREIGN KEY(organization_id) REFERENCES org.organizations(id),
 CONSTRAINT model_credit_main FOREIGN KEY(organization_id,main_snapshot_id) REFERENCES ai.main_input_snapshots(organization_id,id),
 CONSTRAINT model_credit_call FOREIGN KEY(organization_id,model_call_id) REFERENCES ai.model_call_attempts(organization_id,id),
 CONSTRAINT model_credit_usd_reservation FOREIGN KEY(organization_id,usd_reservation_id) REFERENCES platform.budget_reservations(organization_id,id),
 CONSTRAINT model_credit_profile FOREIGN KEY(organization_id,profile_id) REFERENCES ai.model_profiles(organization_id,id),
 CONSTRAINT model_credit_period FOREIGN KEY(organization_id,billing_period_id) REFERENCES billing.billing_periods(organization_id,id),
 CONSTRAINT model_credit_plan FOREIGN KEY(plan_version_id) REFERENCES billing.plan_versions(id),
 CONSTRAINT model_credit_card FOREIGN KEY(rate_card_id) REFERENCES billing.rate_cards(id),
 CONSTRAINT model_credit_input_usage FOREIGN KEY(organization_id,input_usage_id) REFERENCES platform.usage_ledger(organization_id,id),
 CONSTRAINT model_credit_output_usage FOREIGN KEY(organization_id,output_usage_id) REFERENCES platform.usage_ledger(organization_id,id),
 CONSTRAINT model_credit_principal CHECK((main_snapshot_id IS NOT NULL AND model_call_id IS NULL) OR(main_snapshot_id IS NULL AND model_call_id IS NOT NULL)),
 CONSTRAINT model_credit_identity CHECK(profile_version>0 AND rate_card_version>0 AND request_sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT model_credit_ceiling CHECK(max_input_tokens>=0 AND max_output_tokens>=0 AND input_microcredits_per_token>=0 AND output_microcredits_per_token>=0
  AND ceiling_microcredits>=0 AND ceiling_microcredits::numeric=max_input_tokens::numeric*input_microcredits_per_token::numeric+max_output_tokens::numeric*output_microcredits_per_token::numeric),
 CONSTRAINT model_credit_state CHECK(state IN('pending','prepared','dispatched','final','estimated','released')),
 CONSTRAINT model_credit_settlement CHECK((state IN('pending','prepared','dispatched') AND charged_microcredits IS NULL AND settled_at IS NULL AND input_usage_id IS NULL AND output_usage_id IS NULL)
  OR(state IN('final','estimated') AND charged_microcredits IS NOT NULL AND charged_microcredits>=0 AND settled_at IS NOT NULL AND input_usage_id IS NOT NULL AND(max_output_tokens=0 OR output_usage_id IS NOT NULL))
  OR(state='released' AND charged_microcredits IS NOT NULL AND charged_microcredits=0 AND settled_at IS NOT NULL)),
 CONSTRAINT model_credit_outcome CHECK((outcome_token_sha256 IS NULL AND outcome_kind IS NULL AND outcome_sha256 IS NULL AND outcome_input_tokens IS NULL AND outcome_output_tokens IS NULL
   AND outcome_restore_generation IS NULL AND outcome_issued_at IS NULL AND outcome_expires_at IS NULL AND outcome_consumed_at IS NULL)
  OR(outcome_token_sha256 IS NOT NULL AND outcome_token_sha256 ~ '^[0-9a-f]{64}$' AND outcome_kind IS NOT NULL AND outcome_sha256 IS NOT NULL AND outcome_sha256 ~ '^[0-9a-f]{64}$'
   AND outcome_restore_generation IS NOT NULL AND outcome_restore_generation=restore_generation AND outcome_issued_at IS NOT NULL AND outcome_expires_at IS NOT NULL AND outcome_expires_at>outcome_issued_at
   AND((outcome_kind='measured' AND outcome_input_tokens IS NOT NULL AND outcome_input_tokens>=0 AND outcome_output_tokens IS NOT NULL AND outcome_output_tokens>=0)
    OR(outcome_kind='not_sent' AND outcome_input_tokens IS NULL AND outcome_output_tokens IS NULL))))
);
CREATE INDEX model_credit_active ON billing.model_credit_holds(organization_id,state) WHERE state IN('pending','prepared','dispatched');
ALTER TABLE billing.model_credit_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.model_credit_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY model_credit_fixed_owner ON billing.model_credit_holds TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true))
 WITH CHECK(organization_id::text=current_setting('billing.model_credit_org',true));
REVOKE ALL ON billing.model_credit_holds FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_secrets,ensemus_eraser;
CREATE TRIGGER model_credit_evidence_keep BEFORE DELETE OR TRUNCATE ON billing.model_credit_holds FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
-- Fixed metadata scopes for this native worker protocol. No new runtime table/body grant.
CREATE POLICY model_credit_org_read ON org.organizations FOR SELECT TO ensemus_migrator
 USING(id::text=current_setting('billing.model_credit_org',true));
CREATE POLICY model_credit_org_lock ON org.organizations FOR UPDATE TO ensemus_migrator
 USING(id::text=current_setting('billing.model_credit_org',true)) WITH CHECK(false);
CREATE POLICY model_credit_account_control ON billing.credit_accounts TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true))
 WITH CHECK(organization_id::text=current_setting('billing.model_credit_org',true));
CREATE POLICY model_credit_subscription_read ON billing.subscriptions FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true));
CREATE POLICY model_credit_subscription_lock ON billing.subscriptions FOR UPDATE TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true)) WITH CHECK(false);
CREATE POLICY model_credit_period_read ON billing.billing_periods FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true));
CREATE POLICY model_credit_period_lock ON billing.billing_periods FOR UPDATE TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true)) WITH CHECK(false);
CREATE POLICY model_credit_profile_read ON ai.model_profiles FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true));
CREATE POLICY model_credit_profile_lock ON ai.model_profiles FOR UPDATE TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true)) WITH CHECK(false);
CREATE POLICY model_credit_usd_read ON platform.budget_reservations FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true));
CREATE POLICY model_credit_usage_read ON platform.usage_ledger FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true));
CREATE POLICY model_credit_ledger_read ON billing.credit_ledger FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true));
CREATE POLICY model_credit_snapshot_read ON ai.main_input_snapshots FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true));
CREATE POLICY model_credit_call_read ON ai.model_call_attempts FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true));
CREATE POLICY model_credit_job_read ON ai.model_jobs FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.model_credit_org',true));
CREATE POLICY model_credit_plan_read ON billing.plan_versions FOR SELECT TO ensemus_migrator
 USING(status IN('approved','retired') AND nullif(current_setting('billing.model_credit_org',true),'') IS NOT NULL);
CREATE POLICY model_credit_plan_kind_read ON billing.plans FOR SELECT TO ensemus_migrator
 USING(nullif(current_setting('billing.model_credit_org',true),'') IS NOT NULL);
CREATE POLICY model_credit_card_read ON billing.rate_cards FOR SELECT TO ensemus_migrator
 USING(status IN('approved','retired') AND nullif(current_setting('billing.model_credit_org',true),'') IS NOT NULL);
CREATE POLICY model_credit_rate_read ON billing.rate_card_lines FOR SELECT TO ensemus_migrator
 USING(nullif(current_setting('billing.model_credit_org',true),'') IS NOT NULL);
CREATE INDEX model_credit_unconfirmed_usage ON platform.usage_ledger(organization_id,status,id) WHERE billable AND commercial_mode='cloud';
CREATE UNIQUE INDEX model_credit_input_once ON billing.model_credit_holds(organization_id,input_usage_id) WHERE input_usage_id IS NOT NULL;
CREATE UNIQUE INDEX model_credit_output_once ON billing.model_credit_holds(organization_id,output_usage_id) WHERE output_usage_id IS NOT NULL;
--> statement-breakpoint
-- Only the actual fixed source AFTER INSERT can mint a pending financial birth. xmin/timestamps and
-- reusable caller admission rows are not substitutes for this event. A deferred completion check and
-- the same-Tx USD reservation binding are still being authored below before this migration can apply.
CREATE FUNCTION billing.record_model_credit_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.model_credit_org',true);at_time timestamptz:=clock_timestamp();org_id uuid;
 p_profile uuid;p_version integer;p_request text;p_input integer;p_output integer;main_id uuid;call_id uuid;
 actual_org record;profile record;terms record;in_rate record;out_rate record;ceiling numeric;generation uuid;j record;
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID NOT IN('ai.main_input_snapshots'::regclass,'ai.model_call_attempts'::regclass)
  OR session_user<>'ensemus_agent' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
  RAISE EXCEPTION 'MODEL_CREDIT_NATIVE_BIRTH_REQUIRED' USING ERRCODE='EN853';END IF;
 org_id:=NEW.organization_id;PERFORM set_config('billing.model_credit_org',org_id::text,true);
 IF TG_RELID='ai.main_input_snapshots'::regclass THEN
  IF app.current_actor_type() IS DISTINCT FROM 'agent' OR NEW.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true)
   OR NEW.viewer_membership_id IS DISTINCT FROM app.current_membership_id() OR NEW.state<>'prepared' THEN
   RAISE EXCEPTION 'MODEL_CREDIT_NATIVE_BIRTH_REQUIRED' USING ERRCODE='EN853';END IF;
  main_id:=NEW.id;
 ELSE
  IF NEW.state<>'prepared' OR current_setting('app.knowledge_model_protocol',true) IS DISTINCT FROM 'v1' THEN
   RAISE EXCEPTION 'MODEL_CREDIT_NATIVE_BIRTH_REQUIRED' USING ERRCODE='EN853';END IF;
  IF NEW.job_id IS NOT NULL THEN
   SELECT x.requester_membership_id INTO j FROM ai.model_jobs x WHERE x.organization_id=org_id AND x.id=NEW.job_id;
   IF coalesce(app.current_actor_type(),'') NOT IN('user','delegated') OR NEW.job_id::text IS DISTINCT FROM current_setting('app.model_job_id',true)
    OR j.requester_membership_id IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'MODEL_CREDIT_NATIVE_BIRTH_REQUIRED' USING ERRCODE='EN853';END IF;
  ELSIF app.current_actor_type() IS DISTINCT FROM 'agent' OR NEW.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) THEN
   RAISE EXCEPTION 'MODEL_CREDIT_NATIVE_BIRTH_REQUIRED' USING ERRCODE='EN853';END IF;
  call_id:=NEW.id;
 END IF;
 p_profile:=NEW.profile_id;p_version:=NEW.profile_version;p_request:=NEW.request_hash;
 p_input:=NEW.max_input_tokens;p_output:=NEW.max_output_tokens;
 SELECT o.id,o.commercial_mode,o.lifecycle INTO actual_org FROM org.organizations o WHERE o.id=org_id;
 SELECT p.id,p.billing_owner,p.version,p.status INTO profile FROM ai.model_profiles p WHERE p.organization_id=org_id AND p.id=p_profile;
 IF actual_org.id IS NULL OR profile.id IS NULL THEN RAISE EXCEPTION 'MODEL_CREDIT_UNAVAILABLE' USING ERRCODE='EN853';END IF;
 IF actual_org.commercial_mode IS DISTINCT FROM 'cloud' OR profile.billing_owner IS DISTINCT FROM 'ensemus' THEN
  PERFORM set_config('billing.model_credit_org',coalesce(prior,''),true);RETURN NEW;END IF;
 IF actual_org.lifecycle IS DISTINCT FROM 'active' OR profile.version IS DISTINCT FROM p_version OR(main_id IS NOT NULL AND profile.status IS DISTINCT FROM 'active')
  OR p_input IS NULL OR p_output IS NULL OR p_input<0 OR p_output<0 THEN
  RAISE EXCEPTION 'MODEL_CREDIT_UNAVAILABLE' USING ERRCODE='EN853';END IF;
 generation:=app.current_auth_restore_generation();
 SELECT b.id period_id,b.plan_version_id,b.rate_card_id,c.version card_version INTO terms
  FROM billing.subscriptions s JOIN billing.billing_periods b ON b.organization_id=s.organization_id AND b.subscription_id=s.id
  JOIN billing.plan_versions v ON v.id=b.plan_version_id JOIN billing.plans p ON p.id=v.plan_id
  JOIN billing.rate_cards c ON c.id=b.rate_card_id
  WHERE s.organization_id=org_id AND s.status IN('active','past_due') AND b.status='open'
   AND s.plan_version_id=b.plan_version_id AND s.current_period_start=b.starts_at AND s.current_period_end=b.ends_at
   AND b.starts_at<=at_time AND b.ends_at>at_time AND p.commercial_mode='cloud' AND v.status IN('approved','retired')
   AND v.rate_card_id=b.rate_card_id AND c.status IN('approved','retired') AND c.effective_from<=at_time;
 IF terms.period_id IS NULL THEN RAISE EXCEPTION 'MODEL_CREDIT_UNPRICED' USING ERRCODE='EN853';END IF;
 SELECT r.unit,r.microcredits_per_unit INTO in_rate FROM billing.rate_card_lines r WHERE r.rate_card_id=terms.rate_card_id AND r.meter='model_input_tokens';
 SELECT r.unit,r.microcredits_per_unit INTO out_rate FROM billing.rate_card_lines r WHERE r.rate_card_id=terms.rate_card_id AND r.meter='model_output_tokens';
 IF in_rate.unit IS DISTINCT FROM 'token' OR out_rate.unit IS DISTINCT FROM 'token' OR in_rate.microcredits_per_unit IS NULL OR out_rate.microcredits_per_unit IS NULL THEN
  RAISE EXCEPTION 'MODEL_CREDIT_UNPRICED' USING ERRCODE='EN853';END IF;
 ceiling:=p_input::numeric*in_rate.microcredits_per_unit::numeric+p_output::numeric*out_rate.microcredits_per_unit::numeric;
 IF ceiling<0 OR ceiling>9223372036854775807 THEN RAISE EXCEPTION 'MODEL_CREDIT_AMOUNT_UNREPRESENTABLE' USING ERRCODE='EN853';END IF;
 -- Pending birth is not spend authority. Actual account reservation follows the genuine USD
 -- INSERT witness, so this trigger never holds a credit-account lock while waiting on USD budgets.
 INSERT INTO billing.model_credit_holds(organization_id,main_snapshot_id,model_call_id,birth_transaction,writer_token,restore_generation,request_sha256,
  profile_id,profile_version,max_input_tokens,max_output_tokens,billing_period_id,plan_version_id,rate_card_id,rate_card_version,
  input_microcredits_per_token,output_microcredits_per_token,ceiling_microcredits)
 VALUES(org_id,main_id,call_id,pg_current_xact_id()::text,gen_random_uuid(),generation,p_request,p_profile,p_version,p_input,p_output,
  terms.period_id,terms.plan_version_id,terms.rate_card_id,terms.card_version,in_rate.microcredits_per_unit,out_rate.microcredits_per_unit,ceiling::bigint);
 PERFORM set_config('billing.model_credit_org',coalesce(prior,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.model_credit_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.record_model_credit_birth() FROM PUBLIC;
CREATE TRIGGER model_credit_main_birth AFTER INSERT ON ai.main_input_snapshots FOR EACH ROW EXECUTE FUNCTION billing.record_model_credit_birth();
CREATE TRIGGER model_credit_knowledge_birth AFTER INSERT ON ai.model_call_attempts FOR EACH ROW EXECUTE FUNCTION billing.record_model_credit_birth();
--> statement-breakpoint
CREATE FUNCTION billing.require_model_credit_birth_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.model_credit_org',true);h record;
BEGIN
 IF TG_RELID<>'billing.model_credit_holds'::regclass OR TG_OP NOT IN('INSERT','UPDATE') OR session_user NOT IN('ensemus_agent','ensemus_secrets','ensemus_app') THEN
  RAISE EXCEPTION 'MODEL_CREDIT_NATIVE_BIRTH_REQUIRED' USING ERRCODE='EN853';END IF;
 PERFORM set_config('billing.model_credit_org',NEW.organization_id::text,true);
 SELECT x.* INTO h FROM billing.model_credit_holds x WHERE x.organization_id=NEW.organization_id AND x.id=NEW.id;
 IF h.id IS NULL OR h.state='pending' OR h.restore_generation IS DISTINCT FROM app.current_auth_restore_generation() THEN
  RAISE EXCEPTION 'MODEL_CREDIT_BIRTH_INCOMPLETE' USING ERRCODE='EN853';END IF;
 IF h.main_snapshot_id IS NOT NULL THEN
  IF h.usd_reservation_id IS NULL OR NOT EXISTS(SELECT 1 FROM platform.budget_reservations b JOIN ai.main_input_snapshots s
   ON s.organization_id=b.organization_id AND s.id=h.main_snapshot_id AND s.run_id=b.run_id AND s.step_id=b.step_id AND s.reservation_attempt=b.attempt
   WHERE b.organization_id=h.organization_id AND b.id=h.usd_reservation_id AND b.model_call_id IS NULL) THEN
   RAISE EXCEPTION 'MODEL_CREDIT_RESERVATION_UNBOUND' USING ERRCODE='EN853';END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM platform.budget_reservations b WHERE b.organization_id=h.organization_id AND b.model_call_id=h.model_call_id) THEN
  RAISE EXCEPTION 'MODEL_CREDIT_RESERVATION_UNBOUND' USING ERRCODE='EN853';END IF;
 PERFORM set_config('billing.model_credit_org',coalesce(prior,''),true);RETURN NULL;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.model_credit_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.require_model_credit_birth_completion() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER model_credit_birth_complete AFTER INSERT OR UPDATE ON billing.model_credit_holds
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.require_model_credit_birth_completion();
--> statement-breakpoint
CREATE FUNCTION billing.record_model_credit_usd_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.model_credit_org',true);target uuid;
BEGIN
 IF TG_RELID<>'platform.budget_reservations'::regclass OR TG_OP<>'INSERT' OR session_user<>'ensemus_agent'
  OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
  RAISE EXCEPTION 'MODEL_CREDIT_USD_BIRTH_REQUIRED' USING ERRCODE='EN853';END IF;
 PERFORM set_config('billing.model_credit_org',NEW.organization_id::text,true);
 SELECT h.id INTO target FROM billing.model_credit_holds h WHERE h.organization_id=NEW.organization_id AND h.state='pending'
  AND h.birth_transaction=pg_current_xact_id()::text AND h.usd_reservation_id IS NULL AND(
   (NEW.model_call_id IS NOT NULL AND h.model_call_id=NEW.model_call_id) OR
   (NEW.model_call_id IS NULL AND h.main_snapshot_id IS NOT NULL AND EXISTS(SELECT 1 FROM ai.main_input_snapshots s
    WHERE s.organization_id=h.organization_id AND s.id=h.main_snapshot_id AND s.run_id=NEW.run_id AND s.step_id=NEW.step_id AND s.reservation_attempt=NEW.attempt)));
 IF target IS NOT NULL THEN
  IF NEW.status<>'held' THEN RAISE EXCEPTION 'MODEL_CREDIT_USD_BIRTH_REQUIRED' USING ERRCODE='EN853';END IF;
  UPDATE billing.model_credit_holds SET usd_reservation_id=NEW.id WHERE organization_id=NEW.organization_id AND id=target;
 END IF;
 PERFORM set_config('billing.model_credit_org',coalesce(prior,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.model_credit_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.record_model_credit_usd_birth() FROM PUBLIC;
CREATE TRIGGER model_credit_usd_birth AFTER INSERT ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION billing.record_model_credit_usd_birth();
--> statement-breakpoint
CREATE FUNCTION billing.reserve_model_credit(p_main uuid,p_call uuid,p_usd uuid)
 RETURNS TABLE("holdId" uuid,"writerToken" uuid,"requestSha256" text,"restoreGeneration" uuid,"maxInputTokens" integer,"maxOutputTokens" integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.model_credit_org',true);org_id uuid:=app.current_organization_id();h record;s record;c record;j record;
 actual_org record;account record;held numeric;generation uuid;
BEGIN
 IF session_user<>'ensemus_agent' OR org_id IS NULL OR(p_main IS NULL)=(p_call IS NULL) THEN
  RAISE EXCEPTION 'MODEL_CREDIT_CURRENT_CALL_REQUIRED' USING ERRCODE='EN853';END IF;
 generation:=app.current_auth_restore_generation();PERFORM set_config('billing.model_credit_org',org_id::text,true);
 SELECT x.* INTO h FROM billing.model_credit_holds x WHERE x.organization_id=org_id AND
  ((p_main IS NOT NULL AND x.main_snapshot_id=p_main)OR(p_call IS NOT NULL AND x.model_call_id=p_call));
 IF h.id IS NULL OR h.state<>'pending' OR h.birth_transaction IS DISTINCT FROM pg_current_xact_id()::text OR h.restore_generation IS DISTINCT FROM generation
  OR h.usd_reservation_id IS NULL OR(p_main IS NOT NULL AND h.usd_reservation_id IS DISTINCT FROM p_usd) OR(p_call IS NOT NULL AND p_usd IS NOT NULL) THEN
  RAISE EXCEPTION 'MODEL_CREDIT_NATIVE_BIRTH_REQUIRED' USING ERRCODE='EN853';END IF;
 IF p_main IS NOT NULL THEN
  SELECT x.id,x.run_id,x.viewer_membership_id,x.state INTO s FROM ai.main_input_snapshots x WHERE x.organization_id=org_id AND x.id=p_main;
  IF s.id IS NULL OR s.state<>'prepared' OR app.current_actor_type() IS DISTINCT FROM 'agent'
   OR s.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR s.viewer_membership_id IS DISTINCT FROM app.current_membership_id() THEN
   RAISE EXCEPTION 'MODEL_CREDIT_CURRENT_CALL_REQUIRED' USING ERRCODE='EN853';END IF;
 ELSE
  SELECT x.id,x.job_id,x.run_id,x.state INTO c FROM ai.model_call_attempts x WHERE x.organization_id=org_id AND x.id=p_call;
  IF c.id IS NULL OR c.state<>'prepared' OR current_setting('app.knowledge_model_protocol',true) IS DISTINCT FROM 'v1' THEN
   RAISE EXCEPTION 'MODEL_CREDIT_CURRENT_CALL_REQUIRED' USING ERRCODE='EN853';END IF;
  IF c.job_id IS NOT NULL THEN
   SELECT x.requester_membership_id INTO j FROM ai.model_jobs x WHERE x.organization_id=org_id AND x.id=c.job_id;
   IF coalesce(app.current_actor_type(),'') NOT IN('user','delegated') OR c.job_id::text IS DISTINCT FROM current_setting('app.model_job_id',true)
    OR j.requester_membership_id IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'MODEL_CREDIT_CURRENT_CALL_REQUIRED' USING ERRCODE='EN853';END IF;
  ELSIF app.current_actor_type() IS DISTINCT FROM 'agent' OR c.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) THEN
   RAISE EXCEPTION 'MODEL_CREDIT_CURRENT_CALL_REQUIRED' USING ERRCODE='EN853';END IF;
 END IF;
 -- All calls have their genuine USD INSERT witness now. Never hold the account mutex while
 -- acquiring USD budget locks; refuse NOWAIT if concurrent standing/account mutation is busy.
 SELECT o.id,o.lifecycle,o.commercial_mode INTO actual_org FROM org.organizations o WHERE o.id=org_id FOR NO KEY UPDATE NOWAIT;
 IF actual_org.id IS NULL OR actual_org.lifecycle<>'active' OR actual_org.commercial_mode<>'cloud' THEN
  RAISE EXCEPTION 'MODEL_CREDIT_UNAVAILABLE' USING ERRCODE='EN853';END IF;
 PERFORM sub.id FROM billing.subscriptions sub JOIN billing.billing_periods b ON b.organization_id=sub.organization_id AND b.subscription_id=sub.id
  WHERE sub.organization_id=org_id AND sub.status IN('active','past_due') AND b.id=h.billing_period_id AND b.status='open'
   AND sub.plan_version_id=h.plan_version_id AND b.plan_version_id=h.plan_version_id AND b.rate_card_id=h.rate_card_id
   AND sub.current_period_start=b.starts_at AND sub.current_period_end=b.ends_at AND b.starts_at<=clock_timestamp() AND b.ends_at>clock_timestamp()
  FOR SHARE OF sub,b NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'MODEL_CREDIT_PERIOD_CHANGED' USING ERRCODE='EN853';END IF;
 SELECT a.balance_microcredits INTO account FROM billing.credit_accounts a WHERE a.organization_id=org_id FOR UPDATE NOWAIT;
 IF account.balance_microcredits IS NULL OR account.balance_microcredits<=0 THEN RAISE EXCEPTION 'MODEL_CREDIT_EXHAUSTED' USING ERRCODE='EN853';END IF;
 IF EXISTS(SELECT 1 FROM platform.usage_ledger u WHERE u.organization_id=org_id AND u.billable AND u.commercial_mode='cloud' AND(
   NOT EXISTS(SELECT 1 FROM billing.credit_ledger l WHERE l.organization_id=org_id AND l.idempotency_key='usage:'||u.id::text)
   OR(u.status='estimated' AND NOT EXISTS(SELECT 1 FROM billing.model_credit_holds old WHERE old.organization_id=org_id AND(old.input_usage_id=u.id OR old.output_usage_id=u.id))))) THEN
  RAISE EXCEPTION 'MODEL_CREDIT_RECONCILIATION_REQUIRED' USING ERRCODE='EN853';END IF;
 SELECT coalesce(sum(x.ceiling_microcredits),0) INTO held FROM billing.model_credit_holds x WHERE x.organization_id=org_id AND x.id<>h.id AND x.state IN('prepared','dispatched');
 IF account.balance_microcredits::numeric-held<h.ceiling_microcredits THEN RAISE EXCEPTION 'MODEL_CREDIT_EXHAUSTED' USING ERRCODE='EN853';END IF;
 UPDATE billing.model_credit_holds SET state='prepared' WHERE organization_id=org_id AND id=h.id AND state='pending';
 RETURN QUERY SELECT h.id,h.writer_token,h.request_sha256,h.restore_generation,h.max_input_tokens,h.max_output_tokens;
 PERFORM set_config('billing.model_credit_org',coalesce(prior,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.model_credit_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.reserve_model_credit(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.reserve_model_credit(uuid,uuid,uuid) TO ensemus_agent;
