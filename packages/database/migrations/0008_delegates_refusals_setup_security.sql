-- REVIEWED SECURITY SQL (ADR-024 D4). Changes here need human review, never agent approval.

-- One-time setup codes. The operator's command issues them with the migrator role, and the auth role
-- can only find one by its hash and mark it used. The application role has no access at all.
ALTER TABLE identity.setup_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.setup_tokens FORCE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE (used_at) ON identity.setup_tokens TO ensemus_auth;
CREATE POLICY setup_tokens_redeem ON identity.setup_tokens TO ensemus_auth
  USING (true) WITH CHECK (true);
CREATE POLICY setup_tokens_issue ON identity.setup_tokens FOR INSERT TO ensemus_migrator
  WITH CHECK (true);

-- A reminder records when it last brought a notification back up the inbox.
GRANT UPDATE (last_reminded_at) ON platform.notifications TO ensemus_app;
