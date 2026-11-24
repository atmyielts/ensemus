CREATE SCHEMA "tenancy";
--> statement-breakpoint
CREATE TABLE "tenancy"."deployment_profile" (
	"singleton" boolean DEFAULT true NOT NULL,
	"tier" text DEFAULT 'shared' NOT NULL,
	"pinned_organization_id" uuid,
	"home_region" text,
	"cross_org_enabled" boolean DEFAULT false NOT NULL,
	"profile_sha256" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_profile_pkey" PRIMARY KEY("singleton"),
	CONSTRAINT "deployment_profile_one_row" CHECK ("tenancy"."deployment_profile"."singleton"),
	CONSTRAINT "deployment_profile_tier_check" CHECK ("tenancy"."deployment_profile"."tier" in ('shared','dedicated')),
	CONSTRAINT "deployment_profile_pin_check" CHECK (("tenancy"."deployment_profile"."tier" = 'dedicated') = ("tenancy"."deployment_profile"."pinned_organization_id" is not null)),
	CONSTRAINT "deployment_profile_dedicated_alone" CHECK ("tenancy"."deployment_profile"."tier" = 'shared' or not "tenancy"."deployment_profile"."cross_org_enabled"),
	CONSTRAINT "deployment_profile_region_format" CHECK ("tenancy"."deployment_profile"."home_region" is null or "tenancy"."deployment_profile"."home_region" ~ '^[a-z][a-z0-9-]{1,31}$'),
	CONSTRAINT "deployment_profile_hash_format" CHECK ("tenancy"."deployment_profile"."profile_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tenancy"."isolation_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aspect" text NOT NULL,
	"result" text NOT NULL,
	"code" text,
	"release_version" text NOT NULL,
	"evidence_sha256" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "isolation_evidence_aspect_check" CHECK ("tenancy"."isolation_evidence"."aspect" in ('database','network','worker_pool','temporal_namespace','object_store','backups','embeddings','telemetry','key_encryption_key')),
	CONSTRAINT "isolation_evidence_result_check" CHECK ("tenancy"."isolation_evidence"."result" in ('passed','failed','declared')),
	CONSTRAINT "isolation_evidence_code_format" CHECK ("tenancy"."isolation_evidence"."code" is null or "tenancy"."isolation_evidence"."code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "isolation_evidence_hash_format" CHECK ("tenancy"."isolation_evidence"."evidence_sha256" is null or "tenancy"."isolation_evidence"."evidence_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "isolation_evidence_latest_idx" ON "tenancy"."isolation_evidence" USING btree ("aspect","checked_at");
--> statement-breakpoint
CREATE TABLE "tenancy"."residency_requirements" (
	"organization_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"region" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"set_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "residency_requirements_organization_id_scope_pk" PRIMARY KEY("organization_id","scope"),
	CONSTRAINT "residency_requirements_scope_check" CHECK ("tenancy"."residency_requirements"."scope" in ('all','public','internal','confidential','restricted')),
	CONSTRAINT "residency_requirements_region_format" CHECK ("tenancy"."residency_requirements"."region" ~ '^[a-z][a-z0-9-]{1,31}$'),
	CONSTRAINT "residency_requirements_version_check" CHECK ("tenancy"."residency_requirements"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "tenancy"."residency_requirements" ADD CONSTRAINT "residency_requirements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenancy"."residency_requirements" ADD CONSTRAINT "residency_requirements_set_by_fk" FOREIGN KEY ("organization_id","set_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
