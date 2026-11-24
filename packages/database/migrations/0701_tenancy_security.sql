-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-035 D5 and D6). Changes here need human review, never agent approval.

-- Forced RLS on every table in the new schema. A test fails if one misses it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'tenancy' LOOP
    EXECUTE format('ALTER TABLE tenancy.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE tenancy.%I FORCE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA tenancy TO ensemus_app;
--> statement-breakpoint

-- What this deployment is. No tenant can change it, because a tenant must never be able to move itself
-- to another tier or region, or turn cross-organization work on for everyone. The one-shot deploy job
-- writes it, as the migrator, and every tenant may read it, because it holds no tenant data.
GRANT SELECT ON tenancy.deployment_profile TO ensemus_app;
--> statement-breakpoint
CREATE POLICY deployment_profile_read ON tenancy.deployment_profile FOR SELECT TO ensemus_app
  USING (true);
--> statement-breakpoint
CREATE POLICY deployment_profile_write ON tenancy.deployment_profile TO ensemus_migrator
  USING (true) WITH CHECK (true);
--> statement-breakpoint

-- What was checked about this deployment's isolation, and how. The same two rules: the deploy job writes
-- it, and the application can only read it. An admin's page repeats this and adds nothing to it.
GRANT SELECT ON tenancy.isolation_evidence TO ensemus_app;
--> statement-breakpoint
CREATE POLICY isolation_evidence_read ON tenancy.isolation_evidence FOR SELECT TO ensemus_app
  USING (true);
--> statement-breakpoint
CREATE POLICY isolation_evidence_write ON tenancy.isolation_evidence TO ensemus_migrator
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER isolation_evidence_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON tenancy.isolation_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- What one tenant requires of where its data lives. Its own business, and nobody else's.
GRANT SELECT, INSERT, DELETE ON tenancy.residency_requirements TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (region, version, set_by_membership_id, updated_at)
  ON tenancy.residency_requirements TO ensemus_app;
--> statement-breakpoint
CREATE POLICY tenant_scoped ON tenancy.residency_requirements TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

-- A dedicated deployment holds one organization, whatever a request or a bug tries. The check reads only
-- the profile, because RLS would hide any other organization from a count. With no profile, or on a shared
-- deployment, this does nothing, so no existing path changes. See ADR-035 D5.
CREATE FUNCTION tenancy.check_new_organization() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE profile record;
BEGIN
  SELECT p.tier, p.pinned_organization_id INTO profile FROM tenancy.deployment_profile p;
  IF FOUND AND profile.tier = 'dedicated' AND NEW.id <> profile.pinned_organization_id THEN
    RAISE EXCEPTION 'TENANCY_SINGLE_ORGANIZATION' USING ERRCODE = 'EN701';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organizations_tenancy_check
  BEFORE INSERT ON org.organizations
  FOR EACH ROW EXECUTE FUNCTION tenancy.check_new_organization();
--> statement-breakpoint

-- A tenant can only require the region this deployment is in. A region here is one deployment, so asking
-- for another could only be met by moving, which is a process and not a row (ADR-035 D6). With no profile
-- or no home region this deployment makes no residency claim, and so refuses to record a requirement it
-- could not honour, instead of saving a promise nothing enforces.
CREATE FUNCTION tenancy.check_residency_requirement() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE home text;
BEGIN
  SELECT p.home_region INTO home FROM tenancy.deployment_profile p;
  IF home IS NULL OR NEW.region <> home THEN
    RAISE EXCEPTION 'RESIDENCY_REGION_NOT_OFFERED' USING ERRCODE = 'EN702';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.version <> 1 THEN
    RAISE EXCEPTION 'RESIDENCY_INVALID_VERSION' USING ERRCODE = 'EN703';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'RESIDENCY_INVALID_VERSION' USING ERRCODE = 'EN703';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM org.memberships m
     WHERE m.organization_id = NEW.organization_id
       AND m.id = NEW.set_by_membership_id
       AND m.status = 'active'
       AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'RESIDENCY_NOT_AN_OWNER' USING ERRCODE = 'EN704';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER residency_requirements_check
  BEFORE INSERT OR UPDATE ON tenancy.residency_requirements
  FOR EACH ROW EXECUTE FUNCTION tenancy.check_residency_requirement();
