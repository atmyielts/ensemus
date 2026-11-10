CREATE TABLE "platform"."blob_lifecycle" (
	"organization_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"state" text NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_lifecycle_organization_id_artifact_id_pk" PRIMARY KEY("organization_id","artifact_id"),
	CONSTRAINT "blob_lifecycle_state_check" CHECK ("platform"."blob_lifecycle"."state" in ('uploading','deleting','purged'))
);
--> statement-breakpoint
CREATE TABLE "work"."work_transitions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"work_unit_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"actor_membership_id" uuid,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_transitions_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "work"."approvals" ADD COLUMN "holds_work" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "work"."approvals" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "org"."invitations" ADD COLUMN "claimed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "org"."invitations" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work"."work_units" ADD COLUMN "run_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work"."work_units" ADD COLUMN "run_requested_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "work"."work_units" ADD COLUMN "plan_reviewer_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "work"."work_units" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "platform"."blob_lifecycle" ADD CONSTRAINT "blob_lifecycle_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_transitions" ADD CONSTRAINT "work_transitions_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_transitions" ADD CONSTRAINT "work_transitions_organization_id_actor_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","actor_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_lifecycle_due_idx" ON "platform"."blob_lifecycle" USING btree ("organization_id","state","purge_after");--> statement-breakpoint
CREATE INDEX "work_transitions_work_idx" ON "work"."work_transitions" USING btree ("organization_id","work_unit_id","occurred_at");--> statement-breakpoint
ALTER TABLE "work"."work_units" ADD CONSTRAINT "work_units_organization_id_run_requested_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","run_requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."work_units" ADD CONSTRAINT "work_units_organization_id_plan_reviewer_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","plan_reviewer_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Before the one-open-review rule exists, a Work Unit may hold several open approvals. Keep the
-- newest and close the rest, because the index below would otherwise refuse to build.
ALTER TABLE "work"."approvals" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "work"."approvals" a SET "status" = 'cancelled', "decided_at" = now()
WHERE a."status" = 'pending' AND EXISTS (
  SELECT 1 FROM "work"."approvals" newer
  WHERE newer."organization_id" = a."organization_id"
    AND newer."work_unit_id" = a."work_unit_id"
    AND newer."status" = 'pending'
    AND (newer."created_at", newer."id") > (a."created_at", a."id")
);--> statement-breakpoint
ALTER TABLE "work"."approvals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_open_per_work" ON "work"."approvals" USING btree ("organization_id","work_unit_id") WHERE "work"."approvals"."status" = 'pending';