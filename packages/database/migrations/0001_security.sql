-- REVIEWED SECURITY SQL (ADR-024 D4). Changes here need human review, never agent approval.
-- Default deny: a role reaches only what is granted below, and RLS still filters those rows.

CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO ensemus_app, ensemus_auth, ensemus_dispatcher, ensemus_secrets;

CREATE FUNCTION app.current_organization_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Every table in these schemas gets forced RLS. A test fails if a future table misses it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname IN ('identity','org','platform','governance','secrets')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.schemaname, t.tablename);
  END LOOP;
END $$;

-- identity: the auth role only. Password hashes and sessions never reach the application role.
GRANT USAGE ON SCHEMA identity TO ensemus_auth, ensemus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO ensemus_auth;
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'identity' LOOP
    EXECUTE format(
      'CREATE POLICY auth_all ON identity.%I TO ensemus_auth USING (true) WITH CHECK (true)',
      t.tablename);
  END LOOP;
END $$;

GRANT SELECT (id, name, email) ON identity.users TO ensemus_app;
CREATE POLICY users_self ON identity.users FOR SELECT TO ensemus_app
  USING (id = app.current_user_id());

-- org: a user sees their own memberships ONLY before a tenant is bound. Once bound, they see that
-- tenant alone, so a two-organization member cannot see the other membership from inside the first.
GRANT USAGE ON SCHEMA org TO ensemus_app;
GRANT SELECT, INSERT, DELETE ON org.memberships TO ensemus_app;
GRANT UPDATE (role, status) ON org.memberships TO ensemus_app;
GRANT SELECT, INSERT ON org.organizations TO ensemus_app;
GRANT UPDATE (name, lifecycle) ON org.organizations TO ensemus_app;

CREATE POLICY memberships_tenant ON org.memberships TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY memberships_self ON org.memberships FOR SELECT TO ensemus_app
  USING (app.current_organization_id() IS NULL AND user_id = app.current_user_id());

CREATE POLICY organizations_tenant ON org.organizations TO ensemus_app
  USING (id = app.current_organization_id())
  WITH CHECK (id = app.current_organization_id());
CREATE POLICY organizations_member ON org.organizations FOR SELECT TO ensemus_app
  USING (
    app.current_organization_id() IS NULL
    AND id IN (SELECT organization_id FROM org.memberships WHERE user_id = app.current_user_id())
  );

CREATE POLICY users_same_tenant ON identity.users FOR SELECT TO ensemus_app
  USING (EXISTS (
    SELECT 1 FROM org.memberships m
    WHERE m.user_id = users.id AND m.organization_id = app.current_organization_id()
  ));

-- platform: tenant-bound writes for the application; the dispatcher alone crosses tenants, and only
-- sees outbox state and event metadata, never payloads or actors.
GRANT USAGE ON SCHEMA platform TO ensemus_app, ensemus_dispatcher;
GRANT SELECT, INSERT ON platform.domain_events, platform.outbox_events, platform.inbox_events TO ensemus_app;

CREATE POLICY events_tenant ON platform.domain_events TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY outbox_tenant ON platform.outbox_events TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY inbox_tenant ON platform.inbox_events TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT ON platform.outbox_events TO ensemus_dispatcher;
GRANT UPDATE (state, attempts, next_attempt_at) ON platform.outbox_events TO ensemus_dispatcher;
GRANT SELECT (organization_id, id, event_type, schema_version, aggregate_type, aggregate_id,
              aggregate_version, classification, correlation_id, causation_id, occurred_at)
  ON platform.domain_events TO ensemus_dispatcher;
CREATE POLICY outbox_dispatch ON platform.outbox_events TO ensemus_dispatcher
  USING (true) WITH CHECK (true);
CREATE POLICY events_dispatch ON platform.domain_events FOR SELECT TO ensemus_dispatcher
  USING (true);

-- governance: append-only, enforced for everyone including the table owner.
GRANT USAGE ON SCHEMA governance TO ensemus_app;
GRANT SELECT, INSERT ON governance.audit_events TO ensemus_app;
CREATE POLICY audit_tenant ON governance.audit_events TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

CREATE FUNCTION governance.reject_audit_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON governance.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION governance.reject_audit_change();

-- secrets: the application can only add sealed values. Only the broker role can read them, and only
-- for the bound tenant (ADR-024 D5).
GRANT USAGE ON SCHEMA secrets TO ensemus_app, ensemus_secrets;
GRANT INSERT ON secrets.sealed_secrets TO ensemus_app;
CREATE POLICY sealed_insert ON secrets.sealed_secrets FOR INSERT TO ensemus_app
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT ON secrets.sealed_secrets TO ensemus_secrets;
GRANT UPDATE (key_id, wrapped_key, revoked_at) ON secrets.sealed_secrets TO ensemus_secrets;
CREATE POLICY sealed_broker ON secrets.sealed_secrets TO ensemus_secrets
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
