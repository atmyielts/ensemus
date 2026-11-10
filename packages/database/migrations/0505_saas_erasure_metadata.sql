-- Human review required. This grants only the tenant column needed to count sealed rows.
-- The broker remains the only runtime role that can read sealed secret IDs or cryptographic material.
-- The branded service path sets app.actor_type locally only after its TenantContext is checked.
GRANT SELECT (organization_id) ON secrets.sealed_secrets TO ensemus_app;
--> statement-breakpoint
CREATE POLICY sealed_erasure_metadata ON secrets.sealed_secrets FOR SELECT TO ensemus_app
  USING (organization_id=app.current_organization_id()
         AND app.current_user_id() IS NULL
         AND current_setting('app.actor_type',true)='service');
--> statement-breakpoint
-- No membership, standing or organization-existence predicate: absence must never masquerade as zero
-- after offboarding has deleted memberships or changed the tenant's standing.
ALTER TABLE lifecycle.offboardings ADD COLUMN transition_set_by_ref text;
--> statement-breakpoint
ALTER TABLE lifecycle.offboardings ADD COLUMN erasure_started_by_ref text;
--> statement-breakpoint
ALTER TABLE lifecycle.offboardings ADD COLUMN erasure_verified_by_ref text;
--> statement-breakpoint
GRANT UPDATE (transition_set_by_ref,erasure_started_by_ref,erasure_verified_by_ref)
  ON lifecycle.offboardings TO ensemus_app;
