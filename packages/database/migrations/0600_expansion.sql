CREATE SCHEMA "meetings";
--> statement-breakpoint
CREATE TABLE "integrations"."business_record_actions" (
	"organization_id" uuid NOT NULL,
	"business_record_id" uuid NOT NULL,
	"external_action_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_record_actions_organization_id_business_record_id_external_action_id_pk" PRIMARY KEY("organization_id","business_record_id","external_action_id")
);
--> statement-breakpoint
CREATE TABLE "integrations"."business_records" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"external_id" text NOT NULL,
	"external_version" text,
	"display_name" text,
	"fields" jsonb NOT NULL,
	"fields_sha256" text NOT NULL,
	"classification" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_records_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "business_records_source_key" UNIQUE("organization_id","connection_id","external_id"),
	CONSTRAINT "business_records_classification" CHECK ("integrations"."business_records"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "business_records_stream_format" CHECK ("integrations"."business_records"."stream" ~ '^[a-z0-9_.-]{1,64}$'),
	CONSTRAINT "business_records_sha_format" CHECK ("integrations"."business_records"."fields_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "business_records_fields_size" CHECK (octet_length("integrations"."business_records"."fields"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "meetings"."consent_records" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "meetings"."consent_records_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"meeting_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"basis" text NOT NULL,
	"notice_ref" text NOT NULL,
	"recorded_by_membership_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_records_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "meeting_consent_decision" CHECK ("meetings"."consent_records"."decision" in ('granted','declined','withdrawn')),
	CONSTRAINT "meeting_consent_basis" CHECK ("meetings"."consent_records"."basis" in ('self','attested'))
);
--> statement-breakpoint
CREATE TABLE "meetings"."derivation_runs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"notes_id" uuid NOT NULL,
	"provider_approval_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"status_code" text,
	"requested_by_membership_id" uuid NOT NULL,
	"temporal_run_id" text,
	"model_ref" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "derivation_runs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "meeting_derivation_runs_in_meeting" UNIQUE("organization_id","meeting_id","id"),
	CONSTRAINT "meeting_derivation_purpose" CHECK ("meetings"."derivation_runs"."purpose" in ('summarize','extract_items')),
	CONSTRAINT "meeting_derivation_status" CHECK ("meetings"."derivation_runs"."status" in ('requested','running','completed','failed','refused','cancelled')),
	CONSTRAINT "meeting_derivation_version" CHECK ("meetings"."derivation_runs"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "meetings"."import_requests" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"source_approval_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"status_code" text,
	"requested_by_membership_id" uuid NOT NULL,
	"temporal_run_id" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "import_requests_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "meeting_import_requests_status" CHECK ("meetings"."import_requests"."status" in ('requested','completed','failed','refused')),
	CONSTRAINT "meeting_import_requests_version" CHECK ("meetings"."import_requests"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "meetings"."notes" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_kind" text NOT NULL,
	"source_approval_id" uuid,
	"source_external_version" text,
	"body" text,
	"body_sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"classification" text NOT NULL,
	"imported_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone,
	CONSTRAINT "notes_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "meeting_notes_version" UNIQUE("organization_id","meeting_id","version"),
	CONSTRAINT "meeting_notes_in_meeting" UNIQUE("organization_id","meeting_id","id"),
	CONSTRAINT "meeting_notes_classification" CHECK ("meetings"."notes"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "meeting_notes_source_kind" CHECK ("meetings"."notes"."source_kind" in ('manual','connector')),
	CONSTRAINT "meeting_notes_version_check" CHECK ("meetings"."notes"."version" > 0),
	CONSTRAINT "meeting_notes_sha_format" CHECK ("meetings"."notes"."body_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "meeting_notes_size" CHECK ("meetings"."notes"."size_bytes" between 1 and 524288),
	CONSTRAINT "meeting_notes_body_size" CHECK ("meetings"."notes"."body" is null or octet_length("meetings"."notes"."body") <= 524288),
	CONSTRAINT "meeting_notes_purge_whole" CHECK (("meetings"."notes"."body" is null) = ("meetings"."notes"."purged_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "meetings"."participants" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"membership_id" uuid,
	"external_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "meeting_participants_in_meeting" UNIQUE("organization_id","meeting_id","id"),
	CONSTRAINT "meeting_participants_kind" CHECK ("meetings"."participants"."kind" in ('member','external')),
	CONSTRAINT "meeting_participants_shape" CHECK (("meetings"."participants"."kind" = 'member' and "meetings"."participants"."membership_id" is not null and "meetings"."participants"."external_label" is null) or ("meetings"."participants"."kind" = 'external' and "meetings"."participants"."membership_id" is null and "meetings"."participants"."external_label" is not null and char_length("meetings"."participants"."external_label") between 1 and 200))
);
--> statement-breakpoint
CREATE TABLE "meetings"."proposed_items" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"detail" text,
	"suggested_owner_membership_id" uuid,
	"suggested_due_on" date,
	"classification" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_by_membership_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"work_unit_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone,
	CONSTRAINT "proposed_items_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "meeting_proposed_items_ordinal" UNIQUE("organization_id","run_id","ordinal"),
	CONSTRAINT "meeting_proposed_items_classification" CHECK ("meetings"."proposed_items"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "meeting_proposed_items_kind" CHECK ("meetings"."proposed_items"."kind" in ('decision','work')),
	CONSTRAINT "meeting_proposed_items_status" CHECK ("meetings"."proposed_items"."status" in ('proposed','accepted','rejected','withdrawn')),
	CONSTRAINT "meeting_proposed_items_ordinal_range" CHECK ("meetings"."proposed_items"."ordinal" between 1 and 100),
	CONSTRAINT "meeting_proposed_items_title" CHECK ("meetings"."proposed_items"."purged_at" is not null or ("meetings"."proposed_items"."title" is not null and char_length("meetings"."proposed_items"."title") between 1 and 300)),
	CONSTRAINT "meeting_proposed_items_detail" CHECK ("meetings"."proposed_items"."detail" is null or char_length("meetings"."proposed_items"."detail") <= 4000),
	CONSTRAINT "meeting_proposed_items_reason" CHECK ("meetings"."proposed_items"."decision_reason" is null or char_length("meetings"."proposed_items"."decision_reason") <= 2000),
	CONSTRAINT "meeting_proposed_items_version" CHECK ("meetings"."proposed_items"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "meetings"."provider_approvals" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"target_ref" text NOT NULL,
	"purposes" text[] NOT NULL,
	"max_classification" text NOT NULL,
	"terms_ref" text NOT NULL,
	"approved_by_membership_id" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_membership_id" uuid,
	CONSTRAINT "provider_approvals_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "meeting_provider_kind" CHECK ("meetings"."provider_approvals"."kind" in ('model','source')),
	CONSTRAINT "meeting_provider_max_class" CHECK ("meetings"."provider_approvals"."max_classification" in ('public','internal','confidential')),
	CONSTRAINT "meeting_provider_shape" CHECK (("meetings"."provider_approvals"."kind" = 'model' and "meetings"."provider_approvals"."target_ref" ~ '^model_profile:[0-9a-f-]{36}$' and cardinality("meetings"."provider_approvals"."purposes") between 1 and 2 and "meetings"."provider_approvals"."purposes" <@ array['summarize','extract_items']::text[]) or ("meetings"."provider_approvals"."kind" = 'source' and "meetings"."provider_approvals"."target_ref" ~ '^connection:[0-9a-f-]{36}$' and "meetings"."provider_approvals"."purposes" = array['import_notes']::text[])),
	CONSTRAINT "meeting_provider_terms_length" CHECK (char_length("meetings"."provider_approvals"."terms_ref") between 1 and 200),
	CONSTRAINT "meeting_provider_expiry" CHECK ("meetings"."provider_approvals"."expires_at" > "meetings"."provider_approvals"."approved_at"),
	CONSTRAINT "meeting_provider_revoke_whole" CHECK (("meetings"."provider_approvals"."revoked_at" is null) = ("meetings"."provider_approvals"."revoked_by_membership_id" is null))
);
--> statement-breakpoint
CREATE TABLE "meetings"."settings" (
	"organization_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"notice_ref" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_by_membership_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_organization_id_pk" PRIMARY KEY("organization_id"),
	CONSTRAINT "meeting_settings_notice_when_enabled" CHECK (not "meetings"."settings"."enabled" or "meetings"."settings"."notice_ref" is not null),
	CONSTRAINT "meeting_settings_notice_length" CHECK ("meetings"."settings"."notice_ref" is null or char_length("meetings"."settings"."notice_ref") between 1 and 200),
	CONSTRAINT "meeting_settings_version" CHECK ("meetings"."settings"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "meetings"."summaries" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"body" text,
	"classification" text NOT NULL,
	"trust" text DEFAULT 'model_generated' NOT NULL,
	"source_notes_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone,
	CONSTRAINT "summaries_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "meeting_summaries_one_per_run" UNIQUE("organization_id","run_id"),
	CONSTRAINT "meeting_summaries_classification" CHECK ("meetings"."summaries"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "meeting_summaries_trust" CHECK ("meetings"."summaries"."trust" = 'model_generated'),
	CONSTRAINT "meeting_summaries_sha_format" CHECK ("meetings"."summaries"."source_notes_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "meeting_summaries_size" CHECK ("meetings"."summaries"."body" is null or octet_length("meetings"."summaries"."body") <= 131072),
	CONSTRAINT "meeting_summaries_purge_whole" CHECK (("meetings"."summaries"."body" is null) = ("meetings"."summaries"."purged_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "meetings"."meetings" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"organizer_membership_id" uuid NOT NULL,
	"classification" text DEFAULT 'confidential' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"source_kind" text DEFAULT 'manual' NOT NULL,
	"connection_id" uuid,
	"source_resource_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone,
	CONSTRAINT "meetings_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "meetings_classification" CHECK ("meetings"."meetings"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "meetings_status_check" CHECK ("meetings"."meetings"."status" in ('open','purged')),
	CONSTRAINT "meetings_source_kind" CHECK ("meetings"."meetings"."source_kind" in ('manual','connector')),
	CONSTRAINT "meetings_source_whole" CHECK (("meetings"."meetings"."source_kind" = 'connector') = ("meetings"."meetings"."connection_id" is not null) and ("meetings"."meetings"."source_kind" = 'connector') = ("meetings"."meetings"."source_resource_id" is not null)),
	CONSTRAINT "meetings_title_length" CHECK (char_length("meetings"."meetings"."title") between 1 and 300),
	CONSTRAINT "meetings_version_check" CHECK ("meetings"."meetings"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "integrations"."business_record_actions" ADD CONSTRAINT "business_record_actions_organization_id_business_record_id_business_records_organization_id_id_fk" FOREIGN KEY ("organization_id","business_record_id") REFERENCES "integrations"."business_records"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."business_record_actions" ADD CONSTRAINT "business_record_actions_organization_id_external_action_id_external_actions_organization_id_id_fk" FOREIGN KEY ("organization_id","external_action_id") REFERENCES "integrations"."external_actions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."business_records" ADD CONSTRAINT "business_records_organization_id_connection_id_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "integrations"."connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."consent_records" ADD CONSTRAINT "consent_records_organization_id_meeting_id_participant_id_participants_organization_id_meeting_id_id_fk" FOREIGN KEY ("organization_id","meeting_id","participant_id") REFERENCES "meetings"."participants"("organization_id","meeting_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."consent_records" ADD CONSTRAINT "consent_records_organization_id_recorded_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","recorded_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."derivation_runs" ADD CONSTRAINT "derivation_runs_organization_id_meeting_id_notes_id_notes_organization_id_meeting_id_id_fk" FOREIGN KEY ("organization_id","meeting_id","notes_id") REFERENCES "meetings"."notes"("organization_id","meeting_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."derivation_runs" ADD CONSTRAINT "derivation_runs_organization_id_provider_approval_id_provider_approvals_organization_id_id_fk" FOREIGN KEY ("organization_id","provider_approval_id") REFERENCES "meetings"."provider_approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."derivation_runs" ADD CONSTRAINT "derivation_runs_organization_id_requested_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."import_requests" ADD CONSTRAINT "import_requests_organization_id_meeting_id_meetings_organization_id_id_fk" FOREIGN KEY ("organization_id","meeting_id") REFERENCES "meetings"."meetings"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."import_requests" ADD CONSTRAINT "import_requests_organization_id_source_approval_id_provider_approvals_organization_id_id_fk" FOREIGN KEY ("organization_id","source_approval_id") REFERENCES "meetings"."provider_approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."import_requests" ADD CONSTRAINT "import_requests_organization_id_requested_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."notes" ADD CONSTRAINT "notes_organization_id_meeting_id_meetings_organization_id_id_fk" FOREIGN KEY ("organization_id","meeting_id") REFERENCES "meetings"."meetings"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."notes" ADD CONSTRAINT "notes_organization_id_source_approval_id_provider_approvals_organization_id_id_fk" FOREIGN KEY ("organization_id","source_approval_id") REFERENCES "meetings"."provider_approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."notes" ADD CONSTRAINT "notes_organization_id_imported_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","imported_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."participants" ADD CONSTRAINT "participants_organization_id_meeting_id_meetings_organization_id_id_fk" FOREIGN KEY ("organization_id","meeting_id") REFERENCES "meetings"."meetings"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."participants" ADD CONSTRAINT "participants_organization_id_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."proposed_items" ADD CONSTRAINT "proposed_items_organization_id_meeting_id_run_id_derivation_runs_organization_id_meeting_id_id_fk" FOREIGN KEY ("organization_id","meeting_id","run_id") REFERENCES "meetings"."derivation_runs"("organization_id","meeting_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."proposed_items" ADD CONSTRAINT "proposed_items_organization_id_suggested_owner_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","suggested_owner_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."proposed_items" ADD CONSTRAINT "proposed_items_organization_id_decided_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","decided_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."proposed_items" ADD CONSTRAINT "proposed_items_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."provider_approvals" ADD CONSTRAINT "provider_approvals_organization_id_approved_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","approved_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."provider_approvals" ADD CONSTRAINT "provider_approvals_organization_id_revoked_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","revoked_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."settings" ADD CONSTRAINT "settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."settings" ADD CONSTRAINT "settings_organization_id_updated_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","updated_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."summaries" ADD CONSTRAINT "summaries_organization_id_meeting_id_run_id_derivation_runs_organization_id_meeting_id_id_fk" FOREIGN KEY ("organization_id","meeting_id","run_id") REFERENCES "meetings"."derivation_runs"("organization_id","meeting_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."meetings" ADD CONSTRAINT "meetings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."meetings" ADD CONSTRAINT "meetings_organization_id_organizer_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","organizer_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."meetings" ADD CONSTRAINT "meetings_organization_id_connection_id_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "integrations"."connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings"."meetings" ADD CONSTRAINT "meetings_organization_id_source_resource_id_external_resources_organization_id_id_fk" FOREIGN KEY ("organization_id","source_resource_id") REFERENCES "integrations"."external_resources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_record_actions_one_record" ON "integrations"."business_record_actions" USING btree ("organization_id","external_action_id");--> statement-breakpoint
CREATE INDEX "business_records_stream_idx" ON "integrations"."business_records" USING btree ("organization_id","connection_id","stream","updated_at");--> statement-breakpoint
CREATE INDEX "meeting_consent_latest_idx" ON "meetings"."consent_records" USING btree ("organization_id","participant_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_derivation_runs_one_open" ON "meetings"."derivation_runs" USING btree ("organization_id","notes_id","purpose") WHERE "meetings"."derivation_runs"."status" in ('requested','running');--> statement-breakpoint
CREATE INDEX "meeting_derivation_runs_meeting_idx" ON "meetings"."derivation_runs" USING btree ("organization_id","meeting_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_import_requests_one_open" ON "meetings"."import_requests" USING btree ("organization_id","meeting_id") WHERE "meetings"."import_requests"."status" = 'requested';--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_participants_one_membership" ON "meetings"."participants" USING btree ("organization_id","meeting_id","membership_id") WHERE "meetings"."participants"."membership_id" is not null;--> statement-breakpoint
CREATE INDEX "meeting_participants_member_idx" ON "meetings"."participants" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_proposed_items_one_work" ON "meetings"."proposed_items" USING btree ("organization_id","work_unit_id") WHERE "meetings"."proposed_items"."work_unit_id" is not null;--> statement-breakpoint
CREATE INDEX "meeting_proposed_items_meeting_idx" ON "meetings"."proposed_items" USING btree ("organization_id","meeting_id","status");--> statement-breakpoint
CREATE INDEX "meeting_provider_approvals_target_idx" ON "meetings"."provider_approvals" USING btree ("organization_id","target_ref","expires_at");--> statement-breakpoint
CREATE INDEX "meetings_organizer_idx" ON "meetings"."meetings" USING btree ("organization_id","organizer_membership_id","occurred_at");--> statement-breakpoint
CREATE INDEX "meetings_recent_idx" ON "meetings"."meetings" USING btree ("organization_id","occurred_at");