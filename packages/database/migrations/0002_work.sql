CREATE SCHEMA "work";
--> statement-breakpoint
CREATE TABLE "work"."approval_decisions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"actor_membership_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"action_hash" text NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_decisions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "approval_decisions_decision_check" CHECK ("work"."approval_decisions"."decision" in ('approve','deny'))
);
--> statement-breakpoint
CREATE TABLE "work"."approvals" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"work_unit_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"action" jsonb NOT NULL,
	"action_hash" text NOT NULL,
	"target_ref" text,
	"approver_membership_id" uuid NOT NULL,
	"requested_by_membership_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "approvals_status_check" CHECK ("work"."approvals"."status" in ('pending','approved','denied','expired','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "work"."artifacts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"classification" text DEFAULT 'internal' NOT NULL,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "artifacts_classification_check" CHECK ("work"."artifacts"."classification" in ('public','internal','confidential','restricted'))
);
--> statement-breakpoint
CREATE TABLE "work"."clients" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"classification" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "clients_classification_check" CHECK ("work"."clients"."classification" in ('public','internal','confidential','restricted'))
);
--> statement-breakpoint
CREATE TABLE "platform"."idempotency_keys" (
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_organization_id_membership_id_key_pk" PRIMARY KEY("organization_id","membership_id","key"),
	CONSTRAINT "idempotency_keys_unique" UNIQUE("organization_id","membership_id","key")
);
--> statement-breakpoint
CREATE TABLE "org"."invitations" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_membership_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "invitations_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_role_check" CHECK ("org"."invitations"."role" in ('admin','member'))
);
--> statement-breakpoint
CREATE TABLE "platform"."notifications" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"recipient_membership_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_ref" text NOT NULL,
	"remind_at" timestamp with time zone,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "work"."projects" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "org"."team_memberships" (
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	CONSTRAINT "team_memberships_organization_id_team_id_membership_id_pk" PRIMARY KEY("organization_id","team_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "org"."teams" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "teams_not_own_parent" CHECK ("org"."teams"."parent_id" is distinct from "org"."teams"."id")
);
--> statement-breakpoint
CREATE TABLE "platform"."tombstones" (
	"organization_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tombstones_organization_id_target_type_target_id_pk" PRIMARY KEY("organization_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "work"."work_artifacts" (
	"organization_id" uuid NOT NULL,
	"work_unit_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	CONSTRAINT "work_artifacts_organization_id_work_unit_id_artifact_id_pk" PRIMARY KEY("organization_id","work_unit_id","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "work"."work_assignments" (
	"organization_id" uuid NOT NULL,
	"work_unit_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"responsibility" text DEFAULT 'contributor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_assignments_organization_id_work_unit_id_membership_id_pk" PRIMARY KEY("organization_id","work_unit_id","membership_id"),
	CONSTRAINT "work_assignments_kind_check" CHECK ("work"."work_assignments"."responsibility" in ('contributor','reviewer'))
);
--> statement-breakpoint
CREATE TABLE "work"."work_dependencies" (
	"organization_id" uuid NOT NULL,
	"prerequisite_id" uuid NOT NULL,
	"dependent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_dependencies_organization_id_prerequisite_id_dependent_id_pk" PRIMARY KEY("organization_id","prerequisite_id","dependent_id"),
	CONSTRAINT "work_dependencies_no_self_edge" CHECK ("work"."work_dependencies"."prerequisite_id" <> "work"."work_dependencies"."dependent_id")
);
--> statement-breakpoint
CREATE TABLE "work"."work_units" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"parent_id" uuid,
	"owner_membership_id" uuid NOT NULL,
	"created_by_membership_id" uuid,
	"title" text NOT NULL,
	"objective" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"completion_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"execution_plan" text,
	"classification" text DEFAULT 'internal' NOT NULL,
	"due_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_units_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "work_units_status_check" CHECK ("work"."work_units"."status" in ('queued','ready','running','blocked','awaiting_approval','verifying','completed','failed','cancelled')),
	CONSTRAINT "work_units_version_check" CHECK ("work"."work_units"."version" > 0),
	CONSTRAINT "work_units_classification_check" CHECK ("work"."work_units"."classification" in ('public','internal','confidential','restricted'))
);
--> statement-breakpoint
ALTER TABLE "work"."approval_decisions" ADD CONSTRAINT "approval_decisions_organization_id_approval_id_approvals_organization_id_id_fk" FOREIGN KEY ("organization_id","approval_id") REFERENCES "work"."approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."approvals" ADD CONSTRAINT "approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."approvals" ADD CONSTRAINT "approvals_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."approvals" ADD CONSTRAINT "approvals_organization_id_approver_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","approver_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."artifacts" ADD CONSTRAINT "artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."clients" ADD CONSTRAINT "clients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."invitations" ADD CONSTRAINT "invitations_organization_id_invited_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","invited_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."notifications" ADD CONSTRAINT "notifications_organization_id_recipient_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","recipient_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."projects" ADD CONSTRAINT "projects_organization_id_client_id_clients_organization_id_id_fk" FOREIGN KEY ("organization_id","client_id") REFERENCES "work"."clients"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."team_memberships" ADD CONSTRAINT "team_memberships_organization_id_team_id_teams_organization_id_id_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "org"."teams"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."team_memberships" ADD CONSTRAINT "team_memberships_organization_id_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."teams" ADD CONSTRAINT "teams_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."teams" ADD CONSTRAINT "teams_organization_id_parent_id_teams_organization_id_id_fk" FOREIGN KEY ("organization_id","parent_id") REFERENCES "org"."teams"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."tombstones" ADD CONSTRAINT "tombstones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_artifacts" ADD CONSTRAINT "work_artifacts_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_artifacts" ADD CONSTRAINT "work_artifacts_organization_id_artifact_id_artifacts_organization_id_id_fk" FOREIGN KEY ("organization_id","artifact_id") REFERENCES "work"."artifacts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_assignments" ADD CONSTRAINT "work_assignments_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_assignments" ADD CONSTRAINT "work_assignments_organization_id_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_dependencies" ADD CONSTRAINT "work_dependencies_organization_id_prerequisite_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","prerequisite_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_dependencies" ADD CONSTRAINT "work_dependencies_organization_id_dependent_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","dependent_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_units" ADD CONSTRAINT "work_units_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_units" ADD CONSTRAINT "work_units_organization_id_project_id_projects_organization_id_id_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "work"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_units" ADD CONSTRAINT "work_units_organization_id_parent_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","parent_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_units" ADD CONSTRAINT "work_units_organization_id_owner_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_units" ADD CONSTRAINT "work_units_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_pending_idx" ON "work"."approvals" USING btree ("organization_id","approver_membership_id","status");--> statement-breakpoint
CREATE INDEX "notifications_inbox_idx" ON "platform"."notifications" USING btree ("organization_id","recipient_membership_id","read_at");--> statement-breakpoint
CREATE INDEX "work_assignments_member_idx" ON "work"."work_assignments" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE INDEX "work_dependencies_reverse_idx" ON "work"."work_dependencies" USING btree ("organization_id","dependent_id");--> statement-breakpoint
CREATE INDEX "work_units_status_idx" ON "work"."work_units" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE INDEX "work_units_page_idx" ON "work"."work_units" USING btree ("organization_id","created_at","id");