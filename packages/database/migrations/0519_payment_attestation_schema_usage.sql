-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- 0519: additive repair for registered 0512. 0512 granted EXECUTE on its three native broker
-- attestation functions to ensemus_secrets, but never granted USAGE on schema billing, so the broker
-- (packages/database/src/secrets.ts) could not even name them: every native payment identity, lookup
-- and webhook attestation failed with "permission denied for schema billing" (42501).
-- Schema USAGE adds no table, column, sequence or body grant. It is admitted only when the broker's
-- resulting billing reach is exactly those three session_user-guarded SECURITY DEFINER functions
-- (trigger functions cannot be called directly) and no billing relation privilege at all.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'PAYMENT_GUARD_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('billing.attest_payment_identity(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,uuid)') IS NULL
  OR to_regprocedure('billing.attest_payment_lookup(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text)') IS NULL
  OR to_regprocedure('billing.attest_payment_webhook(uuid,text,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,uuid)') IS NULL THEN
  RAISE EXCEPTION 'PAYMENT_ATTESTATION_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA billing TO ensemus_secrets;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='billing'
   AND(has_table_privilege('ensemus_secrets',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR(c.relkind IN('r','p','v','m','f') AND has_any_column_privilege('ensemus_secrets',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))) THEN
  RAISE EXCEPTION 'PAYMENT_BROKER_BILLING_REACH_UNREVIEWED' USING ERRCODE='EN850';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='billing'
   AND p.prorettype<>'trigger'::regtype AND has_function_privilege('ensemus_secrets',p.oid,'EXECUTE')
   AND p.oid NOT IN('billing.attest_payment_identity(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,uuid)'::regprocedure,
    'billing.attest_payment_lookup(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure,
    'billing.attest_payment_webhook(uuid,text,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,uuid)'::regprocedure)) THEN
  RAISE EXCEPTION 'PAYMENT_BROKER_BILLING_REACH_UNREVIEWED' USING ERRCODE='EN850';END IF;
END $$;
