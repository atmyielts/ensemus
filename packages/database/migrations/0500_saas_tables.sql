-- ADR-032. Tables only. Roles, grants, RLS and triggers are in reviewed SQL, migration 0501. Written by
-- hand to match packages/database/src/schema-saas.ts, and the final merge adds this to the journal.
CREATE SCHEMA "billing";
--> statement-breakpoint
CREATE SCHEMA "lifecycle";
--> statement-breakpoint
CREATE SCHEMA "support";
--> statement-breakpoint
CREATE SCHEMA "operations";
--> statement-breakpoint

-- A tenant can now be read-only or on its way out. Nothing about this destroys data (ADR-032 D5).
ALTER TABLE "org"."organizations" DROP CONSTRAINT "organizations_lifecycle_check";
--> statement-breakpoint
ALTER TABLE "org"."organizations" ADD CONSTRAINT "organizations_lifecycle_check"
  CHECK ("org"."organizations"."lifecycle" in ('active','read_only','suspended','offboarding','deleted'));
--> statement-breakpoint

-- The price list. Global, owner-entered data: no row ships with the product (ADR-032 D2).
CREATE TABLE "billing"."rate_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"minor_unit_exponent" integer NOT NULL,
	"effective_from" timestamp with time zone,
	"drafted_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_cards_code_version" UNIQUE("code","version"),
	CONSTRAINT "rate_cards_status" CHECK ("billing"."rate_cards"."status" in ('draft','approved','retired')),
	CONSTRAINT "rate_cards_code_format" CHECK ("billing"."rate_cards"."code" ~ '^[a-z][a-z0-9-]{1,63}$'),
	CONSTRAINT "rate_cards_version_check" CHECK ("billing"."rate_cards"."version" > 0),
	CONSTRAINT "rate_cards_currency" CHECK ("billing"."rate_cards"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "rate_cards_exponent" CHECK ("billing"."rate_cards"."minor_unit_exponent" between 0 and 4),
	CONSTRAINT "rate_cards_approved" CHECK ("billing"."rate_cards"."status" = 'draft' OR ("billing"."rate_cards"."approved_by" IS NOT NULL AND "billing"."rate_cards"."approved_at" IS NOT NULL AND "billing"."rate_cards"."effective_from" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "billing"."rate_card_lines" (
	"rate_card_id" uuid NOT NULL REFERENCES "billing"."rate_cards"("id"),
	"meter" text NOT NULL,
	"unit" text NOT NULL,
	"microcredits_per_unit" bigint NOT NULL,
	CONSTRAINT "rate_card_lines_pk" PRIMARY KEY("rate_card_id","meter"),
	CONSTRAINT "rate_card_lines_meter" CHECK ("billing"."rate_card_lines"."meter" ~ '^[a-z][a-z0-9_.]{1,63}$'),
	CONSTRAINT "rate_card_lines_price" CHECK ("billing"."rate_card_lines"."microcredits_per_unit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing"."top_up_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rate_card_id" uuid NOT NULL REFERENCES "billing"."rate_cards"("id"),
	"code" text NOT NULL,
	"microcredits" bigint NOT NULL,
	"price_micros" bigint NOT NULL,
	CONSTRAINT "top_up_offers_code" UNIQUE("rate_card_id","code"),
	CONSTRAINT "top_up_offers_microcredits" CHECK ("billing"."top_up_offers"."microcredits" > 0),
	CONSTRAINT "top_up_offers_price" CHECK ("billing"."top_up_offers"."price_micros" > 0)
);
--> statement-breakpoint
CREATE TABLE "billing"."plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"commercial_mode" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code"),
	CONSTRAINT "plans_mode" CHECK ("billing"."plans"."commercial_mode" in ('cloud','byom')),
	CONSTRAINT "plans_code_format" CHECK ("billing"."plans"."code" ~ '^[a-z][a-z0-9-]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "billing"."plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL REFERENCES "billing"."plans"("id"),
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"billing_interval" text NOT NULL,
	"payment_terms_days" integer NOT NULL,
	"platform_fee_micros" bigint NOT NULL,
	"included_microcredits" bigint,
	"rate_card_id" uuid REFERENCES "billing"."rate_cards"("id"),
	"overage_policy" text,
	"features" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_active_members" integer,
	"drafted_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_versions_number" UNIQUE("plan_id","version"),
	CONSTRAINT "plan_versions_status" CHECK ("billing"."plan_versions"."status" in ('draft','approved','retired')),
	CONSTRAINT "plan_versions_version_check" CHECK ("billing"."plan_versions"."version" > 0),
	CONSTRAINT "plan_versions_currency" CHECK ("billing"."plan_versions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "plan_versions_interval" CHECK ("billing"."plan_versions"."billing_interval" in ('month','year')),
	CONSTRAINT "plan_versions_terms" CHECK ("billing"."plan_versions"."payment_terms_days" >= 0),
	CONSTRAINT "plan_versions_fee" CHECK ("billing"."plan_versions"."platform_fee_micros" >= 0),
	CONSTRAINT "plan_versions_included" CHECK ("billing"."plan_versions"."included_microcredits" IS NULL OR "billing"."plan_versions"."included_microcredits" >= 0),
	CONSTRAINT "plan_versions_overage" CHECK ("billing"."plan_versions"."overage_policy" IS NULL OR "billing"."plan_versions"."overage_policy" in ('pause','explicit_top_up')),
	CONSTRAINT "plan_versions_members" CHECK ("billing"."plan_versions"."max_active_members" IS NULL OR "billing"."plan_versions"."max_active_members" > 0),
	CONSTRAINT "plan_versions_approved" CHECK ("billing"."plan_versions"."status" = 'draft' OR ("billing"."plan_versions"."approved_by" IS NOT NULL AND "billing"."plan_versions"."approved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "billing"."collection_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"terms_ref" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"drafted_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_policies_version_unique" UNIQUE("version"),
	CONSTRAINT "collection_policies_status" CHECK ("billing"."collection_policies"."status" in ('draft','approved','retired')),
	CONSTRAINT "collection_policies_approved" CHECK ("billing"."collection_policies"."status" = 'draft' OR ("billing"."collection_policies"."approved_by" IS NOT NULL AND "billing"."collection_policies"."approved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "billing"."tax_treatments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" text NOT NULL,
	"region_code" text DEFAULT '' NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"treatment" text NOT NULL,
	"adviser_ref" text NOT NULL,
	"drafted_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_treatments_key" UNIQUE("country_code","region_code","version"),
	CONSTRAINT "tax_treatments_status" CHECK ("billing"."tax_treatments"."status" in ('draft','approved','retired')),
	CONSTRAINT "tax_treatments_treatment" CHECK ("billing"."tax_treatments"."treatment" in ('provider_computed','not_collected')),
	CONSTRAINT "tax_treatments_country" CHECK ("billing"."tax_treatments"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "tax_treatments_approved" CHECK ("billing"."tax_treatments"."status" = 'draft' OR ("billing"."tax_treatments"."approved_by" IS NOT NULL AND "billing"."tax_treatments"."approved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "billing"."provider_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_kind" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"source_ref" text NOT NULL,
	"entered_by" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"ledger_cost_micros" bigint,
	"difference_micros" bigint,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_bills_status" CHECK ("billing"."provider_bills"."status" in ('open','reconciled','disputed')),
	CONSTRAINT "provider_bills_period" CHECK ("billing"."provider_bills"."period_end" > "billing"."provider_bills"."period_start"),
	CONSTRAINT "provider_bills_currency" CHECK ("billing"."provider_bills"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "billing"."operator_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"target_ref" text NOT NULL,
	"operator_ref" text NOT NULL,
	"reason_code" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_actions_action" CHECK ("billing"."operator_actions"."action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);
--> statement-breakpoint

-- One tenant's billing. No foreign key points at a membership from here: invoices outlive their tenant's
-- members under retention rules, and an offboarded tenant's memberships are erased (ADR-032 D7).
CREATE TABLE "billing"."billing_accounts" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"billing_name" text NOT NULL,
	"billing_email" text NOT NULL,
	"country_code" text NOT NULL,
	"region_code" text DEFAULT '' NOT NULL,
	"postal_code" text,
	"tax_id" text,
	"processor" text,
	"processor_customer_ref" text,
	"customer_ref_hash" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "billing_accounts_one_per_tenant" UNIQUE("organization_id"),
	CONSTRAINT "billing_accounts_country" CHECK ("billing"."billing_accounts"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "billing_accounts_processor_pair" CHECK (("billing"."billing_accounts"."processor" IS NULL) = ("billing"."billing_accounts"."customer_ref_hash" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_customer_ref" ON "billing"."billing_accounts" ("processor","customer_ref_hash") WHERE "billing"."billing_accounts"."customer_ref_hash" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "billing"."subscriptions" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plan_version_id" uuid NOT NULL REFERENCES "billing"."plan_versions"("id"),
	"status" text DEFAULT 'active' NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"collection_policy_id" uuid REFERENCES "billing"."collection_policies"("id"),
	"created_by_ref" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "subscriptions_status" CHECK ("billing"."subscriptions"."status" in ('active','past_due','canceled')),
	CONSTRAINT "subscriptions_period" CHECK ("billing"."subscriptions"."current_period_end" > "billing"."subscriptions"."current_period_start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_live" ON "billing"."subscriptions" ("organization_id") WHERE "billing"."subscriptions"."status" <> 'canceled';
--> statement-breakpoint
CREATE TABLE "billing"."subscription_changes" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_plan_version_id" uuid REFERENCES "billing"."plan_versions"("id"),
	"to_plan_version_id" uuid REFERENCES "billing"."plan_versions"("id"),
	"effective_at" timestamp with time zone NOT NULL,
	"excess" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_ref" text NOT NULL,
	"reason_code" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_changes_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "subscription_changes_subscription" FOREIGN KEY ("organization_id","subscription_id") REFERENCES "billing"."subscriptions"("organization_id","id"),
	CONSTRAINT "subscription_changes_kind" CHECK ("billing"."subscription_changes"."kind" in ('created','plan_changed','cancel_requested','cancel_withdrawn','canceled'))
);
--> statement-breakpoint
CREATE TABLE "billing"."standing_changes" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"from_lifecycle" text NOT NULL,
	"to_lifecycle" text NOT NULL,
	"reason_code" text NOT NULL,
	"collection_policy_id" uuid REFERENCES "billing"."collection_policies"("id"),
	"actor_type" text NOT NULL,
	"actor_ref" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standing_changes_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "standing_changes_actor" CHECK ("billing"."standing_changes"."actor_type" in ('operator','system','membership'))
);
--> statement-breakpoint
CREATE TABLE "billing"."billing_periods" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL REFERENCES "billing"."plan_versions"("id"),
	"rate_card_id" uuid REFERENCES "billing"."rate_cards"("id"),
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "billing_periods_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "billing_periods_start" UNIQUE("organization_id","subscription_id","starts_at"),
	CONSTRAINT "billing_periods_subscription" FOREIGN KEY ("organization_id","subscription_id") REFERENCES "billing"."subscriptions"("organization_id","id"),
	CONSTRAINT "billing_periods_status" CHECK ("billing"."billing_periods"."status" in ('open','closed')),
	CONSTRAINT "billing_periods_range" CHECK ("billing"."billing_periods"."ends_at" > "billing"."billing_periods"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "billing"."credit_accounts" (
	"organization_id" uuid PRIMARY KEY NOT NULL REFERENCES "org"."organizations"("id"),
	"balance_microcredits" bigint DEFAULT 0 NOT NULL,
	"usage_cursor" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing"."top_ups" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL REFERENCES "billing"."top_up_offers"("id"),
	"microcredits" bigint NOT NULL,
	"price_micros" bigint NOT NULL,
	"currency" text NOT NULL,
	"quote_hash" text NOT NULL,
	"request_key" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by_membership_id" uuid NOT NULL,
	"invoice_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "top_ups_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "top_ups_request" UNIQUE("organization_id","request_key"),
	CONSTRAINT "top_ups_status" CHECK ("billing"."top_ups"."status" in ('requested','invoiced','paid','credited','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "billing"."credit_ledger" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"amount_microcredits" bigint NOT NULL,
	"billing_period_id" uuid,
	"rate_card_id" uuid REFERENCES "billing"."rate_cards"("id"),
	"usage_ref" text,
	"top_up_id" uuid,
	"corrects_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "credit_ledger_key" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "credit_ledger_kind" CHECK ("billing"."credit_ledger"."kind" in ('allocation','top_up','consumption','expiry','correction')),
	CONSTRAINT "credit_ledger_sign" CHECK (("billing"."credit_ledger"."kind" in ('allocation','top_up') AND "billing"."credit_ledger"."amount_microcredits" > 0) OR ("billing"."credit_ledger"."kind" in ('consumption','expiry') AND "billing"."credit_ledger"."amount_microcredits" <= 0) OR ("billing"."credit_ledger"."kind" = 'correction' AND "billing"."credit_ledger"."corrects_id" IS NOT NULL)),
	CONSTRAINT "credit_ledger_period" FOREIGN KEY ("organization_id","billing_period_id") REFERENCES "billing"."billing_periods"("organization_id","id"),
	CONSTRAINT "credit_ledger_top_up" FOREIGN KEY ("organization_id","top_up_id") REFERENCES "billing"."top_ups"("organization_id","id"),
	CONSTRAINT "credit_ledger_corrects" FOREIGN KEY ("organization_id","corrects_id") REFERENCES "billing"."credit_ledger"("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "billing"."invoices" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" bigint,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"subtotal_micros" bigint DEFAULT 0 NOT NULL,
	"tax_micros" bigint DEFAULT 0 NOT NULL,
	"total_micros" bigint DEFAULT 0 NOT NULL,
	"subscription_id" uuid,
	"billing_period_id" uuid,
	"top_up_id" uuid,
	"plan_version_id" uuid REFERENCES "billing"."plan_versions"("id"),
	"rate_card_id" uuid REFERENCES "billing"."rate_cards"("id"),
	"tax_treatment_id" uuid REFERENCES "billing"."tax_treatments"("id"),
	"tax_ref" text,
	"bill_to" jsonb,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason_code" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "invoices_number" UNIQUE("organization_id","invoice_number"),
	CONSTRAINT "invoices_kind" CHECK ("billing"."invoices"."kind" in ('subscription','top_up')),
	CONSTRAINT "invoices_status" CHECK ("billing"."invoices"."status" in ('draft','open','paid','void','uncollectible')),
	CONSTRAINT "invoices_total" CHECK ("billing"."invoices"."total_micros" = "billing"."invoices"."subtotal_micros" + "billing"."invoices"."tax_micros"),
	CONSTRAINT "invoices_source" CHECK (("billing"."invoices"."kind" = 'subscription' AND "billing"."invoices"."billing_period_id" IS NOT NULL AND "billing"."invoices"."top_up_id" IS NULL) OR ("billing"."invoices"."kind" = 'top_up' AND "billing"."invoices"."top_up_id" IS NOT NULL AND "billing"."invoices"."billing_period_id" IS NULL)),
	CONSTRAINT "invoices_subscription" FOREIGN KEY ("organization_id","subscription_id") REFERENCES "billing"."subscriptions"("organization_id","id"),
	CONSTRAINT "invoices_period" FOREIGN KEY ("organization_id","billing_period_id") REFERENCES "billing"."billing_periods"("organization_id","id"),
	CONSTRAINT "invoices_top_up" FOREIGN KEY ("organization_id","top_up_id") REFERENCES "billing"."top_ups"("organization_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_per_period" ON "billing"."invoices" ("organization_id","billing_period_id") WHERE "billing"."invoices"."billing_period_id" IS NOT NULL AND "billing"."invoices"."status" <> 'void';
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_per_top_up" ON "billing"."invoices" ("organization_id","top_up_id") WHERE "billing"."invoices"."top_up_id" IS NOT NULL AND "billing"."invoices"."status" <> 'void';
--> statement-breakpoint
CREATE TABLE "billing"."invoice_lines" (
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"kind" text NOT NULL,
	"meter" text,
	"quantity" bigint,
	"unit" text,
	"unit_price_micros" bigint,
	"amount_micros" bigint NOT NULL,
	"usage_ref" text,
	CONSTRAINT "invoice_lines_pk" PRIMARY KEY("organization_id","invoice_id","line_no"),
	CONSTRAINT "invoice_lines_invoice" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "billing"."invoices"("organization_id","id"),
	CONSTRAINT "invoice_lines_kind" CHECK ("billing"."invoice_lines"."kind" in ('platform_fee','usage','top_up','tax','rounding'))
);
--> statement-breakpoint
CREATE TABLE "billing"."payments" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_micros" bigint NOT NULL,
	"currency" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"status_reason" text,
	"processor" text NOT NULL,
	"processor_payment_ref" text,
	"requested_by_ref" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "payments_key" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "payments_invoice" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "billing"."invoices"("organization_id","id"),
	CONSTRAINT "payments_status" CHECK ("billing"."payments"."status" in ('ready','sending','reconciling','succeeded','failed','unknown','cancelled')),
	CONSTRAINT "payments_amount" CHECK ("billing"."payments"."amount_micros" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_live_per_invoice" ON "billing"."payments" ("organization_id","invoice_id") WHERE "billing"."payments"."status" in ('ready','sending','reconciling','unknown','succeeded');
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_processor_ref" ON "billing"."payments" ("organization_id","processor","processor_payment_ref") WHERE "billing"."payments"."processor_payment_ref" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "billing"."payment_attempts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"run_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"outcome_code" text,
	"processor_payment_ref" text,
	"finished_at" timestamp with time zone,
	CONSTRAINT "payment_attempts_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "payment_attempts_number" UNIQUE("organization_id","payment_id","attempt_no"),
	CONSTRAINT "payment_attempts_payment" FOREIGN KEY ("organization_id","payment_id") REFERENCES "billing"."payments"("organization_id","id"),
	CONSTRAINT "payment_attempts_outcome" CHECK ("billing"."payment_attempts"."outcome" in ('succeeded','declined','not_sent','indeterminate')),
	CONSTRAINT "payment_attempts_no_range" CHECK ("billing"."payment_attempts"."attempt_no" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "billing"."payment_events" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"processor" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"kind" text NOT NULL,
	"payment_id" uuid,
	"invoice_id" uuid,
	"amount_micros" bigint,
	"currency" text,
	"provider_occurred_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "payment_events_provider" UNIQUE("organization_id","processor","provider_event_id"),
	CONSTRAINT "payment_events_kind" CHECK ("billing"."payment_events"."kind" in ('payment_succeeded','payment_failed','payment_refunded','payment_disputed','customer_updated')),
	CONSTRAINT "payment_events_payment" FOREIGN KEY ("organization_id","payment_id") REFERENCES "billing"."payments"("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "billing"."payment_webhook_events" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"processor" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"kind" text NOT NULL,
	"customer_ref_hash" text NOT NULL,
	"processor_payment_ref" text,
	"payment_id" uuid,
	"amount_micros" bigint,
	"currency" text,
	"provider_occurred_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"target_organization_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "payment_webhook_events_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "payment_webhook_events_provider" UNIQUE("organization_id","processor","provider_event_id"),
	CONSTRAINT "payment_webhook_events_kind" CHECK ("billing"."payment_webhook_events"."kind" in ('payment_succeeded','payment_failed','payment_refunded','payment_disputed','customer_updated')),
	CONSTRAINT "payment_webhook_events_state" CHECK ("billing"."payment_webhook_events"."state" in ('received','applied','unmatched','ignored'))
);
--> statement-breakpoint
CREATE TABLE "billing"."collection_cases" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"collection_policy_id" uuid NOT NULL REFERENCES "billing"."collection_policies"("id"),
	"status" text DEFAULT 'open' NOT NULL,
	"step_no" integer DEFAULT 0 NOT NULL,
	"next_step_at" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "collection_cases_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "collection_cases_invoice" UNIQUE("organization_id","invoice_id"),
	CONSTRAINT "collection_cases_invoice_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "billing"."invoices"("organization_id","id"),
	CONSTRAINT "collection_cases_status" CHECK ("billing"."collection_cases"."status" in ('open','resolved','written_off'))
);
--> statement-breakpoint

-- Retention, legal hold and offboarding. Numbers come from legal sign-off, never from code (LIFE-02).
CREATE TABLE "lifecycle"."retention_rules" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"data_category" text NOT NULL,
	"classification" text DEFAULT '*' NOT NULL,
	"retain_days" integer,
	"basis_ref" text NOT NULL,
	"set_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "retention_rules_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "retention_rules_days" CHECK ("lifecycle"."retention_rules"."retain_days" IS NULL OR "lifecycle"."retention_rules"."retain_days" > 0),
	CONSTRAINT "retention_rules_classification" CHECK ("lifecycle"."retention_rules"."classification" in ('*','public','internal','confidential','restricted')),
	CONSTRAINT "retention_rules_category" CHECK ("lifecycle"."retention_rules"."data_category" ~ '^[a-z][a-z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "retention_rules_one_current" ON "lifecycle"."retention_rules" ("organization_id","data_category","classification") WHERE "lifecycle"."retention_rules"."superseded_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "lifecycle"."retention_runs" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"data_category" text NOT NULL,
	"examined" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"held" integer DEFAULT 0 NOT NULL,
	"outcome_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "retention_runs_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "lifecycle"."legal_holds" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"matter_ref" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"placed_by_membership_id" uuid NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by_membership_id" uuid,
	"released_at" timestamp with time zone,
	"release_reason_code" text,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "legal_holds_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "legal_holds_status" CHECK ("lifecycle"."legal_holds"."status" in ('active','released')),
	CONSTRAINT "legal_holds_released" CHECK ("lifecycle"."legal_holds"."status" = 'active' OR ("lifecycle"."legal_holds"."released_by_membership_id" IS NOT NULL AND "lifecycle"."legal_holds"."released_at" IS NOT NULL AND "lifecycle"."legal_holds"."release_reason_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "lifecycle"."legal_hold_scopes" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"hold_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	CONSTRAINT "legal_hold_scopes_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "legal_hold_scopes_hold" FOREIGN KEY ("organization_id","hold_id") REFERENCES "lifecycle"."legal_holds"("organization_id","id"),
	CONSTRAINT "legal_hold_scopes_type" CHECK ("lifecycle"."legal_hold_scopes"."scope_type" in ('organization','client','project','work_unit','artifact')),
	CONSTRAINT "legal_hold_scopes_id" CHECK (("lifecycle"."legal_hold_scopes"."scope_type" = 'organization') = ("lifecycle"."legal_hold_scopes"."scope_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "legal_hold_scopes_target" ON "lifecycle"."legal_hold_scopes" ("organization_id","scope_type","scope_id");
--> statement-breakpoint
CREATE TABLE "lifecycle"."offboardings" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"requested_by_membership_id" uuid NOT NULL,
	"export_offered_at" timestamp with time zone,
	"export_ref" text,
	"transition_ends_at" timestamp with time zone,
	"connections_revoked_at" timestamp with time zone,
	"work_ended_at" timestamp with time zone,
	"actions_settled_at" timestamp with time zone,
	"erasure_started_at" timestamp with time zone,
	"erasure_finished_at" timestamp with time zone,
	"report" jsonb,
	"reported_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason_code" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offboardings_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "offboardings_state" CHECK ("lifecycle"."offboardings"."state" in ('requested','export_offered','in_transition','winding_down','ready_for_erasure','erasing','verified','reported','cancelled')),
	CONSTRAINT "offboardings_reported" CHECK ("lifecycle"."offboardings"."state" <> 'reported' OR ("lifecycle"."offboardings"."report" IS NOT NULL AND "lifecycle"."offboardings"."reported_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "offboardings_one_live" ON "lifecycle"."offboardings" ("organization_id") WHERE "lifecycle"."offboardings"."state" NOT IN ('reported','cancelled');
--> statement-breakpoint
CREATE TABLE "lifecycle"."erasure_log" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"offboarding_id" uuid NOT NULL,
	"table_ref" text NOT NULL,
	"rows_removed" bigint DEFAULT 0 NOT NULL,
	"rows_left" bigint DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"reason_code" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erasure_log_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "erasure_log_offboarding" FOREIGN KEY ("organization_id","offboarding_id") REFERENCES "lifecycle"."offboardings"("organization_id","id"),
	CONSTRAINT "erasure_log_outcome" CHECK ("lifecycle"."erasure_log"."outcome" in ('erased','retained_by_rule','left_over'))
);
--> statement-breakpoint

-- The support desk. Customers write what they choose to send. Nothing here reaches their work (OPS-22).
CREATE TABLE "support"."coverage_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"timezone" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"staffed_by_ref" text NOT NULL,
	"drafted_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coverage_schedules_version_unique" UNIQUE("version"),
	CONSTRAINT "coverage_schedules_status" CHECK ("support"."coverage_schedules"."status" in ('draft','approved','retired')),
	CONSTRAINT "coverage_schedules_approved" CHECK ("support"."coverage_schedules"."status" = 'draft' OR ("support"."coverage_schedules"."approved_by" IS NOT NULL AND "support"."coverage_schedules"."approved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "support"."tickets" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_by_membership_id" uuid NOT NULL,
	"first_response_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "tickets_status" CHECK ("support"."tickets"."status" in ('open','waiting_on_customer','waiting_on_support','resolved','closed')),
	CONSTRAINT "tickets_category" CHECK ("support"."tickets"."category" in ('account','billing','incident','security','other')),
	CONSTRAINT "tickets_subject_length" CHECK (char_length("support"."tickets"."subject") between 1 and 200)
);
--> statement-breakpoint
CREATE INDEX "tickets_queue" ON "support"."tickets" ("status","updated_at");
--> statement-breakpoint
CREATE TABLE "support"."ticket_messages" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"author_ref" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_messages_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "ticket_messages_ticket" FOREIGN KEY ("organization_id","ticket_id") REFERENCES "support"."tickets"("organization_id","id"),
	CONSTRAINT "ticket_messages_author" CHECK ("support"."ticket_messages"."author_kind" in ('customer','support')),
	CONSTRAINT "ticket_messages_length" CHECK (char_length("support"."ticket_messages"."body") between 1 and 20000)
);
--> statement-breakpoint
CREATE TABLE "support"."break_glass_requests" (
	"organization_id" uuid NOT NULL REFERENCES "org"."organizations"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"reason_code" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"requested_minutes" integer NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"operator_authorizer" text,
	"operator_authorized_at" timestamp with time zone,
	"customer_authorizer_membership_id" uuid,
	"customer_authorized_at" timestamp with time zone,
	"authorized_from" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "break_glass_requests_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "break_glass_requests_state" CHECK ("support"."break_glass_requests"."state" in ('requested','authorized','denied','revoked','expired')),
	CONSTRAINT "break_glass_requests_scope" CHECK ("support"."break_glass_requests"."scope_type" in ('work_unit','artifact','client','project')),
	CONSTRAINT "break_glass_requests_minutes" CHECK ("support"."break_glass_requests"."requested_minutes" > 0),
	CONSTRAINT "break_glass_requests_two_people" CHECK ("support"."break_glass_requests"."operator_authorizer" IS NULL OR "support"."break_glass_requests"."operator_authorizer" <> "support"."break_glass_requests"."requested_by"),
	CONSTRAINT "break_glass_requests_authorized" CHECK ("support"."break_glass_requests"."state" <> 'authorized' OR ("support"."break_glass_requests"."operator_authorizer" IS NOT NULL AND "support"."break_glass_requests"."customer_authorizer_membership_id" IS NOT NULL AND "support"."break_glass_requests"."authorized_from" IS NOT NULL AND "support"."break_glass_requests"."expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "support"."break_glass_log" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_ref" text NOT NULL,
	"target_ref" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "break_glass_log_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "break_glass_log_request" FOREIGN KEY ("organization_id","request_id") REFERENCES "support"."break_glass_requests"("organization_id","id"),
	CONSTRAINT "break_glass_log_action" CHECK ("support"."break_glass_log"."action" in ('requested','operator_authorized','customer_authorized','denied','revoked','expired','content_read'))
);
--> statement-breakpoint

-- Incidents, drills and vulnerability reports. Global: an incident is about the service, not a tenant.
CREATE TABLE "operations"."incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"severity" text NOT NULL,
	"state" text DEFAULT 'investigating' NOT NULL,
	"origin" text NOT NULL,
	"provider_kind" text,
	"public_title" text NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"is_drill" boolean DEFAULT false NOT NULL,
	"commander_ref" text NOT NULL,
	"security_lead_ref" text,
	"infrastructure_lead_ref" text,
	"communications_ref" text,
	"legal_ref" text,
	"postmortem_ref" text,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_severity" CHECK ("operations"."incidents"."severity" in ('critical','high','medium')),
	CONSTRAINT "incidents_state" CHECK ("operations"."incidents"."state" in ('investigating','identified','monitoring','resolved')),
	CONSTRAINT "incidents_origin" CHECK ("operations"."incidents"."origin" in ('ensemus','model_provider','connector_provider','unknown')),
	CONSTRAINT "incidents_title_length" CHECK (char_length("operations"."incidents"."public_title") between 1 and 200),
	CONSTRAINT "incidents_drill_private" CHECK (NOT ("operations"."incidents"."is_drill" AND "operations"."incidents"."published"))
);
--> statement-breakpoint
CREATE TABLE "operations"."incident_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL REFERENCES "operations"."incidents"("id"),
	"state" text NOT NULL,
	"public_message" text NOT NULL,
	"author_ref" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_updates_state" CHECK ("operations"."incident_updates"."state" in ('investigating','identified','monitoring','resolved')),
	CONSTRAINT "incident_updates_length" CHECK (char_length("operations"."incident_updates"."public_message") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "operations"."drills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"scenario_ref" text NOT NULL,
	"roles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_ref" text,
	"outcome" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drills_kind" CHECK ("operations"."drills"."kind" in ('incident','restore','vulnerability_disclosure','failover')),
	CONSTRAINT "drills_outcome" CHECK ("operations"."drills"."outcome" IS NULL OR "operations"."drills"."outcome" in ('passed','failed'))
);
--> statement-breakpoint
CREATE TABLE "operations"."vulnerability_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_ref" text NOT NULL,
	"details_ref" text NOT NULL,
	"severity" text,
	"state" text DEFAULT 'received' NOT NULL,
	"is_exercise" boolean DEFAULT false NOT NULL,
	"fixed_in_ref" text,
	"received_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"disclosed_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vulnerability_reports_severity" CHECK ("operations"."vulnerability_reports"."severity" IS NULL OR "operations"."vulnerability_reports"."severity" in ('critical','high','medium','low')),
	CONSTRAINT "vulnerability_reports_state" CHECK ("operations"."vulnerability_reports"."state" in ('received','triaged','fixing','fixed','disclosed','rejected'))
);
