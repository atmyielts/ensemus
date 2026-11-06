CREATE SCHEMA "marketplace";
--> statement-breakpoint
CREATE SCHEMA "sandbox";
--> statement-breakpoint
CREATE SCHEMA "skills";
--> statement-breakpoint
CREATE TABLE "marketplace"."installations" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"package_id" uuid,
	"skill_version_id" uuid,
	"requested_by_membership_id" uuid NOT NULL,
	"removed_by_membership_id" uuid,
	"failure_code" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "installations_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "marketplace_installations_state" CHECK ("marketplace"."installations"."state" in ('requested','installing','installed','failed','removed')),
	CONSTRAINT "marketplace_installations_failed" CHECK (("marketplace"."installations"."state" = 'failed') = ("marketplace"."installations"."failure_code" is not null)),
	CONSTRAINT "marketplace_installations_installed" CHECK ("marketplace"."installations"."state" <> 'installed' or ("marketplace"."installations"."package_id" is not null and "marketplace"."installations"."skill_version_id" is not null)),
	CONSTRAINT "marketplace_installations_version" CHECK ("marketplace"."installations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "marketplace"."listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisher_id" uuid NOT NULL,
	"publisher_organization_id" uuid NOT NULL,
	"publisher_display_name" text NOT NULL,
	"submission_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"name" text NOT NULL,
	"semver" text NOT NULL,
	"display_name" text NOT NULL,
	"summary" text NOT NULL,
	"digest" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"license" text NOT NULL,
	"execution_kind" text NOT NULL,
	"max_classification" text NOT NULL,
	"signer_key_id" text NOT NULL,
	"signer_public_key" "bytea" NOT NULL,
	"signature" "bytea" NOT NULL,
	"reviewer_key_id" text NOT NULL,
	"attestation_signature" "bytea" NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"state" text DEFAULT 'listed' NOT NULL,
	"delist_mode" text,
	"delist_code" text,
	"listed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delisted_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "marketplace_listings_review" UNIQUE("review_id"),
	CONSTRAINT "marketplace_listings_release" UNIQUE("publisher_id","name","semver"),
	CONSTRAINT "marketplace_listings_state" CHECK ("marketplace"."listings"."state" in ('listed','delisted')),
	CONSTRAINT "marketplace_listings_digest" CHECK ("marketplace"."listings"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "marketplace_listings_key_size" CHECK (octet_length("marketplace"."listings"."signer_public_key") = 32),
	CONSTRAINT "marketplace_listings_signature_size" CHECK (octet_length("marketplace"."listings"."signature") = 64),
	CONSTRAINT "marketplace_listings_execution" CHECK ("marketplace"."listings"."execution_kind" in ('declarative','sandbox')),
	CONSTRAINT "marketplace_listings_max_classification" CHECK ("marketplace"."listings"."max_classification" in ('public','internal','confidential')),
	CONSTRAINT "marketplace_listings_delist_mode" CHECK ("marketplace"."listings"."delist_mode" in ('stop_new','revoke')),
	CONSTRAINT "marketplace_listings_delisted" CHECK (("marketplace"."listings"."state" = 'delisted') = ("marketplace"."listings"."delist_mode" is not null and "marketplace"."listings"."delist_code" is not null and "marketplace"."listings"."delisted_at" is not null)),
	CONSTRAINT "marketplace_listings_version" CHECK ("marketplace"."listings"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "marketplace"."publishers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_publishers_organization" UNIQUE("organization_id"),
	CONSTRAINT "marketplace_publishers_state" CHECK ("marketplace"."publishers"."state" in ('active','suspended')),
	CONSTRAINT "marketplace_publishers_name_size" CHECK (char_length("marketplace"."publishers"."display_name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "marketplace"."security_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_organization_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"signer_key_id" text NOT NULL,
	"reviewer_key_id" text NOT NULL,
	"reviewer_label" text NOT NULL,
	"verdict" text NOT NULL,
	"checks" jsonb NOT NULL,
	"finding_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"attestation" jsonb NOT NULL,
	"attestation_signature" "bytea" NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_reviews_verdict" CHECK ("marketplace"."security_reviews"."verdict" in ('approved','rejected')),
	CONSTRAINT "marketplace_reviews_digest" CHECK ("marketplace"."security_reviews"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "marketplace_reviews_reviewer_key" CHECK ("marketplace"."security_reviews"."reviewer_key_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "marketplace_reviews_signature_size" CHECK (octet_length("marketplace"."security_reviews"."attestation_signature") = 64),
	CONSTRAINT "marketplace_reviews_label_size" CHECK (char_length("marketplace"."security_reviews"."reviewer_label") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "marketplace"."submissions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"publisher_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"semver" text NOT NULL,
	"digest" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"signer_key_id" text NOT NULL,
	"signer_public_key" "bytea" NOT NULL,
	"signature" "bytea" NOT NULL,
	"bundle_object_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"state" text DEFAULT 'submitted' NOT NULL,
	"submitted_by_membership_id" uuid NOT NULL,
	"publish_confirmed_at" timestamp with time zone NOT NULL,
	"withdrawn_by_membership_id" uuid,
	"delist_requested_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "submissions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "marketplace_submissions_state" CHECK ("marketplace"."submissions"."state" in ('submitted','in_review','approved','rejected','withdrawn')),
	CONSTRAINT "marketplace_submissions_digest" CHECK ("marketplace"."submissions"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "marketplace_submissions_signer" CHECK ("marketplace"."submissions"."signer_key_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "marketplace_submissions_key_size" CHECK (octet_length("marketplace"."submissions"."signer_public_key") = 32),
	CONSTRAINT "marketplace_submissions_version" CHECK ("marketplace"."submissions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sandbox"."runs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"purpose" text NOT NULL,
	"test_fixture" integer,
	"work_unit_id" uuid,
	"agent_run_id" uuid,
	"execution_step_id" uuid,
	"requested_by_membership_id" uuid,
	"classification" text NOT NULL,
	"input" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"policy_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"outcome_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"exit_code" integer,
	"wall_ms" integer,
	"cpu_ms" integer,
	"peak_memory_kb" integer,
	"stdout_bytes" integer,
	"stderr_bytes" integer,
	"output" jsonb,
	"output_sha256" text,
	"isolation_probe_passed_at" timestamp with time zone,
	"runtime_name" text,
	"runtime_version" text,
	"cancel_requested_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "sandbox_runs_purpose" CHECK ("sandbox"."runs"."purpose" in ('skill_test','agent_tool','operator_test')),
	CONSTRAINT "sandbox_runs_status" CHECK ("sandbox"."runs"."status" in ('queued','running','succeeded','failed','timed_out','memory_exceeded','output_exceeded','denied','cancelled','runner_unavailable')),
	CONSTRAINT "sandbox_runs_classification" CHECK ("sandbox"."runs"."classification" in ('public','internal','confidential')),
	CONSTRAINT "sandbox_runs_digest" CHECK ("sandbox"."runs"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sandbox_runs_policy_hash" CHECK ("sandbox"."runs"."policy_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sandbox_runs_input_size" CHECK (octet_length("sandbox"."runs"."input"::text) <= 1048576),
	CONSTRAINT "sandbox_runs_output_size" CHECK (octet_length("sandbox"."runs"."output"::text) <= 1048576),
	CONSTRAINT "sandbox_runs_attempts" CHECK ("sandbox"."runs"."attempts" between 0 and 3),
	CONSTRAINT "sandbox_runs_test_fixture" CHECK (("sandbox"."runs"."purpose" = 'skill_test') = ("sandbox"."runs"."test_fixture" is not null)),
	CONSTRAINT "sandbox_runs_agent_link" CHECK (("sandbox"."runs"."purpose" = 'agent_tool') = ("sandbox"."runs"."agent_run_id" is not null and "sandbox"."runs"."execution_step_id" is not null)),
	CONSTRAINT "sandbox_runs_version" CHECK ("sandbox"."runs"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "skills"."packages" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"origin" text DEFAULT 'tenant' NOT NULL,
	"listing_id" uuid,
	"state" text DEFAULT 'active' NOT NULL,
	"content_classification" text DEFAULT 'internal' NOT NULL,
	"owner_membership_id" uuid,
	"created_by_membership_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packages_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "skill_packages_name" UNIQUE("organization_id","name"),
	CONSTRAINT "skill_packages_name_format" CHECK ("skills"."packages"."name" ~ '^[a-z][a-z0-9-]{1,63}$'),
	CONSTRAINT "skill_packages_display_size" CHECK (char_length("skills"."packages"."display_name") between 1 and 120),
	CONSTRAINT "skill_packages_origin" CHECK ("skills"."packages"."origin" in ('tenant','marketplace')),
	CONSTRAINT "skill_packages_state" CHECK ("skills"."packages"."state" in ('active','disabled')),
	CONSTRAINT "skill_packages_classification" CHECK ("skills"."packages"."content_classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "skill_packages_origin_listing" CHECK (("skills"."packages"."origin" = 'marketplace') = ("skills"."packages"."listing_id" is not null)),
	CONSTRAINT "skill_packages_version" CHECK ("skills"."packages"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "skills"."test_runs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"mode" text NOT NULL,
	"outcome" text NOT NULL,
	"fixtures_total" integer NOT NULL,
	"fixtures_passed" integer NOT NULL,
	"first_failed_fixture" integer,
	"code" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_runs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "skill_test_runs_mode" CHECK ("skills"."test_runs"."mode" in ('contract','sandbox')),
	CONSTRAINT "skill_test_runs_outcome" CHECK ("skills"."test_runs"."outcome" in ('passed','failed','error')),
	CONSTRAINT "skill_test_runs_digest" CHECK ("skills"."test_runs"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_test_runs_counts" CHECK ("skills"."test_runs"."fixtures_total" between 1 and 50 and "skills"."test_runs"."fixtures_passed" between 0 and "skills"."test_runs"."fixtures_total"),
	CONSTRAINT "skill_test_runs_passed_means_all" CHECK ("skills"."test_runs"."outcome" <> 'passed' or "skills"."test_runs"."fixtures_passed" = "skills"."test_runs"."fixtures_total")
);
--> statement-breakpoint
CREATE TABLE "skills"."package_versions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"state" text DEFAULT 'uploaded' NOT NULL,
	"bundle_object_key" text NOT NULL,
	"bundle_sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"semver" text,
	"digest" text,
	"manifest" jsonb,
	"execution_kind" text,
	"license" text,
	"max_classification" text,
	"signer_key_id" text,
	"signature" "bytea",
	"uploaded_by_membership_id" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"published_by_membership_id" uuid,
	"published_at" timestamp with time zone,
	"yanked_by_membership_id" uuid,
	"yanked_at" timestamp with time zone,
	"reject_code" text,
	"yank_code" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_versions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "skill_versions_state" CHECK ("skills"."package_versions"."state" in ('uploaded','verifying','verified','rejected','published','yanked')),
	CONSTRAINT "skill_versions_bundle_hash" CHECK ("skills"."package_versions"."bundle_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_versions_digest" CHECK ("skills"."package_versions"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_versions_signer_key" CHECK ("skills"."package_versions"."signer_key_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_versions_size" CHECK ("skills"."package_versions"."size_bytes" between 1 and 8388608),
	CONSTRAINT "skill_versions_semver_format" CHECK ("skills"."package_versions"."semver" ~ '^[0-9]+[.][0-9]+[.][0-9]+$'),
	CONSTRAINT "skill_versions_execution" CHECK ("skills"."package_versions"."execution_kind" in ('declarative','sandbox')),
	CONSTRAINT "skill_versions_max_classification" CHECK ("skills"."package_versions"."max_classification" in ('public','internal','confidential')),
	CONSTRAINT "skill_versions_checked_complete" CHECK ("skills"."package_versions"."state" not in ('verified','published') or (
        "skills"."package_versions"."semver" is not null and "skills"."package_versions"."digest" is not null and "skills"."package_versions"."manifest" is not null
        and "skills"."package_versions"."execution_kind" is not null and "skills"."package_versions"."license" is not null
        and "skills"."package_versions"."max_classification" is not null and "skills"."package_versions"."signer_key_id" is not null
        and "skills"."package_versions"."signature" is not null and "skills"."package_versions"."verified_at" is not null)),
	CONSTRAINT "skill_versions_published_by" CHECK ("skills"."package_versions"."state" <> 'published' or ("skills"."package_versions"."published_by_membership_id" is not null and "skills"."package_versions"."published_at" is not null)),
	CONSTRAINT "skill_versions_reject" CHECK (("skills"."package_versions"."state" = 'rejected') = ("skills"."package_versions"."reject_code" is not null)),
	CONSTRAINT "skill_versions_yank" CHECK (("skills"."package_versions"."state" = 'yanked') = ("skills"."package_versions"."yank_code" is not null and "skills"."package_versions"."yanked_at" is not null)),
	CONSTRAINT "skill_versions_two_people" CHECK ("skills"."package_versions"."published_by_membership_id" is null or "skills"."package_versions"."uploaded_by_membership_id" is null
        or "skills"."package_versions"."published_by_membership_id" <> "skills"."package_versions"."uploaded_by_membership_id"),
	CONSTRAINT "skill_versions_version" CHECK ("skills"."package_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "skills"."trusted_signers" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"key_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"added_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_membership_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "trusted_signers_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "trusted_signers_key" UNIQUE("organization_id","key_id"),
	CONSTRAINT "trusted_signers_state" CHECK ("skills"."trusted_signers"."state" in ('active','revoked')),
	CONSTRAINT "trusted_signers_key_format" CHECK ("skills"."trusted_signers"."key_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "trusted_signers_key_size" CHECK (octet_length("skills"."trusted_signers"."public_key") = 32),
	CONSTRAINT "trusted_signers_name_size" CHECK (char_length("skills"."trusted_signers"."display_name") between 1 and 120),
	CONSTRAINT "trusted_signers_revocation" CHECK (("skills"."trusted_signers"."state" = 'revoked') = ("skills"."trusted_signers"."revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "marketplace"."installations" ADD CONSTRAINT "installations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."installations" ADD CONSTRAINT "installations_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "marketplace"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."installations" ADD CONSTRAINT "installations_organization_id_package_id_packages_organization_id_id_fk" FOREIGN KEY ("organization_id","package_id") REFERENCES "skills"."packages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."installations" ADD CONSTRAINT "installations_organization_id_skill_version_id_package_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","skill_version_id") REFERENCES "skills"."package_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."installations" ADD CONSTRAINT "installations_organization_id_requested_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."installations" ADD CONSTRAINT "installations_organization_id_removed_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","removed_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."listings" ADD CONSTRAINT "listings_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "marketplace"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."listings" ADD CONSTRAINT "listings_review_id_security_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "marketplace"."security_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."listings" ADD CONSTRAINT "listings_publisher_organization_id_submission_id_submissions_organization_id_id_fk" FOREIGN KEY ("publisher_organization_id","submission_id") REFERENCES "marketplace"."submissions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."publishers" ADD CONSTRAINT "publishers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."security_reviews" ADD CONSTRAINT "security_reviews_submission_organization_id_submission_id_submissions_organization_id_id_fk" FOREIGN KEY ("submission_organization_id","submission_id") REFERENCES "marketplace"."submissions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."submissions" ADD CONSTRAINT "submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."submissions" ADD CONSTRAINT "submissions_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "marketplace"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."submissions" ADD CONSTRAINT "submissions_organization_id_skill_version_id_package_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","skill_version_id") REFERENCES "skills"."package_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."submissions" ADD CONSTRAINT "submissions_organization_id_package_id_packages_organization_id_id_fk" FOREIGN KEY ("organization_id","package_id") REFERENCES "skills"."packages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."submissions" ADD CONSTRAINT "submissions_organization_id_submitted_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","submitted_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."submissions" ADD CONSTRAINT "submissions_organization_id_withdrawn_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","withdrawn_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox"."runs" ADD CONSTRAINT "runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox"."runs" ADD CONSTRAINT "runs_organization_id_skill_version_id_package_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","skill_version_id") REFERENCES "skills"."package_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox"."runs" ADD CONSTRAINT "runs_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox"."runs" ADD CONSTRAINT "runs_organization_id_requested_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."packages" ADD CONSTRAINT "packages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."packages" ADD CONSTRAINT "packages_organization_id_owner_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."packages" ADD CONSTRAINT "packages_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."test_runs" ADD CONSTRAINT "test_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."test_runs" ADD CONSTRAINT "test_runs_organization_id_skill_version_id_package_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","skill_version_id") REFERENCES "skills"."package_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."package_versions" ADD CONSTRAINT "package_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."package_versions" ADD CONSTRAINT "package_versions_organization_id_package_id_packages_organization_id_id_fk" FOREIGN KEY ("organization_id","package_id") REFERENCES "skills"."packages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."package_versions" ADD CONSTRAINT "package_versions_organization_id_uploaded_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","uploaded_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."package_versions" ADD CONSTRAINT "package_versions_organization_id_published_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","published_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."package_versions" ADD CONSTRAINT "package_versions_organization_id_yanked_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","yanked_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."trusted_signers" ADD CONSTRAINT "trusted_signers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."trusted_signers" ADD CONSTRAINT "trusted_signers_organization_id_added_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","added_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills"."trusted_signers" ADD CONSTRAINT "trusted_signers_organization_id_revoked_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","revoked_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_installations_one_live" ON "marketplace"."installations" USING btree ("organization_id","listing_id") WHERE "marketplace"."installations"."state" in ('requested','installing','installed');--> statement-breakpoint
CREATE INDEX "marketplace_installations_listing_idx" ON "marketplace"."installations" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "marketplace_listings_state_idx" ON "marketplace"."listings" USING btree ("state","listed_at");--> statement-breakpoint
CREATE INDEX "marketplace_reviews_submission_idx" ON "marketplace"."security_reviews" USING btree ("submission_organization_id","submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_submissions_one_open" ON "marketplace"."submissions" USING btree ("organization_id","skill_version_id") WHERE "marketplace"."submissions"."state" in ('submitted','in_review');--> statement-breakpoint
CREATE INDEX "marketplace_submissions_queue_idx" ON "marketplace"."submissions" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_status_idx" ON "sandbox"."runs" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_version_idx" ON "sandbox"."runs" USING btree ("organization_id","skill_version_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_agent_idx" ON "sandbox"."runs" USING btree ("organization_id","agent_run_id");--> statement-breakpoint
CREATE INDEX "skill_test_runs_version_idx" ON "skills"."test_runs" USING btree ("organization_id","skill_version_id","finished_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_semver" ON "skills"."package_versions" USING btree ("organization_id","package_id","semver") WHERE "skills"."package_versions"."semver" is not null and "skills"."package_versions"."state" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_bundle" ON "skills"."package_versions" USING btree ("organization_id","package_id","bundle_sha256") WHERE "skills"."package_versions"."state" <> 'rejected';--> statement-breakpoint
CREATE INDEX "skill_versions_package_idx" ON "skills"."package_versions" USING btree ("organization_id","package_id","uploaded_at");--> statement-breakpoint
CREATE INDEX "skill_versions_signer_idx" ON "skills"."package_versions" USING btree ("organization_id","signer_key_id");