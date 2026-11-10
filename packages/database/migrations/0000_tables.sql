CREATE SCHEMA "governance";
--> statement-breakpoint
CREATE SCHEMA "identity";
--> statement-breakpoint
CREATE SCHEMA "org";
--> statement-breakpoint
CREATE SCHEMA "platform";
--> statement-breakpoint
CREATE SCHEMA "secrets";
--> statement-breakpoint
CREATE TABLE "identity"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_account_key" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "governance"."audit_events" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_ref" text NOT NULL,
	"decision" text NOT NULL,
	"safe_reason" text,
	"correlation_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "platform"."domain_events" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" bigint NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"classification" text NOT NULL,
	"payload" jsonb NOT NULL,
	"correlation_id" uuid,
	"causation_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_events_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "domain_events_version_check" CHECK ("platform"."domain_events"."schema_version" > 0),
	CONSTRAINT "domain_events_classification_check" CHECK ("platform"."domain_events"."classification" in ('public','internal','confidential','restricted'))
);
--> statement-breakpoint
CREATE TABLE "platform"."inbox_events" (
	"organization_id" uuid NOT NULL,
	"consumer_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_events_organization_id_consumer_id_event_id_pk" PRIMARY KEY("organization_id","consumer_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "org"."memberships" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "memberships_org_user_key" UNIQUE("organization_id","user_id"),
	CONSTRAINT "memberships_status_check" CHECK ("org"."memberships"."status" in ('invited','active','disabled')),
	CONSTRAINT "memberships_role_check" CHECK ("org"."memberships"."role" in ('owner','admin','member'))
);
--> statement-breakpoint
CREATE TABLE "org"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"commercial_mode" text NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_mode_check" CHECK ("org"."organizations"."commercial_mode" in ('cloud','byom','sovereign')),
	CONSTRAINT "organizations_lifecycle_check" CHECK ("org"."organizations"."lifecycle" in ('active','suspended','deleted'))
);
--> statement-breakpoint
CREATE TABLE "platform"."outbox_events" (
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_organization_id_event_id_pk" PRIMARY KEY("organization_id","event_id"),
	CONSTRAINT "outbox_events_state_check" CHECK ("platform"."outbox_events"."state" in ('queued','published','dead'))
);
--> statement-breakpoint
CREATE TABLE "identity"."rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "secrets"."sealed_secrets" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"key_id" text NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sealed_secrets_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "identity"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "identity"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "identity"."verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance"."audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."domain_events" ADD CONSTRAINT "domain_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."inbox_events" ADD CONSTRAINT "inbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."outbox_events" ADD CONSTRAINT "outbox_events_organization_id_event_id_domain_events_organization_id_id_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "platform"."domain_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets"."sealed_secrets" ADD CONSTRAINT "sealed_secrets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "identity"."accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_events_time_idx" ON "governance"."audit_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "domain_events_aggregate_idx" ON "platform"."domain_events" USING btree ("organization_id","aggregate_type","aggregate_id","aggregate_version");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "org"."memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outbox_events_due_idx" ON "platform"."outbox_events" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "identity"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "identity"."verifications" USING btree ("identifier");