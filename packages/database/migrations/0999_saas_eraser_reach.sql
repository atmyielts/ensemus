-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- Last by number, so the eraser reaches tenant tables from every milestone's migrations, whichever order they
-- were written in. A later migration that adds a tenant table calls this again, and a test fails if none does.
SELECT lifecycle.extend_eraser_reach();
--> statement-breakpoint
-- LAST after every contributing schema and0508: a fixed counts-only private metadata projection.
SELECT lifecycle.install_erasure_count_projection();
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION knowledge.certify_artifact_erasure(uuid,boolean) TO ensemus_eraser;
--> statement-breakpoint
-- AFTER every contributing schema and eraser grant. Restrictive restore admission adds no body
-- grant; missing/unregistered 0422 or uncovered actual role reach must refuse this composition.
SELECT identity.extend_auth_restore_admission();
