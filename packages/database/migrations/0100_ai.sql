CREATE SCHEMA "ai";
--> statement-breakpoint
CREATE TABLE "work"."agent_assignments" (
	"organization_id" uuid NOT NULL,
	"work_unit_id" uuid NOT NULL,
	"service_identity_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_assignments_organization_id_work_unit_id_agent_run_id_pk" PRIMARY KEY("organization_id","work_unit_id","agent_run_id")
);
--> statement-breakpoint
CREATE TABLE "ai"."agent_definitions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"service_identity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_definitions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "agent_definitions_slug_key" UNIQUE("organization_id","slug"),
	CONSTRAINT "agent_definitions_slug_format" CHECK ("ai"."agent_definitions"."slug" ~ '^[a-z][a-z0-9-]{2,80}$'),
	CONSTRAINT "agent_definitions_name_length" CHECK (char_length("ai"."agent_definitions"."name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "ai"."agent_publications" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_until" timestamp with time zone,
	CONSTRAINT "agent_publications_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "ai"."agent_runs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"work_unit_id" uuid NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"parent_run_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"initiator_membership_id" uuid NOT NULL,
	"service_identity_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stop_code" text,
	"effective_classification" text NOT NULL,
	"bound_profile_id" uuid,
	"bound_profile_version" integer,
	"max_model_turns" integer NOT NULL,
	"max_tool_calls" integer NOT NULL,
	"max_total_tokens" bigint NOT NULL,
	"max_cost_micros" bigint NOT NULL,
	"timeout_seconds" integer NOT NULL,
	"max_delegation_depth" integer DEFAULT 0 NOT NULL,
	"delegated_scopes" jsonb NOT NULL,
	"model_turns" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"active_ms" bigint DEFAULT 0 NOT NULL,
	"temporal_run_id" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "agent_runs_status_check" CHECK ("ai"."agent_runs"."status" in ('queued','preparing','running','paused','waiting_for_approval','waiting_for_child','verifying','completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')),
	CONSTRAINT "agent_runs_class_check" CHECK ("ai"."agent_runs"."effective_classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "agent_runs_stop_format" CHECK ("ai"."agent_runs"."stop_code" IS NULL OR "ai"."agent_runs"."stop_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "agent_runs_limits_check" CHECK ("ai"."agent_runs"."max_model_turns" >= 1 AND "ai"."agent_runs"."max_tool_calls" >= 0 AND "ai"."agent_runs"."max_total_tokens" >= 1 AND "ai"."agent_runs"."max_cost_micros" >= 0 AND "ai"."agent_runs"."timeout_seconds" >= 1 AND "ai"."agent_runs"."max_delegation_depth" >= 0 AND "ai"."agent_runs"."depth" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai"."agent_versions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_sha256" text NOT NULL,
	"evaluation_report_sha256" text NOT NULL,
	"policy_version" text NOT NULL,
	"max_cost_micros" bigint NOT NULL,
	"published_by_membership_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "agent_versions_number_key" UNIQUE("organization_id","definition_id","version_number"),
	CONSTRAINT "agent_versions_number_check" CHECK ("ai"."agent_versions"."version_number" > 0),
	CONSTRAINT "agent_versions_cost_check" CHECK ("ai"."agent_versions"."max_cost_micros" >= 0),
	CONSTRAINT "agent_versions_spec_sha" CHECK ("ai"."agent_versions"."spec_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_versions_report_sha" CHECK ("ai"."agent_versions"."evaluation_report_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "ai"."artifact_evidence" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_sha256" text,
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_evidence_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "artifact_evidence_source_check" CHECK ("ai"."artifact_evidence"."source_type" in ('work_unit','artifact'))
);
--> statement-breakpoint
CREATE TABLE "platform"."budget_reservations" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"amount_micros" bigint NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "budget_reservations_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "budget_reservations_step_key" UNIQUE("organization_id","budget_id","step_id","attempt"),
	CONSTRAINT "budget_reservations_status_check" CHECK ("platform"."budget_reservations"."status" in ('held','settled','released')),
	CONSTRAINT "budget_reservations_amount_check" CHECK ("platform"."budget_reservations"."amount_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."budgets" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"agent_version_id" uuid,
	"period" text NOT NULL,
	"limit_micros" bigint NOT NULL,
	"reserved_micros" bigint DEFAULT 0 NOT NULL,
	"spent_micros" bigint DEFAULT 0 NOT NULL,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "budgets_scope_check" CHECK ("platform"."budgets"."scope" in ('organization','agent_version')),
	CONSTRAINT "budgets_scope_target_check" CHECK (("platform"."budgets"."scope" = 'organization') = ("platform"."budgets"."agent_version_id" IS NULL)),
	CONSTRAINT "budgets_period_format" CHECK ("platform"."budgets"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "budgets_amounts_check" CHECK ("platform"."budgets"."limit_micros" >= 0 AND "platform"."budgets"."reserved_micros" >= 0 AND "platform"."budgets"."spent_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "governance"."egress_decisions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"step_id" uuid,
	"profile_id" uuid,
	"data_class" text NOT NULL,
	"purpose" text NOT NULL,
	"destination_host" text,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"policy_version" text NOT NULL,
	"request_hash" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "egress_decisions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "egress_decisions_class_check" CHECK ("governance"."egress_decisions"."data_class" in ('public','internal','confidential','restricted')),
	CONSTRAINT "egress_decisions_decision_check" CHECK ("governance"."egress_decisions"."decision" in ('allow','deny')),
	CONSTRAINT "egress_decisions_reason_format" CHECK ("governance"."egress_decisions"."reason_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "egress_decisions_hash_format" CHECK ("governance"."egress_decisions"."request_hash" IS NULL OR "governance"."egress_decisions"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "platform"."entitlements" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"mode" text NOT NULL,
	"version" integer NOT NULL,
	"period" text NOT NULL,
	"features" text[] NOT NULL,
	"capacities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlements_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "entitlements_version_key" UNIQUE("organization_id","version"),
	CONSTRAINT "entitlements_mode_check" CHECK ("platform"."entitlements"."mode" in ('cloud','byom','sovereign'))
);
--> statement-breakpoint
CREATE TABLE "ai"."execution_steps" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_number" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"outcome" text,
	"label_code" text NOT NULL,
	"decision_code" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "execution_steps_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "execution_steps_number_key" UNIQUE("organization_id","run_id","step_number"),
	CONSTRAINT "execution_steps_kind_check" CHECK ("ai"."execution_steps"."kind" in ('prepare','model_turn','tool_call','approval_wait','delegation','verification')),
	CONSTRAINT "execution_steps_state_check" CHECK ("ai"."execution_steps"."state" in ('in_flight','completed','failed','cancelled')),
	CONSTRAINT "execution_steps_number_check" CHECK ("ai"."execution_steps"."step_number" >= 0 AND "ai"."execution_steps"."attempt" >= 1),
	CONSTRAINT "execution_steps_label_format" CHECK ("ai"."execution_steps"."label_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "execution_steps_decision_format" CHECK ("ai"."execution_steps"."decision_code" IS NULL OR "ai"."execution_steps"."decision_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "execution_steps_outcome_format" CHECK ("ai"."execution_steps"."outcome" IS NULL OR "ai"."execution_steps"."outcome" ~ '^[a-z][a-z_]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "governance"."kill_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"scope" text NOT NULL,
	"target_ref" text,
	"reason_code" text NOT NULL,
	"engaged_by_membership_id" uuid,
	"engaged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_membership_id" uuid,
	CONSTRAINT "kill_switches_scope_check" CHECK ("governance"."kill_switches"."scope" in ('global','organization','provider','agent_version')),
	CONSTRAINT "kill_switches_tenant_check" CHECK (("governance"."kill_switches"."scope" IN ('global','provider') AND "governance"."kill_switches"."organization_id" IS NULL) OR ("governance"."kill_switches"."scope" IN ('organization','agent_version') AND "governance"."kill_switches"."organization_id" IS NOT NULL)),
	CONSTRAINT "kill_switches_target_check" CHECK (("governance"."kill_switches"."scope" IN ('provider','agent_version')) = ("governance"."kill_switches"."target_ref" IS NOT NULL)),
	CONSTRAINT "kill_switches_reason_format" CHECK ("governance"."kill_switches"."reason_code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "ai"."model_evaluations" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"suite" text NOT NULL,
	"passed" boolean NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dataset_version" text,
	"report_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_evaluations_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "ai"."model_profiles" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"provider_kind" text NOT NULL,
	"model_id" text NOT NULL,
	"alias" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"secret_ref" uuid,
	"billing_owner" text DEFAULT 'customer' NOT NULL,
	"region" text,
	"capabilities" text[] NOT NULL,
	"limits" jsonb NOT NULL,
	"allowed_classes" text[] DEFAULT '{public}'::text[] NOT NULL,
	"allowed_purposes" text[] NOT NULL,
	"retention_basis" text DEFAULT 'unreviewed' NOT NULL,
	"contract_ref" text,
	"fallback_profile_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"cross_billing_approved_by_membership_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"qualified_at" timestamp with time zone,
	"probe_requested_by_membership_id" uuid,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_profiles_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "model_profiles_alias_key" UNIQUE("organization_id","alias"),
	CONSTRAINT "model_profiles_kind_check" CHECK ("ai"."model_profiles"."provider_kind" in ('openai_hosted','anthropic_hosted','openai_compatible','local_openai_compatible')),
	CONSTRAINT "model_profiles_status_check" CHECK ("ai"."model_profiles"."status" in ('draft','probing','probe_failed','active','disabled')),
	CONSTRAINT "model_profiles_billing_check" CHECK ("ai"."model_profiles"."billing_owner" in ('customer','ensemus')),
	CONSTRAINT "model_profiles_retention_check" CHECK ("ai"."model_profiles"."retention_basis" in ('unreviewed','contract_recorded','self_hosted')),
	CONSTRAINT "model_profiles_version_check" CHECK ("ai"."model_profiles"."version" > 0),
	CONSTRAINT "model_profiles_classes_check" CHECK ("ai"."model_profiles"."allowed_classes" <@ ARRAY['public','internal','confidential','restricted']::text[]),
	CONSTRAINT "model_profiles_alias_length" CHECK (char_length("ai"."model_profiles"."alias") between 1 and 80),
	CONSTRAINT "model_profiles_model_length" CHECK (char_length("ai"."model_profiles"."model_id") between 1 and 200),
	CONSTRAINT "model_profiles_url_length" CHECK (char_length("ai"."model_profiles"."endpoint_url") between 8 and 500)
);
--> statement-breakpoint
CREATE TABLE "governance"."policy_bundles" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_bundles_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "policy_bundles_version_key" UNIQUE("organization_id","version"),
	CONSTRAINT "policy_bundles_sha" CHECK ("governance"."policy_bundles"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "ai"."rate_cards" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"input_micros_per_mtok" bigint NOT NULL,
	"output_micros_per_mtok" bigint NOT NULL,
	"source" text DEFAULT 'tenant_estimate' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_cards_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "rate_cards_version_key" UNIQUE("organization_id","profile_id","version"),
	CONSTRAINT "rate_cards_source_check" CHECK ("ai"."rate_cards"."source" in ('tenant_estimate','ensemus_card')),
	CONSTRAINT "rate_cards_amounts_check" CHECK ("ai"."rate_cards"."input_micros_per_mtok" >= 0 AND "ai"."rate_cards"."output_micros_per_mtok" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai"."run_controls" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_controls_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "run_controls_kind_check" CHECK ("ai"."run_controls"."kind" in ('stop','pause','resume'))
);
--> statement-breakpoint
CREATE TABLE "org"."service_identities" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_identities_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "service_identities_status_check" CHECK ("org"."service_identities"."status" in ('active','disabled')),
	CONSTRAINT "service_identities_purpose_length" CHECK (char_length("org"."service_identities"."purpose") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "ai"."step_payloads" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"step_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"classification" text NOT NULL,
	"content" text NOT NULL,
	"content_sha256" text NOT NULL,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "step_payloads_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "step_payloads_kind_check" CHECK ("ai"."step_payloads"."kind" in ('prompt','completion','tool_args','tool_output')),
	CONSTRAINT "step_payloads_class_check" CHECK ("ai"."step_payloads"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "step_payloads_sha" CHECK ("ai"."step_payloads"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "step_payloads_size_check" CHECK (octet_length("ai"."step_payloads"."content") <= 4194304)
);
--> statement-breakpoint
CREATE TABLE "ai"."tool_proposals" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"tool_version" text NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"approval_id" uuid,
	"external_action_id" uuid,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decision_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_proposals_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "tool_proposals_step_key" UNIQUE("organization_id","step_id"),
	CONSTRAINT "tool_proposals_idempotency_key" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "tool_proposals_status_check" CHECK ("ai"."tool_proposals"."status" in ('proposed','denied','awaiting_approval','approved','running','done','failed','unknown_external_state','cancelled')),
	CONSTRAINT "tool_proposals_hash" CHECK ("ai"."tool_proposals"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tool_proposals_decision_format" CHECK ("ai"."tool_proposals"."decision_code" IS NULL OR "ai"."tool_proposals"."decision_code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "platform"."usage_ledger" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"meter" text NOT NULL,
	"quantity" bigint NOT NULL,
	"unit" text NOT NULL,
	"cost_micros" bigint NOT NULL,
	"rate_card_id" uuid,
	"rate_card_version" integer,
	"billing_period" text NOT NULL,
	"commercial_mode" text NOT NULL,
	"reservation_id" uuid,
	"work_unit_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"profile_id" uuid,
	"profile_version" integer,
	"provider_kind" text,
	"request_hash" text,
	"status" text NOT NULL,
	"billable" boolean NOT NULL,
	"corrects_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledger_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "usage_ledger_idempotency_key" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "usage_ledger_meter_check" CHECK ("platform"."usage_ledger"."meter" in ('model_input_tokens','model_output_tokens','tool_call')),
	CONSTRAINT "usage_ledger_status_check" CHECK ("platform"."usage_ledger"."status" in ('estimated','final','correction')),
	CONSTRAINT "usage_ledger_mode_check" CHECK ("platform"."usage_ledger"."commercial_mode" in ('cloud','byom','sovereign')),
	CONSTRAINT "usage_ledger_period_format" CHECK ("platform"."usage_ledger"."billing_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "usage_ledger_correction_check" CHECK (("platform"."usage_ledger"."status" = 'correction') = ("platform"."usage_ledger"."corrects_id" IS NOT NULL)),
	CONSTRAINT "usage_ledger_hash_format" CHECK ("platform"."usage_ledger"."request_hash" IS NULL OR "platform"."usage_ledger"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "work"."agent_assignments" ADD CONSTRAINT "agent_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."agent_assignments" ADD CONSTRAINT "agent_assignments_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."agent_assignments" ADD CONSTRAINT "agent_assignments_organization_id_service_identity_id_service_identities_organization_id_id_fk" FOREIGN KEY ("organization_id","service_identity_id") REFERENCES "org"."service_identities"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."agent_assignments" ADD CONSTRAINT "agent_assignments_organization_id_agent_run_id_agent_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_run_id") REFERENCES "ai"."agent_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_definitions" ADD CONSTRAINT "agent_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_definitions" ADD CONSTRAINT "agent_definitions_organization_id_owner_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_definitions" ADD CONSTRAINT "agent_definitions_organization_id_service_identity_id_service_identities_organization_id_id_fk" FOREIGN KEY ("organization_id","service_identity_id") REFERENCES "org"."service_identities"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_publications" ADD CONSTRAINT "agent_publications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_publications" ADD CONSTRAINT "agent_publications_organization_id_definition_id_agent_definitions_organization_id_id_fk" FOREIGN KEY ("organization_id","definition_id") REFERENCES "ai"."agent_definitions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_publications" ADD CONSTRAINT "agent_publications_organization_id_version_id_agent_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "ai"."agent_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_runs" ADD CONSTRAINT "agent_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_runs" ADD CONSTRAINT "agent_runs_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_runs" ADD CONSTRAINT "agent_runs_organization_id_agent_version_id_agent_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_version_id") REFERENCES "ai"."agent_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_runs" ADD CONSTRAINT "agent_runs_organization_id_parent_run_id_agent_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","parent_run_id") REFERENCES "ai"."agent_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_runs" ADD CONSTRAINT "agent_runs_organization_id_initiator_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","initiator_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_runs" ADD CONSTRAINT "agent_runs_organization_id_service_identity_id_service_identities_organization_id_id_fk" FOREIGN KEY ("organization_id","service_identity_id") REFERENCES "org"."service_identities"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_runs" ADD CONSTRAINT "agent_runs_organization_id_bound_profile_id_model_profiles_organization_id_id_fk" FOREIGN KEY ("organization_id","bound_profile_id") REFERENCES "ai"."model_profiles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_versions" ADD CONSTRAINT "agent_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_versions" ADD CONSTRAINT "agent_versions_organization_id_definition_id_agent_definitions_organization_id_id_fk" FOREIGN KEY ("organization_id","definition_id") REFERENCES "ai"."agent_definitions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_versions" ADD CONSTRAINT "agent_versions_organization_id_published_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","published_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."artifact_evidence" ADD CONSTRAINT "artifact_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."artifact_evidence" ADD CONSTRAINT "artifact_evidence_organization_id_artifact_id_artifacts_organization_id_id_fk" FOREIGN KEY ("organization_id","artifact_id") REFERENCES "work"."artifacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."artifact_evidence" ADD CONSTRAINT "artifact_evidence_organization_id_run_id_agent_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "ai"."agent_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."artifact_evidence" ADD CONSTRAINT "artifact_evidence_organization_id_step_id_execution_steps_organization_id_id_fk" FOREIGN KEY ("organization_id","step_id") REFERENCES "ai"."execution_steps"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."budget_reservations" ADD CONSTRAINT "budget_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."budget_reservations" ADD CONSTRAINT "budget_reservations_organization_id_budget_id_budgets_organization_id_id_fk" FOREIGN KEY ("organization_id","budget_id") REFERENCES "platform"."budgets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."budget_reservations" ADD CONSTRAINT "budget_reservations_organization_id_run_id_agent_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "ai"."agent_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."budget_reservations" ADD CONSTRAINT "budget_reservations_organization_id_step_id_execution_steps_organization_id_id_fk" FOREIGN KEY ("organization_id","step_id") REFERENCES "ai"."execution_steps"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."budgets" ADD CONSTRAINT "budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."budgets" ADD CONSTRAINT "budgets_organization_id_agent_version_id_agent_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_version_id") REFERENCES "ai"."agent_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."budgets" ADD CONSTRAINT "budgets_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance"."egress_decisions" ADD CONSTRAINT "egress_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance"."egress_decisions" ADD CONSTRAINT "egress_decisions_organization_id_run_id_agent_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "ai"."agent_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance"."egress_decisions" ADD CONSTRAINT "egress_decisions_organization_id_step_id_execution_steps_organization_id_id_fk" FOREIGN KEY ("organization_id","step_id") REFERENCES "ai"."execution_steps"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance"."egress_decisions" ADD CONSTRAINT "egress_decisions_organization_id_profile_id_model_profiles_organization_id_id_fk" FOREIGN KEY ("organization_id","profile_id") REFERENCES "ai"."model_profiles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."entitlements" ADD CONSTRAINT "entitlements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."execution_steps" ADD CONSTRAINT "execution_steps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."execution_steps" ADD CONSTRAINT "execution_steps_organization_id_run_id_agent_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "ai"."agent_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance"."kill_switches" ADD CONSTRAINT "kill_switches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance"."kill_switches" ADD CONSTRAINT "kill_switches_organization_id_engaged_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","engaged_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance"."kill_switches" ADD CONSTRAINT "kill_switches_organization_id_released_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","released_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."model_evaluations" ADD CONSTRAINT "model_evaluations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."model_evaluations" ADD CONSTRAINT "model_evaluations_organization_id_profile_id_model_profiles_organization_id_id_fk" FOREIGN KEY ("organization_id","profile_id") REFERENCES "ai"."model_profiles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."model_profiles" ADD CONSTRAINT "model_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."model_profiles" ADD CONSTRAINT "model_profiles_organization_id_secret_ref_sealed_secrets_organization_id_id_fk" FOREIGN KEY ("organization_id","secret_ref") REFERENCES "secrets"."sealed_secrets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."model_profiles" ADD CONSTRAINT "model_profiles_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."model_profiles" ADD CONSTRAINT "model_profiles_organization_id_probe_requested_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","probe_requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."model_profiles" ADD CONSTRAINT "model_profiles_organization_id_cross_billing_approved_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","cross_billing_approved_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance"."policy_bundles" ADD CONSTRAINT "policy_bundles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance"."policy_bundles" ADD CONSTRAINT "policy_bundles_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."rate_cards" ADD CONSTRAINT "rate_cards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."rate_cards" ADD CONSTRAINT "rate_cards_organization_id_profile_id_model_profiles_organization_id_id_fk" FOREIGN KEY ("organization_id","profile_id") REFERENCES "ai"."model_profiles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."rate_cards" ADD CONSTRAINT "rate_cards_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."run_controls" ADD CONSTRAINT "run_controls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."run_controls" ADD CONSTRAINT "run_controls_organization_id_run_id_agent_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "ai"."agent_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."run_controls" ADD CONSTRAINT "run_controls_organization_id_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."service_identities" ADD CONSTRAINT "service_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."service_identities" ADD CONSTRAINT "service_identities_organization_id_owner_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."step_payloads" ADD CONSTRAINT "step_payloads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."step_payloads" ADD CONSTRAINT "step_payloads_organization_id_step_id_execution_steps_organization_id_id_fk" FOREIGN KEY ("organization_id","step_id") REFERENCES "ai"."execution_steps"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."tool_proposals" ADD CONSTRAINT "tool_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."tool_proposals" ADD CONSTRAINT "tool_proposals_organization_id_run_id_agent_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "ai"."agent_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."tool_proposals" ADD CONSTRAINT "tool_proposals_organization_id_step_id_execution_steps_organization_id_id_fk" FOREIGN KEY ("organization_id","step_id") REFERENCES "ai"."execution_steps"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."tool_proposals" ADD CONSTRAINT "tool_proposals_organization_id_approval_id_approvals_organization_id_id_fk" FOREIGN KEY ("organization_id","approval_id") REFERENCES "work"."approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."tool_proposals" ADD CONSTRAINT "tool_proposals_organization_id_external_action_id_external_actions_organization_id_id_fk" FOREIGN KEY ("organization_id","external_action_id") REFERENCES "integrations"."external_actions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_rate_card_id_rate_cards_organization_id_id_fk" FOREIGN KEY ("organization_id","rate_card_id") REFERENCES "ai"."rate_cards"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_reservation_id_budget_reservations_organization_id_id_fk" FOREIGN KEY ("organization_id","reservation_id") REFERENCES "platform"."budget_reservations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_run_id_agent_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "ai"."agent_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_step_id_execution_steps_organization_id_id_fk" FOREIGN KEY ("organization_id","step_id") REFERENCES "ai"."execution_steps"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_profile_id_model_profiles_organization_id_id_fk" FOREIGN KEY ("organization_id","profile_id") REFERENCES "ai"."model_profiles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_corrects_id_usage_ledger_organization_id_id_fk" FOREIGN KEY ("organization_id","corrects_id") REFERENCES "platform"."usage_ledger"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_publications_one_active" ON "ai"."agent_publications" USING btree ("organization_id","definition_id") WHERE "ai"."agent_publications"."active_until" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_live_per_work" ON "ai"."agent_runs" USING btree ("organization_id","work_unit_id") WHERE "ai"."agent_runs"."status" in ('queued','preparing','running','paused','waiting_for_approval','waiting_for_child','verifying');--> statement-breakpoint
CREATE INDEX "agent_runs_work_idx" ON "ai"."agent_runs" USING btree ("organization_id","work_unit_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_parent_idx" ON "ai"."agent_runs" USING btree ("organization_id","parent_run_id");--> statement-breakpoint
CREATE INDEX "artifact_evidence_artifact_idx" ON "ai"."artifact_evidence" USING btree ("organization_id","artifact_id");--> statement-breakpoint
CREATE INDEX "budget_reservations_run_idx" ON "platform"."budget_reservations" USING btree ("organization_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_scope_key" ON "platform"."budgets" USING btree ("organization_id","scope",coalesce("agent_version_id", '00000000-0000-0000-0000-000000000000'::uuid),"period");--> statement-breakpoint
CREATE INDEX "egress_decisions_run_idx" ON "governance"."egress_decisions" USING btree ("organization_id","run_id");--> statement-breakpoint
CREATE INDEX "egress_decisions_time_idx" ON "governance"."egress_decisions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "kill_switches_live_idx" ON "governance"."kill_switches" USING btree ("organization_id","scope") WHERE "governance"."kill_switches"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "model_evaluations_profile_idx" ON "ai"."model_evaluations" USING btree ("organization_id","profile_id","created_at");--> statement-breakpoint
CREATE INDEX "model_profiles_status_idx" ON "ai"."model_profiles" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_bundles_one_active" ON "governance"."policy_bundles" USING btree ("organization_id") WHERE "governance"."policy_bundles"."active";--> statement-breakpoint
CREATE INDEX "run_controls_run_idx" ON "ai"."run_controls" USING btree ("organization_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "step_payloads_step_idx" ON "ai"."step_payloads" USING btree ("organization_id","step_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_proposals_approval_idx" ON "ai"."tool_proposals" USING btree ("organization_id","approval_id") WHERE "ai"."tool_proposals"."approval_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "usage_ledger_run_idx" ON "platform"."usage_ledger" USING btree ("organization_id","run_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_period_idx" ON "platform"."usage_ledger" USING btree ("organization_id","billing_period");