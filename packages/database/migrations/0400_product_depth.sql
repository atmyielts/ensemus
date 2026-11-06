CREATE SCHEMA "experience";
--> statement-breakpoint
CREATE SCHEMA "objects";
--> statement-breakpoint
CREATE SCHEMA "packs";
--> statement-breakpoint
CREATE SCHEMA "studio";
--> statement-breakpoint
CREATE TABLE "studio"."agent_drafts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"agent_definition_id" uuid,
	"answers" jsonb NOT NULL,
	"spec_sha256" text,
	"status" text DEFAULT 'editing' NOT NULL,
	"from_pack_installation_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_drafts_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "agent_drafts_status" CHECK ("studio"."agent_drafts"."status" in ('editing','in_review','published','archived'))
);
--> statement-breakpoint
CREATE TABLE "objects"."migrations" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"type_id" uuid NOT NULL,
	"from_version_number" integer NOT NULL,
	"to_version_number" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"migrated_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"requested_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "migrations_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "object_migrations_status" CHECK ("objects"."migrations"."status" in ('queued','running','completed','failed')),
	CONSTRAINT "object_migrations_forward" CHECK ("objects"."migrations"."to_version_number" > "objects"."migrations"."from_version_number")
);
--> statement-breakpoint
CREATE TABLE "objects"."record_values" (
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"value_text" text,
	"value_number" numeric,
	"value_time" timestamp with time zone,
	"value_boolean" boolean,
	CONSTRAINT "record_values_organization_id_record_id_field_key_pk" PRIMARY KEY("organization_id","record_id","field_key")
);
--> statement-breakpoint
CREATE TABLE "objects"."records" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"type_id" uuid NOT NULL,
	"type_version_number" integer NOT NULL,
	"display_name" text NOT NULL,
	"attributes" jsonb NOT NULL,
	"classification" text NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "records_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "object_records_classification" CHECK ("objects"."records"."classification" in ('public','internal','confidential','restricted'))
);
--> statement-breakpoint
CREATE TABLE "objects"."relations" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"relation_key" text NOT NULL,
	"from_record_id" uuid NOT NULL,
	"to_record_id" uuid NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relations_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "object_relations_edge_key" UNIQUE("organization_id","relation_key","from_record_id","to_record_id"),
	CONSTRAINT "object_relations_not_self" CHECK ("objects"."relations"."from_record_id" <> "objects"."relations"."to_record_id")
);
--> statement-breakpoint
CREATE TABLE "objects"."type_versions" (
	"organization_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"fields" jsonb NOT NULL,
	"relations" jsonb NOT NULL,
	"schema_sha256" text NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "type_versions_organization_id_type_id_version_number_pk" PRIMARY KEY("organization_id","type_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "objects"."types" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"classification" text DEFAULT 'internal' NOT NULL,
	"current_version_number" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"from_pack_installation_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "types_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "object_types_slug_key" UNIQUE("organization_id","slug"),
	CONSTRAINT "object_types_classification" CHECK ("objects"."types"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "object_types_state" CHECK ("objects"."types"."state" in ('active','archived')),
	CONSTRAINT "object_types_slug_format" CHECK ("objects"."types"."slug" ~ '^[a-z][a-z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "experience"."onboarding_steps" (
	"organization_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"status" text NOT NULL,
	"decided_by_membership_id" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_steps_organization_id_step_key_pk" PRIMARY KEY("organization_id","step_key"),
	CONSTRAINT "onboarding_step_status" CHECK ("experience"."onboarding_steps"."status" in ('acknowledged','skipped'))
);
--> statement-breakpoint
CREATE TABLE "experience"."outcome_drafts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"objective" text NOT NULL,
	"preview" jsonb NOT NULL,
	"preview_sha256" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"work_unit_id" uuid,
	"authorized_by_membership_id" uuid,
	"authorized_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_drafts_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "outcome_drafts_status" CHECK ("experience"."outcome_drafts"."status" in ('draft','authorized','discarded')),
	CONSTRAINT "outcome_drafts_authorized" CHECK (("experience"."outcome_drafts"."status" = 'authorized') = ("experience"."outcome_drafts"."work_unit_id" is not null and "experience"."outcome_drafts"."authorized_by_membership_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "packs"."capability_reviews" (
	"organization_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"capability_key" text NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"decided_by_membership_id" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "capability_reviews_organization_id_installation_id_capability_key_pk" PRIMARY KEY("organization_id","installation_id","capability_key"),
	CONSTRAINT "pack_capability_decision" CHECK ("packs"."capability_reviews"."decision" in ('pending','accepted','declined'))
);
--> statement-breakpoint
CREATE TABLE "packs"."installations" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"pack_key" text NOT NULL,
	"pack_version" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"status" text DEFAULT 'reviewing' NOT NULL,
	"previous_installation_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"requested_by_membership_id" uuid NOT NULL,
	"activated_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "installations_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "pack_installations_status" CHECK ("packs"."installations"."status" in ('reviewing','active','superseded','rolled_back','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "packs"."installed_items" (
	"organization_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"item_key" text NOT NULL,
	"item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installed_items_organization_id_installation_id_item_kind_item_key_pk" PRIMARY KEY("organization_id","installation_id","item_kind","item_key"),
	CONSTRAINT "pack_installed_item_kind" CHECK ("packs"."installed_items"."item_kind" in ('object_type','agent_draft','process_draft','process_spec'))
);
--> statement-breakpoint
CREATE TABLE "studio"."process_drafts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"classification" text DEFAULT 'internal' NOT NULL,
	"graph" jsonb NOT NULL,
	"spec_sha256" text,
	"status" text DEFAULT 'editing' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "process_drafts_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "process_drafts_classification" CHECK ("studio"."process_drafts"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "process_drafts_status" CHECK ("studio"."process_drafts"."status" in ('editing','in_review','published','archived'))
);
--> statement-breakpoint
CREATE TABLE "studio"."process_run_steps" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stop_code" text,
	"work_unit_id" uuid,
	"approval_id" uuid,
	"external_action_id" uuid,
	"agent_run_id" uuid,
	"artifact_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "process_run_steps_organization_id_run_id_step_key_pk" PRIMARY KEY("organization_id","run_id","step_key"),
	CONSTRAINT "process_run_steps_status" CHECK ("studio"."process_run_steps"."status" in ('pending','ready','waiting','done','failed','skipped'))
);
--> statement-breakpoint
CREATE TABLE "studio"."process_runs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"spec_id" uuid NOT NULL,
	"root_work_unit_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stop_code" text,
	"started_by_membership_id" uuid NOT NULL,
	"temporal_run_id" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "process_runs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "process_runs_status" CHECK ("studio"."process_runs"."status" in ('queued','running','waiting','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "studio"."process_specs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"process_key" text NOT NULL,
	"version_number" integer NOT NULL,
	"name" text NOT NULL,
	"classification" text NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_sha256" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"published_by_membership_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "process_specs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "process_specs_version_key" UNIQUE("organization_id","process_key","version_number"),
	CONSTRAINT "process_specs_classification" CHECK ("studio"."process_specs"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "process_specs_source" CHECK ("studio"."process_specs"."source" in ('graph','bundled','pack')),
	CONSTRAINT "process_specs_key" CHECK ("studio"."process_specs"."process_key" ~ '^[a-z][a-z0-9_.-]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "studio"."publish_reviews" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_sha256" text NOT NULL,
	"simulation_run_id" uuid NOT NULL,
	"risk_level" text NOT NULL,
	"risk_summary" jsonb NOT NULL,
	"requested_by_membership_id" uuid NOT NULL,
	"reviewer_membership_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_membership_id" uuid,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"published_ref" uuid,
	"published_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_reviews_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "publish_reviews_kind" CHECK ("studio"."publish_reviews"."subject_kind" in ('agent_draft','process_draft')),
	CONSTRAINT "publish_reviews_risk" CHECK ("studio"."publish_reviews"."risk_level" in ('standard','elevated')),
	CONSTRAINT "publish_reviews_status" CHECK ("studio"."publish_reviews"."status" in ('pending','approved','rejected','cancelled','published'))
);
--> statement-breakpoint
CREATE TABLE "experience"."pulse_signal_states" (
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"signal_key" text NOT NULL,
	"state" text NOT NULL,
	"until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pulse_signal_states_organization_id_membership_id_signal_key_pk" PRIMARY KEY("organization_id","membership_id","signal_key"),
	CONSTRAINT "pulse_signal_state" CHECK ("experience"."pulse_signal_states"."state" in ('dismissed','snoozed')),
	CONSTRAINT "pulse_signal_until" CHECK (("experience"."pulse_signal_states"."state" = 'snoozed') = ("experience"."pulse_signal_states"."until" is not null))
);
--> statement-breakpoint
CREATE TABLE "org"."scim_tokens" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "scim_tokens_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "scim_tokens_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "scim_tokens_state" CHECK ("org"."scim_tokens"."state" in ('active','revoked'))
);
--> statement-breakpoint
CREATE TABLE "org"."security_policies" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"mfa_for_administration" boolean DEFAULT false NOT NULL,
	"mfa_max_age_seconds" integer NOT NULL,
	"sso_enforcement" text DEFAULT 'optional' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_by_membership_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_policies_mfa_age" CHECK ("org"."security_policies"."mfa_max_age_seconds" between 60 and 3600),
	CONSTRAINT "security_policies_sso" CHECK ("org"."security_policies"."sso_enforcement" in ('optional','required'))
);
--> statement-breakpoint
CREATE TABLE "identity"."session_assurances" (
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid NOT NULL,
	"sso_provider_id" text,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_assurances_session_id_kind_pk" PRIMARY KEY("session_id","kind"),
	CONSTRAINT "session_assurances_kind" CHECK ("identity"."session_assurances"."kind" in ('mfa_totp','mfa_backup_code','sso_saml')),
	CONSTRAINT "session_assurances_sso_provider" CHECK (("identity"."session_assurances"."kind" = 'sso_saml') = ("identity"."session_assurances"."sso_provider_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "studio"."simulation_runs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid,
	"subject_key" text,
	"subject_sha256" text NOT NULL,
	"scenario_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"outcome_code" text,
	"report" jsonb,
	"report_sha256" text,
	"requested_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "simulation_runs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "simulation_runs_kind" CHECK ("studio"."simulation_runs"."subject_kind" in ('agent_draft','process_draft','bundled_workflow')),
	CONSTRAINT "simulation_runs_subject" CHECK (("studio"."simulation_runs"."subject_id" is null) <> ("studio"."simulation_runs"."subject_key" is null)),
	CONSTRAINT "simulation_runs_status" CHECK ("studio"."simulation_runs"."status" in ('queued','running','passed','failed','errored')),
	CONSTRAINT "simulation_runs_report" CHECK ("studio"."simulation_runs"."status" not in ('passed','failed') or ("studio"."simulation_runs"."report" is not null and "studio"."simulation_runs"."report_sha256" is not null))
);
--> statement-breakpoint
CREATE TABLE "org"."sso_connections" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"display_name" text NOT NULL,
	"domain" text NOT NULL,
	"domain_state" text DEFAULT 'unverified' NOT NULL,
	"domain_verified_at" timestamp with time zone,
	"state" text DEFAULT 'draft' NOT NULL,
	"auto_join" boolean DEFAULT false NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connections_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "sso_connections_provider_key" UNIQUE("provider_id"),
	CONSTRAINT "sso_connections_state" CHECK ("org"."sso_connections"."state" in ('draft','active','disabled')),
	CONSTRAINT "sso_connections_domain_state" CHECK ("org"."sso_connections"."domain_state" in ('unverified','verified')),
	CONSTRAINT "sso_connections_domain_format" CHECK ("org"."sso_connections"."domain" = lower("org"."sso_connections"."domain")),
	CONSTRAINT "sso_connections_active_needs_domain" CHECK ("org"."sso_connections"."state" <> 'active' or "org"."sso_connections"."domain_state" = 'verified')
);
--> statement-breakpoint
CREATE TABLE "org"."sso_member_links" (
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_subject" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"deprovisioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_member_links_organization_id_membership_id_pk" PRIMARY KEY("organization_id","membership_id"),
	CONSTRAINT "sso_member_links_subject_key" UNIQUE("organization_id","connection_id","external_subject"),
	CONSTRAINT "sso_member_links_state" CHECK ("org"."sso_member_links"."state" in ('active','deprovisioned'))
);
--> statement-breakpoint
CREATE TABLE "identity"."sso_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"issuer" text NOT NULL,
	"domain" text NOT NULL,
	"domain_verified" boolean DEFAULT false NOT NULL,
	"saml_config" text,
	"oidc_config" text,
	"user_id" uuid,
	"organization_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_providers_providerId_unique" UNIQUE("provider_id"),
	CONSTRAINT "sso_providers_no_oidc" CHECK ("identity"."sso_providers"."oidc_config" is null),
	CONSTRAINT "sso_providers_domain_format" CHECK ("identity"."sso_providers"."domain" = lower("identity"."sso_providers"."domain"))
);
--> statement-breakpoint
CREATE TABLE "identity"."two_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "identity"."users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "studio"."agent_drafts" ADD CONSTRAINT "agent_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."agent_drafts" ADD CONSTRAINT "agent_drafts_organization_id_owner_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."agent_drafts" ADD CONSTRAINT "agent_drafts_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."migrations" ADD CONSTRAINT "migrations_organization_id_type_id_types_organization_id_id_fk" FOREIGN KEY ("organization_id","type_id") REFERENCES "objects"."types"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."migrations" ADD CONSTRAINT "migrations_organization_id_requested_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."record_values" ADD CONSTRAINT "record_values_organization_id_record_id_records_organization_id_id_fk" FOREIGN KEY ("organization_id","record_id") REFERENCES "objects"."records"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."records" ADD CONSTRAINT "records_organization_id_type_id_type_version_number_type_versions_organization_id_type_id_version_number_fk" FOREIGN KEY ("organization_id","type_id","type_version_number") REFERENCES "objects"."type_versions"("organization_id","type_id","version_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."records" ADD CONSTRAINT "records_organization_id_owner_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."records" ADD CONSTRAINT "records_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."relations" ADD CONSTRAINT "relations_organization_id_from_record_id_records_organization_id_id_fk" FOREIGN KEY ("organization_id","from_record_id") REFERENCES "objects"."records"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."relations" ADD CONSTRAINT "relations_organization_id_to_record_id_records_organization_id_id_fk" FOREIGN KEY ("organization_id","to_record_id") REFERENCES "objects"."records"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."relations" ADD CONSTRAINT "relations_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."type_versions" ADD CONSTRAINT "type_versions_organization_id_type_id_types_organization_id_id_fk" FOREIGN KEY ("organization_id","type_id") REFERENCES "objects"."types"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."type_versions" ADD CONSTRAINT "type_versions_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."types" ADD CONSTRAINT "types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects"."types" ADD CONSTRAINT "types_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience"."onboarding_steps" ADD CONSTRAINT "onboarding_steps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience"."onboarding_steps" ADD CONSTRAINT "onboarding_steps_organization_id_decided_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","decided_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience"."outcome_drafts" ADD CONSTRAINT "outcome_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience"."outcome_drafts" ADD CONSTRAINT "outcome_drafts_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience"."outcome_drafts" ADD CONSTRAINT "outcome_drafts_organization_id_authorized_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","authorized_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience"."outcome_drafts" ADD CONSTRAINT "outcome_drafts_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs"."capability_reviews" ADD CONSTRAINT "capability_reviews_organization_id_installation_id_installations_organization_id_id_fk" FOREIGN KEY ("organization_id","installation_id") REFERENCES "packs"."installations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs"."capability_reviews" ADD CONSTRAINT "capability_reviews_organization_id_decided_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","decided_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs"."installations" ADD CONSTRAINT "installations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs"."installations" ADD CONSTRAINT "installations_organization_id_previous_installation_id_installations_organization_id_id_fk" FOREIGN KEY ("organization_id","previous_installation_id") REFERENCES "packs"."installations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs"."installations" ADD CONSTRAINT "installations_organization_id_requested_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs"."installations" ADD CONSTRAINT "installations_organization_id_activated_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","activated_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs"."installed_items" ADD CONSTRAINT "installed_items_organization_id_installation_id_installations_organization_id_id_fk" FOREIGN KEY ("organization_id","installation_id") REFERENCES "packs"."installations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_drafts" ADD CONSTRAINT "process_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_drafts" ADD CONSTRAINT "process_drafts_organization_id_owner_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_drafts" ADD CONSTRAINT "process_drafts_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_run_steps" ADD CONSTRAINT "process_run_steps_organization_id_run_id_process_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "studio"."process_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_run_steps" ADD CONSTRAINT "process_run_steps_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_run_steps" ADD CONSTRAINT "process_run_steps_organization_id_approval_id_approvals_organization_id_id_fk" FOREIGN KEY ("organization_id","approval_id") REFERENCES "work"."approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_run_steps" ADD CONSTRAINT "process_run_steps_organization_id_artifact_id_artifacts_organization_id_id_fk" FOREIGN KEY ("organization_id","artifact_id") REFERENCES "work"."artifacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_runs" ADD CONSTRAINT "process_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_runs" ADD CONSTRAINT "process_runs_organization_id_spec_id_process_specs_organization_id_id_fk" FOREIGN KEY ("organization_id","spec_id") REFERENCES "studio"."process_specs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_runs" ADD CONSTRAINT "process_runs_organization_id_root_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","root_work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_runs" ADD CONSTRAINT "process_runs_organization_id_started_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","started_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_specs" ADD CONSTRAINT "process_specs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."process_specs" ADD CONSTRAINT "process_specs_organization_id_published_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","published_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."publish_reviews" ADD CONSTRAINT "publish_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."publish_reviews" ADD CONSTRAINT "publish_reviews_organization_id_simulation_run_id_simulation_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","simulation_run_id") REFERENCES "studio"."simulation_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."publish_reviews" ADD CONSTRAINT "publish_reviews_organization_id_requested_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."publish_reviews" ADD CONSTRAINT "publish_reviews_organization_id_reviewer_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","reviewer_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."publish_reviews" ADD CONSTRAINT "publish_reviews_organization_id_decided_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","decided_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience"."pulse_signal_states" ADD CONSTRAINT "pulse_signal_states_organization_id_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."scim_tokens" ADD CONSTRAINT "scim_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."scim_tokens" ADD CONSTRAINT "scim_tokens_organization_id_connection_id_sso_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "org"."sso_connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."scim_tokens" ADD CONSTRAINT "scim_tokens_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."security_policies" ADD CONSTRAINT "security_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."security_policies" ADD CONSTRAINT "security_policies_organization_id_updated_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","updated_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."session_assurances" ADD CONSTRAINT "session_assurances_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "identity"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."session_assurances" ADD CONSTRAINT "session_assurances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."simulation_runs" ADD CONSTRAINT "simulation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio"."simulation_runs" ADD CONSTRAINT "simulation_runs_organization_id_requested_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."sso_connections" ADD CONSTRAINT "sso_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."sso_connections" ADD CONSTRAINT "sso_connections_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."sso_member_links" ADD CONSTRAINT "sso_member_links_organization_id_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."sso_member_links" ADD CONSTRAINT "sso_member_links_organization_id_connection_id_sso_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "org"."sso_connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."sso_providers" ADD CONSTRAINT "sso_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_drafts_status_idx" ON "studio"."agent_drafts" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "object_migrations_one_open_idx" ON "objects"."migrations" USING btree ("organization_id","type_id") WHERE "objects"."migrations"."status" in ('queued','running');--> statement-breakpoint
CREATE INDEX "object_record_values_text_idx" ON "objects"."record_values" USING btree ("organization_id","field_key","value_text");--> statement-breakpoint
CREATE INDEX "object_record_values_number_idx" ON "objects"."record_values" USING btree ("organization_id","field_key","value_number");--> statement-breakpoint
CREATE INDEX "object_record_values_time_idx" ON "objects"."record_values" USING btree ("organization_id","field_key","value_time");--> statement-breakpoint
CREATE INDEX "object_records_type_idx" ON "objects"."records" USING btree ("organization_id","type_id","updated_at");--> statement-breakpoint
CREATE INDEX "object_relations_to_idx" ON "objects"."relations" USING btree ("organization_id","to_record_id");--> statement-breakpoint
CREATE INDEX "outcome_drafts_author_idx" ON "experience"."outcome_drafts" USING btree ("organization_id","created_by_membership_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pack_installations_one_active_idx" ON "packs"."installations" USING btree ("organization_id","pack_key") WHERE "packs"."installations"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "pack_installations_one_open_idx" ON "packs"."installations" USING btree ("organization_id","pack_key") WHERE "packs"."installations"."status" = 'reviewing';--> statement-breakpoint
CREATE INDEX "process_runs_status_idx" ON "studio"."process_runs" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_reviews_one_open_idx" ON "studio"."publish_reviews" USING btree ("organization_id","subject_kind","subject_id") WHERE "studio"."publish_reviews"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "session_assurances_user_idx" ON "identity"."session_assurances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "simulation_runs_subject_idx" ON "studio"."simulation_runs" USING btree ("organization_id","subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_verified_domain_idx" ON "org"."sso_connections" USING btree ("domain") WHERE "org"."sso_connections"."domain_state" = 'verified';--> statement-breakpoint
CREATE INDEX "two_factors_user_idx" ON "identity"."two_factors" USING btree ("user_id");