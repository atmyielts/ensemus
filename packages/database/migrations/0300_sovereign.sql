CREATE SCHEMA "sovereign";
--> statement-breakpoint
CREATE TABLE "sovereign"."license_records" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"license_id" uuid NOT NULL,
	"edition" text NOT NULL,
	"licensed_version" text NOT NULL,
	"term_kind" text NOT NULL,
	"key_ids" text[] NOT NULL,
	"envelope" text NOT NULL,
	"envelope_sha256" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"installed_by_membership_id" uuid,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_records_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "license_records_envelope_unique" UNIQUE("organization_id","envelope_sha256"),
	CONSTRAINT "license_records_term_check" CHECK ("sovereign"."license_records"."term_kind" in ('perpetual','pilot')),
	CONSTRAINT "license_records_sha256_format" CHECK ("sovereign"."license_records"."envelope_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "sovereign"."signed_documents" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"document_type" text NOT NULL,
	"document_id" text NOT NULL,
	"subject_license_id" uuid,
	"key_ids" text[] NOT NULL,
	"envelope" text NOT NULL,
	"envelope_sha256" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"installed_by_membership_id" uuid,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signed_documents_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "signed_documents_envelope_unique" UNIQUE("organization_id","envelope_sha256"),
	CONSTRAINT "signed_documents_type_check" CHECK ("sovereign"."signed_documents"."document_type" in ('maintenance','advisory','support_policy')),
	CONSTRAINT "signed_documents_sha256_format" CHECK ("sovereign"."signed_documents"."envelope_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "sovereign"."organization_exports" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"scope" text DEFAULT 'standard' NOT NULL,
	"recipient_public_key" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"requested_by_membership_id" uuid NOT NULL,
	"source_release" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot_at" timestamp with time zone,
	"tombstones_through" timestamp with time zone,
	"manifest_sealed_sha256" text,
	"part_count" integer DEFAULT 0 NOT NULL,
	"record_count" bigint DEFAULT 0 NOT NULL,
	"archive_bytes" bigint DEFAULT 0 NOT NULL,
	"excluded_restricted_work" integer DEFAULT 0 NOT NULL,
	"excluded_restricted_artifacts" integer DEFAULT 0 NOT NULL,
	"excluded_restricted_clients" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_exports_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "organization_exports_status_check" CHECK ("sovereign"."organization_exports"."status" in ('requested','running','ready','failed','expired')),
	CONSTRAINT "organization_exports_scope_check" CHECK ("sovereign"."organization_exports"."scope" in ('standard')),
	CONSTRAINT "organization_exports_key_id_format" CHECK ("sovereign"."organization_exports"."recipient_key_id" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "organization_exports_version_check" CHECK ("sovereign"."organization_exports"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sovereign"."organization_export_parts" (
	"organization_id" uuid NOT NULL,
	"export_id" uuid NOT NULL,
	"path" text NOT NULL,
	"section" text NOT NULL,
	"record_count" integer NOT NULL,
	"plaintext_sha256" text NOT NULL,
	"sealed_sha256" text NOT NULL,
	"sealed_bytes" bigint NOT NULL,
	"object_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_export_parts_pk" PRIMARY KEY("organization_id","export_id","path"),
	CONSTRAINT "organization_export_parts_record_count_check" CHECK ("sovereign"."organization_export_parts"."record_count" >= 0),
	CONSTRAINT "organization_export_parts_bytes_check" CHECK ("sovereign"."organization_export_parts"."sealed_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sovereign"."organization_imports" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by_membership_id" uuid NOT NULL,
	"fallback_membership_id" uuid NOT NULL,
	"source_organization_id" uuid,
	"source_export_id" uuid,
	"source_release" text,
	"archive_sha256" text,
	"exported_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"applied_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warning_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_code" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_imports_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "organization_imports_status_check" CHECK ("sovereign"."organization_imports"."status" in ('requested','running','completed','completed_with_warnings','failed')),
	CONSTRAINT "organization_imports_version_check" CHECK ("sovereign"."organization_imports"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sovereign"."organization_import_parts" (
	"organization_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"path" text NOT NULL,
	"section" text NOT NULL,
	"record_count" integer NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_import_parts_pk" PRIMARY KEY("organization_id","import_id","path")
);
--> statement-breakpoint
CREATE TABLE "sovereign"."imported_people" (
	"organization_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"source_membership_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"source_role" text NOT NULL,
	"source_status" text NOT NULL,
	"target_membership_id" uuid,
	"invitation_id" uuid,
	"linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imported_people_pk" PRIMARY KEY("organization_id","source_membership_id"),
	CONSTRAINT "imported_people_role_check" CHECK ("sovereign"."imported_people"."source_role" in ('owner','admin','member'))
);
--> statement-breakpoint
CREATE TABLE "sovereign"."imported_records" (
	"organization_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"work_unit_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imported_records_pk" PRIMARY KEY("organization_id","import_id","record_type","source_id"),
	CONSTRAINT "imported_records_type_check" CHECK ("sovereign"."imported_records"."record_type" in ('approval','approval_decision','work_transition','external_action','external_action_receipt','audit_event'))
);
--> statement-breakpoint
ALTER TABLE "sovereign"."license_records" ADD CONSTRAINT "license_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."license_records" ADD CONSTRAINT "license_records_installed_by_fk" FOREIGN KEY ("organization_id","installed_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."signed_documents" ADD CONSTRAINT "signed_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."signed_documents" ADD CONSTRAINT "signed_documents_installed_by_fk" FOREIGN KEY ("organization_id","installed_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."organization_exports" ADD CONSTRAINT "organization_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."organization_exports" ADD CONSTRAINT "organization_exports_requested_by_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."organization_export_parts" ADD CONSTRAINT "organization_export_parts_export_fk" FOREIGN KEY ("organization_id","export_id") REFERENCES "sovereign"."organization_exports"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."organization_imports" ADD CONSTRAINT "organization_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."organization_imports" ADD CONSTRAINT "organization_imports_requested_by_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."organization_imports" ADD CONSTRAINT "organization_imports_fallback_fk" FOREIGN KEY ("organization_id","fallback_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."organization_import_parts" ADD CONSTRAINT "organization_import_parts_import_fk" FOREIGN KEY ("organization_id","import_id") REFERENCES "sovereign"."organization_imports"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."imported_people" ADD CONSTRAINT "imported_people_import_fk" FOREIGN KEY ("organization_id","import_id") REFERENCES "sovereign"."organization_imports"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."imported_people" ADD CONSTRAINT "imported_people_target_fk" FOREIGN KEY ("organization_id","target_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."imported_people" ADD CONSTRAINT "imported_people_invitation_fk" FOREIGN KEY ("organization_id","invitation_id") REFERENCES "org"."invitations"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sovereign"."imported_records" ADD CONSTRAINT "imported_records_import_fk" FOREIGN KEY ("organization_id","import_id") REFERENCES "sovereign"."organization_imports"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "license_records_issued_idx" ON "sovereign"."license_records" USING btree ("organization_id","issued_at");
--> statement-breakpoint
CREATE INDEX "signed_documents_type_idx" ON "sovereign"."signed_documents" USING btree ("organization_id","document_type","issued_at");
--> statement-breakpoint
CREATE INDEX "organization_exports_page_idx" ON "sovereign"."organization_exports" USING btree ("organization_id","requested_at","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_exports_one_active" ON "sovereign"."organization_exports" USING btree ("organization_id") WHERE "sovereign"."organization_exports"."status" in ('requested','running');
--> statement-breakpoint
CREATE INDEX "organization_exports_expiry_idx" ON "sovereign"."organization_exports" USING btree ("organization_id","expires_at") WHERE "sovereign"."organization_exports"."status" = 'ready';
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_imports_one_only" ON "sovereign"."organization_imports" USING btree ("organization_id") WHERE "sovereign"."organization_imports"."status" <> 'failed';
--> statement-breakpoint
CREATE INDEX "imported_people_unlinked_idx" ON "sovereign"."imported_people" USING btree ("organization_id","linked_at");
--> statement-breakpoint
CREATE INDEX "imported_records_work_idx" ON "sovereign"."imported_records" USING btree ("organization_id","work_unit_id","occurred_at");
