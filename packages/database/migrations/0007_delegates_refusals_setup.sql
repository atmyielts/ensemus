CREATE TABLE "identity"."setup_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "governance"."audit_events" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "platform"."notifications" ADD COLUMN "last_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work"."work_assignments" ADD COLUMN "actor_type" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_dedupe_idx" ON "governance"."audit_events" USING btree ("organization_id","dedupe_key") WHERE "governance"."audit_events"."dedupe_key" is not null;--> statement-breakpoint
ALTER TABLE "work"."work_assignments" ADD CONSTRAINT "work_assignments_actor_type_check" CHECK ("work"."work_assignments"."actor_type" in ('human','agent'));