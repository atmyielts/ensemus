CREATE SCHEMA "federation";
--> statement-breakpoint
CREATE TABLE "federation"."org_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"changed_by_membership_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_settings_version_check" CHECK ("federation"."org_settings"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "federation"."grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sharing_organization_id" uuid NOT NULL,
	"receiving_organization_id" uuid,
	"status" text DEFAULT 'proposed' NOT NULL,
	"purpose" text NOT NULL,
	"max_classification" text DEFAULT 'internal' NOT NULL,
	"terms" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"token_hash" text NOT NULL,
	"invitation_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sharing_display_name" text NOT NULL,
	"receiving_display_name" text,
	"proposed_by_membership_id" uuid NOT NULL,
	"accepted_by_membership_id" uuid,
	"accepted_terms_hash" text,
	"accepted_at" timestamp with time zone,
	"confirmed_by_membership_id" uuid,
	"confirmed_terms_hash" text,
	"confirmed_at" timestamp with time zone,
	"ended_by_organization_id" uuid,
	"ended_by_membership_id" uuid,
	"end_reason" text,
	"ended_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grants_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "grants_not_self" CHECK ("federation"."grants"."receiving_organization_id" is distinct from "federation"."grants"."sharing_organization_id"),
	CONSTRAINT "grants_status_check" CHECK ("federation"."grants"."status" in ('proposed','accepted','active','ended')),
	CONSTRAINT "grants_purpose_check" CHECK ("federation"."grants"."purpose" in ('delegated_work','document_review')),
	CONSTRAINT "grants_max_classification_check" CHECK ("federation"."grants"."max_classification" in ('public','internal','confidential')),
	CONSTRAINT "grants_end_reason_check" CHECK ("federation"."grants"."end_reason" is null or "federation"."grants"."end_reason" in ('cancelled','declined','revoked','expired','disabled')),
	CONSTRAINT "grants_ended_shape" CHECK (("federation"."grants"."status" = 'ended') = ("federation"."grants"."end_reason" is not null and "federation"."grants"."ended_at" is not null and "federation"."grants"."ended_by_organization_id" is not null)),
	CONSTRAINT "grants_accepted_shape" CHECK ("federation"."grants"."status" not in ('accepted','active') or ("federation"."grants"."receiving_organization_id" is not null and "federation"."grants"."accepted_by_membership_id" is not null and "federation"."grants"."accepted_terms_hash" is not null and "federation"."grants"."accepted_at" is not null and "federation"."grants"."receiving_display_name" is not null)),
	CONSTRAINT "grants_active_shape" CHECK ("federation"."grants"."status" <> 'active' or ("federation"."grants"."confirmed_by_membership_id" is not null and "federation"."grants"."confirmed_terms_hash" is not null and "federation"."grants"."confirmed_at" is not null)),
	CONSTRAINT "grants_terms_hash_format" CHECK ("federation"."grants"."terms_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "grants_token_hash_format" CHECK ("federation"."grants"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "grants_expiry_order" CHECK ("federation"."grants"."invitation_expires_at" <= "federation"."grants"."expires_at"),
	CONSTRAINT "grants_version_check" CHECK ("federation"."grants"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "federation"."outbound_items" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"classification" text NOT NULL,
	"title" text NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"file_object_key" text,
	"file_sha256" text,
	"file_size_bytes" bigint,
	"file_mime_type" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"refuse_code" text,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "outbound_items_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "outbound_items_kind_check" CHECK ("federation"."outbound_items"."kind" in ('work_summary','artifact','status_update')),
	CONSTRAINT "outbound_items_source_type_check" CHECK ("federation"."outbound_items"."source_type" is null or "federation"."outbound_items"."source_type" in ('work_unit','artifact')),
	CONSTRAINT "outbound_items_classification_check" CHECK ("federation"."outbound_items"."classification" in ('public','internal','confidential')),
	CONSTRAINT "outbound_items_title_length" CHECK (char_length("federation"."outbound_items"."title") between 1 and 200),
	CONSTRAINT "outbound_items_body_size" CHECK (pg_column_size("federation"."outbound_items"."body") <= 65536),
	CONSTRAINT "outbound_items_state_check" CHECK ("federation"."outbound_items"."state" in ('queued','delivered','refused','withdrawn')),
	CONSTRAINT "outbound_items_refuse_code_format" CHECK ("federation"."outbound_items"."refuse_code" is null or "federation"."outbound_items"."refuse_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "outbound_items_content_hash_format" CHECK ("federation"."outbound_items"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "outbound_items_file_hash_format" CHECK ("federation"."outbound_items"."file_sha256" is null or "federation"."outbound_items"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "outbound_items_file_key_derived" CHECK ("federation"."outbound_items"."file_object_key" is null or "federation"."outbound_items"."file_object_key" = 'federation/outbound/' || "federation"."outbound_items"."organization_id"::text || '/' || "federation"."outbound_items"."id"::text),
	CONSTRAINT "outbound_items_file_complete" CHECK (("federation"."outbound_items"."file_object_key" is null) = ("federation"."outbound_items"."file_sha256" is null) and ("federation"."outbound_items"."file_object_key" is null) = ("federation"."outbound_items"."file_size_bytes" is null) and ("federation"."outbound_items"."file_object_key" is null) = ("federation"."outbound_items"."file_mime_type" is null)),
	CONSTRAINT "outbound_items_artifact_has_file" CHECK (("federation"."outbound_items"."kind" = 'artifact') = ("federation"."outbound_items"."file_object_key" is not null)),
	CONSTRAINT "outbound_items_version_check" CHECK ("federation"."outbound_items"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX "outbound_items_grant_idx" ON "federation"."outbound_items" USING btree ("grant_id","created_at");
--> statement-breakpoint
CREATE INDEX "outbound_items_source_idx" ON "federation"."outbound_items" USING btree ("organization_id","source_type","source_id");
--> statement-breakpoint
CREATE TABLE "federation"."inbound_items" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"sender_organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"classification" text NOT NULL,
	"title" text NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"file_object_key" text,
	"file_sha256" text,
	"file_size_bytes" bigint,
	"file_mime_type" text,
	"disposition" text DEFAULT 'pending' NOT NULL,
	"disposed_by_membership_id" uuid,
	"disposed_at" timestamp with time zone,
	"linked_work_unit_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "inbound_items_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "inbound_items_not_self" CHECK ("federation"."inbound_items"."organization_id" <> "federation"."inbound_items"."sender_organization_id"),
	CONSTRAINT "inbound_items_kind_check" CHECK ("federation"."inbound_items"."kind" in ('work_summary','artifact','status_update')),
	CONSTRAINT "inbound_items_classification_check" CHECK ("federation"."inbound_items"."classification" in ('public','internal','confidential')),
	CONSTRAINT "inbound_items_disposition_check" CHECK ("federation"."inbound_items"."disposition" in ('pending','accepted','rejected')),
	CONSTRAINT "inbound_items_file_key_derived" CHECK ("federation"."inbound_items"."file_object_key" is null or "federation"."inbound_items"."file_object_key" = 'federation/inbound/' || "federation"."inbound_items"."organization_id"::text || '/' || "federation"."inbound_items"."id"::text),
	CONSTRAINT "inbound_items_version_check" CHECK ("federation"."inbound_items"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX "inbound_items_grant_idx" ON "federation"."inbound_items" USING btree ("grant_id");
--> statement-breakpoint
CREATE INDEX "inbound_items_list_idx" ON "federation"."inbound_items" USING btree ("organization_id","disposition","received_at");
--> statement-breakpoint
CREATE TABLE "federation"."crossings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"item_id" uuid,
	"sender_organization_id" uuid NOT NULL,
	"receiver_organization_id" uuid NOT NULL,
	"kind" text,
	"outcome" text NOT NULL,
	"code" text,
	"content_sha256" text,
	"crossed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crossings_outcome_check" CHECK ("federation"."crossings"."outcome" in ('delivered','refused','purged')),
	CONSTRAINT "crossings_code_format" CHECK ("federation"."crossings"."code" is null or "federation"."crossings"."code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE INDEX "crossings_grant_idx" ON "federation"."crossings" USING btree ("grant_id","crossed_at");
--> statement-breakpoint
CREATE INDEX "crossings_sender_idx" ON "federation"."crossings" USING btree ("sender_organization_id","crossed_at");
--> statement-breakpoint
CREATE INDEX "crossings_receiver_idx" ON "federation"."crossings" USING btree ("receiver_organization_id","crossed_at");
--> statement-breakpoint
ALTER TABLE "federation"."org_settings" ADD CONSTRAINT "org_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."org_settings" ADD CONSTRAINT "org_settings_changed_by_fk" FOREIGN KEY ("organization_id","changed_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."grants" ADD CONSTRAINT "grants_sharing_organization_id_organizations_id_fk" FOREIGN KEY ("sharing_organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."grants" ADD CONSTRAINT "grants_receiving_organization_id_organizations_id_fk" FOREIGN KEY ("receiving_organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."grants" ADD CONSTRAINT "grants_ended_by_organization_id_organizations_id_fk" FOREIGN KEY ("ended_by_organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."grants" ADD CONSTRAINT "grants_proposed_by_fk" FOREIGN KEY ("sharing_organization_id","proposed_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."grants" ADD CONSTRAINT "grants_accepted_by_fk" FOREIGN KEY ("receiving_organization_id","accepted_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."grants" ADD CONSTRAINT "grants_confirmed_by_fk" FOREIGN KEY ("sharing_organization_id","confirmed_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."grants" ADD CONSTRAINT "grants_ended_by_fk" FOREIGN KEY ("ended_by_organization_id","ended_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."outbound_items" ADD CONSTRAINT "outbound_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."outbound_items" ADD CONSTRAINT "outbound_items_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "federation"."grants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."outbound_items" ADD CONSTRAINT "outbound_items_created_by_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."inbound_items" ADD CONSTRAINT "inbound_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."inbound_items" ADD CONSTRAINT "inbound_items_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "federation"."grants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."inbound_items" ADD CONSTRAINT "inbound_items_outbound_fk" FOREIGN KEY ("sender_organization_id","id") REFERENCES "federation"."outbound_items"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."inbound_items" ADD CONSTRAINT "inbound_items_disposed_by_fk" FOREIGN KEY ("organization_id","disposed_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."inbound_items" ADD CONSTRAINT "inbound_items_linked_work_fk" FOREIGN KEY ("organization_id","linked_work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "federation"."crossings" ADD CONSTRAINT "crossings_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "federation"."grants"("id") ON DELETE no action ON UPDATE no action;
