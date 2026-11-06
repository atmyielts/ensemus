-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- Last by number, so the eraser reaches tenant tables from every milestone's migrations, whichever order they
-- were written in. A later migration that adds a tenant table calls this again, and a test fails if none does.
SELECT lifecycle.extend_eraser_reach();
