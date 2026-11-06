CREATE SCHEMA "integrations";
--> statement-breakpoint
CREATE TABLE "integrations"."connections" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"connector_type" text NOT NULL,
	"display_name" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"credential_secret_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "connections_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "connections_state_check" CHECK ("integrations"."connections"."state" in ('active','disabled','revoked')),
	CONSTRAINT "connections_type_format" CHECK ("integrations"."connections"."connector_type" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "connections_version_check" CHECK ("integrations"."connections"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "integrations"."external_action_attempts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"external_action_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"request_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"run_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"outcome_code" text,
	"provider_status" integer,
	"external_id" text,
	"finished_at" timestamp with time zone,
	CONSTRAINT "external_action_attempts_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "external_action_attempts_number" UNIQUE("organization_id","external_action_id","attempt_no"),
	CONSTRAINT "external_action_attempts_outcome" CHECK ("integrations"."external_action_attempts"."outcome" in ('accepted','rejected','not_sent','indeterminate')),
	CONSTRAINT "external_action_attempts_no_range" CHECK ("integrations"."external_action_attempts"."attempt_no" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "integrations"."external_action_receipts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"external_action_id" uuid NOT NULL,
	"attempt_id" uuid,
	"outcome" text NOT NULL,
	"basis" text NOT NULL,
	"code" text,
	"provider_status" integer,
	"external_id" text,
	"request_hash" text NOT NULL,
	"actor_membership_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_action_receipts_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "external_action_receipts_outcome" CHECK ("integrations"."external_action_receipts"."outcome" in ('sent','failed','unknown','cancelled')),
	CONSTRAINT "external_action_receipts_basis" CHECK ("integrations"."external_action_receipts"."basis" in ('provider','reconciliation','person','system')),
	CONSTRAINT "external_action_receipts_person_named" CHECK ("integrations"."external_action_receipts"."basis" <> 'person' or "integrations"."external_action_receipts"."actor_membership_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "integrations"."external_actions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"work_unit_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"tool_version" text NOT NULL,
	"target_ref" text NOT NULL,
	"payload" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"classification" text NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"approval_id" uuid,
	"supersedes_id" uuid,
	"retry_of_id" uuid,
	"status" text NOT NULL,
	"status_reason" text,
	"external_id" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"resolved_by_membership_id" uuid,
	"resolution" text,
	"resolution_reason" text,
	CONSTRAINT "external_actions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "external_actions_idempotency_key" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "external_actions_status_check" CHECK ("integrations"."external_actions"."status" in ('awaiting_approval','ready','sending','reconciling','sent','failed','unknown','cancelled')),
	CONSTRAINT "external_actions_classification" CHECK ("integrations"."external_actions"."classification" in ('public','internal','confidential')),
	CONSTRAINT "external_actions_approval_required" CHECK (not "integrations"."external_actions"."requires_approval" or "integrations"."external_actions"."approval_id" is not null),
	CONSTRAINT "external_actions_resolution_check" CHECK ("integrations"."external_actions"."resolution" in ('confirmed_sent','confirmed_not_sent')),
	CONSTRAINT "external_actions_resolution_whole" CHECK (("integrations"."external_actions"."resolution" is null) = ("integrations"."external_actions"."resolved_by_membership_id" is null) and ("integrations"."external_actions"."resolution" is null) = ("integrations"."external_actions"."resolution_reason" is null)),
	CONSTRAINT "external_actions_version_check" CHECK ("integrations"."external_actions"."version" > 0),
	CONSTRAINT "external_actions_payload_size" CHECK (octet_length("integrations"."external_actions"."payload"::text) <= 262144)
);
--> statement-breakpoint
CREATE TABLE "integrations"."external_resource_acl" (
	"organization_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_external_id" text NOT NULL,
	"access" text NOT NULL,
	"membership_id" uuid,
	"team_id" uuid,
	"synced_generation" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_resource_acl_organization_id_resource_id_principal_kind_principal_external_id_access_pk" PRIMARY KEY("organization_id","resource_id","principal_kind","principal_external_id","access"),
	CONSTRAINT "external_resource_acl_kind" CHECK ("integrations"."external_resource_acl"."principal_kind" in ('user','group','domain','anyone')),
	CONSTRAINT "external_resource_acl_access" CHECK ("integrations"."external_resource_acl"."access" in ('read','write','owner')),
	CONSTRAINT "external_resource_acl_one_target" CHECK (num_nonnulls("integrations"."external_resource_acl"."membership_id", "integrations"."external_resource_acl"."team_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "integrations"."external_resources" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"external_id" text NOT NULL,
	"external_version" text,
	"display_name" text,
	"content_sha256" text,
	"classification" text DEFAULT 'internal' NOT NULL,
	"acl_state" text DEFAULT 'unmapped' NOT NULL,
	"seen_generation" bigint DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_resources_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "external_resources_source_key" UNIQUE("organization_id","connection_id","external_id"),
	CONSTRAINT "external_resources_acl_state" CHECK ("integrations"."external_resources"."acl_state" in ('mapped','partial','unmapped')),
	CONSTRAINT "external_resources_classification" CHECK ("integrations"."external_resources"."classification" in ('public','internal','confidential','restricted'))
);
--> statement-breakpoint
CREATE TABLE "integrations"."sync_cursors" (
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"cursor" text,
	"watermark" timestamp with time zone,
	"generation" bigint DEFAULT 0 NOT NULL,
	"full_sync_generation" bigint DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"lease_until" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_cursors_organization_id_connection_id_stream_pk" PRIMARY KEY("organization_id","connection_id","stream"),
	CONSTRAINT "sync_cursors_state_check" CHECK ("integrations"."sync_cursors"."state" in ('idle','running','failed','resync_required')),
	CONSTRAINT "sync_cursors_stream_format" CHECK ("integrations"."sync_cursors"."stream" ~ '^[a-z0-9_.-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "integrations"."webhook_deliveries" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"body" "bytea",
	"body_sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"headers" jsonb,
	"state" text DEFAULT 'received' NOT NULL,
	"reject_code" text,
	"provider_event_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "webhook_deliveries_request" UNIQUE("organization_id","endpoint_id","request_digest"),
	CONSTRAINT "webhook_deliveries_state_check" CHECK ("integrations"."webhook_deliveries"."state" in ('received','applied','duplicate','rejected','failed')),
	CONSTRAINT "webhook_deliveries_size_check" CHECK ("integrations"."webhook_deliveries"."size_bytes" between 0 and 1048576),
	CONSTRAINT "webhook_deliveries_body_bound" CHECK ("integrations"."webhook_deliveries"."body" is null or octet_length("integrations"."webhook_deliveries"."body") <= 1048576),
	CONSTRAINT "webhook_deliveries_headers_bound" CHECK ("integrations"."webhook_deliveries"."headers" is null or octet_length("integrations"."webhook_deliveries"."headers"::text) <= 8192)
);
--> statement-breakpoint
CREATE TABLE "integrations"."webhook_endpoints" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"signing_secret_id" uuid NOT NULL,
	"previous_signing_secret_id" uuid,
	"previous_secret_valid_until" timestamp with time zone,
	"signature_scheme" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"max_body_bytes" integer DEFAULT 262144 NOT NULL,
	"rate_per_minute" integer DEFAULT 120 NOT NULL,
	"max_bytes_per_minute" bigint DEFAULT 16777216 NOT NULL,
	"max_pending_bytes" bigint DEFAULT 268435456 NOT NULL,
	"timestamp_tolerance_seconds" integer DEFAULT 300 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"window_deliveries" integer DEFAULT 0 NOT NULL,
	"window_bytes" bigint DEFAULT 0 NOT NULL,
	"pending_bytes" bigint DEFAULT 0 NOT NULL,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "webhook_endpoints_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "webhook_endpoints_state_check" CHECK ("integrations"."webhook_endpoints"."state" in ('active','disabled','revoked')),
	CONSTRAINT "webhook_endpoints_body_limit" CHECK ("integrations"."webhook_endpoints"."max_body_bytes" between 1024 and 1048576),
	CONSTRAINT "webhook_endpoints_rate_limit" CHECK ("integrations"."webhook_endpoints"."rate_per_minute" between 1 and 600),
	CONSTRAINT "webhook_endpoints_byte_rate" CHECK ("integrations"."webhook_endpoints"."max_bytes_per_minute" between 1024 and 67108864),
	CONSTRAINT "webhook_endpoints_pending" CHECK ("integrations"."webhook_endpoints"."max_pending_bytes" between 1024 and 1073741824),
	CONSTRAINT "webhook_endpoints_window" CHECK ("integrations"."webhook_endpoints"."timestamp_tolerance_seconds" between 30 and 900),
	CONSTRAINT "webhook_endpoints_pending_positive" CHECK ("integrations"."webhook_endpoints"."pending_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "integrations"."connections" ADD CONSTRAINT "connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."connections" ADD CONSTRAINT "connections_organization_id_credential_secret_id_sealed_secrets_organization_id_id_fk" FOREIGN KEY ("organization_id","credential_secret_id") REFERENCES "secrets"."sealed_secrets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."connections" ADD CONSTRAINT "connections_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_action_attempts" ADD CONSTRAINT "external_action_attempts_organization_id_external_action_id_external_actions_organization_id_id_fk" FOREIGN KEY ("organization_id","external_action_id") REFERENCES "integrations"."external_actions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_action_receipts" ADD CONSTRAINT "external_action_receipts_organization_id_external_action_id_external_actions_organization_id_id_fk" FOREIGN KEY ("organization_id","external_action_id") REFERENCES "integrations"."external_actions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_action_receipts" ADD CONSTRAINT "external_action_receipts_organization_id_attempt_id_external_action_attempts_organization_id_id_fk" FOREIGN KEY ("organization_id","attempt_id") REFERENCES "integrations"."external_action_attempts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_action_receipts" ADD CONSTRAINT "external_action_receipts_organization_id_actor_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","actor_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_actions" ADD CONSTRAINT "external_actions_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_actions" ADD CONSTRAINT "external_actions_organization_id_connection_id_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "integrations"."connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_actions" ADD CONSTRAINT "external_actions_organization_id_approval_id_approvals_organization_id_id_fk" FOREIGN KEY ("organization_id","approval_id") REFERENCES "work"."approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_actions" ADD CONSTRAINT "external_actions_organization_id_supersedes_id_external_actions_organization_id_id_fk" FOREIGN KEY ("organization_id","supersedes_id") REFERENCES "integrations"."external_actions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_actions" ADD CONSTRAINT "external_actions_organization_id_retry_of_id_external_actions_organization_id_id_fk" FOREIGN KEY ("organization_id","retry_of_id") REFERENCES "integrations"."external_actions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_actions" ADD CONSTRAINT "external_actions_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_actions" ADD CONSTRAINT "external_actions_organization_id_resolved_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","resolved_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_resource_acl" ADD CONSTRAINT "external_resource_acl_organization_id_resource_id_external_resources_organization_id_id_fk" FOREIGN KEY ("organization_id","resource_id") REFERENCES "integrations"."external_resources"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_resource_acl" ADD CONSTRAINT "external_resource_acl_organization_id_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_resource_acl" ADD CONSTRAINT "external_resource_acl_organization_id_team_id_teams_organization_id_id_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "org"."teams"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_resources" ADD CONSTRAINT "external_resources_organization_id_connection_id_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "integrations"."connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."sync_cursors" ADD CONSTRAINT "sync_cursors_organization_id_connection_id_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "integrations"."connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_endpoint_id_webhook_endpoints_organization_id_id_fk" FOREIGN KEY ("organization_id","endpoint_id") REFERENCES "integrations"."webhook_endpoints"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_connection_id_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "integrations"."connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_signing_secret_id_sealed_secrets_organization_id_id_fk" FOREIGN KEY ("organization_id","signing_secret_id") REFERENCES "secrets"."sealed_secrets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_previous_signing_secret_id_sealed_secrets_organization_id_id_fk" FOREIGN KEY ("organization_id","previous_signing_secret_id") REFERENCES "secrets"."sealed_secrets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_type_idx" ON "integrations"."connections" USING btree ("organization_id","connector_type","state");--> statement-breakpoint
CREATE INDEX "external_action_receipts_action_idx" ON "integrations"."external_action_receipts" USING btree ("organization_id","external_action_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_action_receipts_once_per_attempt" ON "integrations"."external_action_receipts" USING btree ("organization_id","attempt_id","outcome") WHERE "integrations"."external_action_receipts"."attempt_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "external_actions_one_per_approval" ON "integrations"."external_actions" USING btree ("organization_id","approval_id") WHERE "integrations"."external_actions"."approval_id" is not null;--> statement-breakpoint
CREATE INDEX "external_actions_work_idx" ON "integrations"."external_actions" USING btree ("organization_id","work_unit_id","created_at");--> statement-breakpoint
CREATE INDEX "external_actions_status_idx" ON "integrations"."external_actions" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "external_resource_acl_member_idx" ON "integrations"."external_resource_acl" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE INDEX "external_resources_generation_idx" ON "integrations"."external_resources" USING btree ("organization_id","connection_id","seen_generation");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_state_idx" ON "integrations"."webhook_deliveries" USING btree ("organization_id","state","received_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_connection_idx" ON "integrations"."webhook_endpoints" USING btree ("organization_id","connection_id");