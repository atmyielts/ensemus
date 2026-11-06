DROP INDEX "integrations"."external_resources_generation_idx";--> statement-breakpoint
ALTER TABLE "integrations"."external_resources" ADD COLUMN "stream" text NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations"."sync_cursors" ADD COLUMN "full_sync_in_progress" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "external_resources_generation_idx" ON "integrations"."external_resources" USING btree ("organization_id","connection_id","stream","seen_generation");--> statement-breakpoint
ALTER TABLE "integrations"."external_resources" ADD CONSTRAINT "external_resources_stream_format" CHECK ("integrations"."external_resources"."stream" ~ '^[a-z0-9_.-]{1,64}$');--> statement-breakpoint
-- Which stream found a resource, and whether a full sync is under way, each said by its own column. Before
-- this a resource's type had to be its stream's name, and `resync_required` also meant "running". The
-- NOT NULL has no default because no release has written this table, and a row with no stream could never
-- be found gone. A resource's stream is fixed once written, so only the cursor's new column can be updated.
GRANT UPDATE (full_sync_in_progress) ON integrations.sync_cursors TO ensemus_app;
