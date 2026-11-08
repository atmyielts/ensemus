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
