-- Workspace suites (ADR-038 D1, D4, D5). Tables only. Who may write them, and how a consent attempt may
-- move, are in 0561, which is flagged for human security review.

-- One consent attempt at Google or Microsoft. It holds references to sealed values (the PKCE verifier,
-- the authorization code, a customer's own client) and the SHA-256 of the state, never the values.
CREATE TABLE "integrations"."oauth_authorizations" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"connector_type" text NOT NULL,
	"display_name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_kind" text NOT NULL,
	"client_id" text NOT NULL,
	"customer_client_secret_id" uuid,
	"requested_capabilities" text[] NOT NULL,
	"requested_scopes" text[] NOT NULL,
	"owner_membership_id" uuid,
	"started_by_membership_id" uuid NOT NULL,
	"state_sha256" text NOT NULL,
	"verifier_secret_id" uuid NOT NULL,
	"code_secret_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"connection_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorizations_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "oauth_authorizations_connector_type" CHECK ("integrations"."oauth_authorizations"."connector_type" in ('google_workspace','microsoft_365')),
	CONSTRAINT "oauth_authorizations_display_name" CHECK (char_length("integrations"."oauth_authorizations"."display_name") between 1 and 200),
	CONSTRAINT "oauth_authorizations_config_size" CHECK (jsonb_typeof("integrations"."oauth_authorizations"."config") = 'object' and octet_length("integrations"."oauth_authorizations"."config"::text) <= 4096),
	CONSTRAINT "oauth_authorizations_client_kind" CHECK ("integrations"."oauth_authorizations"."client_kind" in ('platform','customer')),
	CONSTRAINT "oauth_authorizations_client_id" CHECK (char_length("integrations"."oauth_authorizations"."client_id") between 1 and 512),
	-- The operator's secret never sits in a tenant's row. A customer's own client always does, sealed.
	CONSTRAINT "oauth_authorizations_customer_secret" CHECK (("integrations"."oauth_authorizations"."client_kind" = 'customer') = ("integrations"."oauth_authorizations"."customer_client_secret_id" is not null)),
	CONSTRAINT "oauth_authorizations_capabilities" CHECK (cardinality("integrations"."oauth_authorizations"."requested_capabilities") between 1 and 6 and "integrations"."oauth_authorizations"."requested_capabilities" <@ array['files','directory','mail','calendar','documents','chat']::text[]),
	CONSTRAINT "oauth_authorizations_scopes" CHECK (cardinality("integrations"."oauth_authorizations"."requested_scopes") between 1 and 64),
	-- A member connects only their own account (ADR-038 D5).
	CONSTRAINT "oauth_authorizations_owner_self" CHECK ("integrations"."oauth_authorizations"."owner_membership_id" is null or "integrations"."oauth_authorizations"."owner_membership_id" = "integrations"."oauth_authorizations"."started_by_membership_id"),
	CONSTRAINT "oauth_authorizations_state_sha256" CHECK ("integrations"."oauth_authorizations"."state_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_authorizations_status" CHECK ("integrations"."oauth_authorizations"."status" in ('pending','code_received','exchanging','connected','denied','failed','expired')),
	CONSTRAINT "oauth_authorizations_error_code" CHECK ("integrations"."oauth_authorizations"."error_code" is null or "integrations"."oauth_authorizations"."error_code" ~ '^[A-Z][A-Z0-9_]{2,63}$'),
	-- A refusal always says which one, from a fixed list, and nothing else carries a code.
	CONSTRAINT "oauth_authorizations_error_when_refused" CHECK (("integrations"."oauth_authorizations"."status" in ('denied','failed')) = ("integrations"."oauth_authorizations"."error_code" is not null)),
	CONSTRAINT "oauth_authorizations_connection_when_connected" CHECK (("integrations"."oauth_authorizations"."status" = 'connected') = ("integrations"."oauth_authorizations"."connection_id" is not null)),
	CONSTRAINT "oauth_authorizations_code_when_received" CHECK ("integrations"."oauth_authorizations"."status" not in ('code_received','exchanging','connected') or "integrations"."oauth_authorizations"."code_secret_id" is not null),
	-- State is good for ten minutes at most (ADR-038 D1).
	CONSTRAINT "oauth_authorizations_expiry" CHECK ("integrations"."oauth_authorizations"."expires_at" > "integrations"."oauth_authorizations"."created_at" and "integrations"."oauth_authorizations"."expires_at" <= "integrations"."oauth_authorizations"."created_at" + interval '10 minutes')
);
--> statement-breakpoint
-- A provider group mirrored as a team that only the directory sync may change (ADR-038 D4). Google groups
-- are keyed by email and Microsoft groups by object ID, which is what each one's file permissions carry.
CREATE TABLE "integrations"."directory_groups" (
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"seen_generation" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_groups_organization_id_connection_id_external_id_pk" PRIMARY KEY("organization_id","connection_id","external_id"),
	-- One group per team, so a team is never moved by two providers or two groups.
	CONSTRAINT "directory_groups_team" UNIQUE("organization_id","team_id"),
	CONSTRAINT "directory_groups_external_id" CHECK (char_length("integrations"."directory_groups"."external_id") between 1 and 1024),
	CONSTRAINT "directory_groups_display_name" CHECK (char_length("integrations"."directory_groups"."display_name") between 1 and 500),
	CONSTRAINT "directory_groups_generation" CHECK ("integrations"."directory_groups"."seen_generation" >= 0)
);
--> statement-breakpoint
-- Null for an organization's connection, set for one member's own (ADR-038 D5). Fixed once written: 0013's
-- column grants leave it out, so moving a connection to another person means a new connection.
ALTER TABLE "integrations"."connections" ADD COLUMN "owner_membership_id" uuid;
--> statement-breakpoint
ALTER TABLE "integrations"."connections" ADD CONSTRAINT "connections_organization_id_owner_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_organization_id_customer_client_secret_id_sealed_secrets_organization_id_id_fk" FOREIGN KEY ("organization_id","customer_client_secret_id") REFERENCES "secrets"."sealed_secrets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_organization_id_verifier_secret_id_sealed_secrets_organization_id_id_fk" FOREIGN KEY ("organization_id","verifier_secret_id") REFERENCES "secrets"."sealed_secrets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_organization_id_code_secret_id_sealed_secrets_organization_id_id_fk" FOREIGN KEY ("organization_id","code_secret_id") REFERENCES "secrets"."sealed_secrets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_organization_id_owner_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_organization_id_started_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","started_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_organization_id_connection_id_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "integrations"."connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."directory_groups" ADD CONSTRAINT "directory_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."directory_groups" ADD CONSTRAINT "directory_groups_organization_id_connection_id_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "integrations"."connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Removing a group's team removes the link with it, in the same statement.
ALTER TABLE "integrations"."directory_groups" ADD CONSTRAINT "directory_groups_organization_id_team_id_teams_organization_id_id_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "org"."teams"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_owner_idx" ON "integrations"."connections" USING btree ("organization_id","owner_membership_id") WHERE "integrations"."connections"."owner_membership_id" is not null;--> statement-breakpoint
CREATE INDEX "oauth_authorizations_status_idx" ON "integrations"."oauth_authorizations" USING btree ("organization_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "oauth_authorizations_started_by_idx" ON "integrations"."oauth_authorizations" USING btree ("organization_id","started_by_membership_id","created_at");--> statement-breakpoint
-- One consent attempt per connection it made.
CREATE UNIQUE INDEX "oauth_authorizations_one_per_connection" ON "integrations"."oauth_authorizations" USING btree ("organization_id","connection_id") WHERE "integrations"."oauth_authorizations"."connection_id" is not null;--> statement-breakpoint
CREATE INDEX "directory_groups_generation_idx" ON "integrations"."directory_groups" USING btree ("organization_id","connection_id","seen_generation");
