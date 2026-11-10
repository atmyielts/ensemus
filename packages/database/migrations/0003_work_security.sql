-- REVIEWED SECURITY SQL (ADR-024 D4). Changes here need human review, never agent approval.

-- Forced RLS and a tenant policy on every new table. A test fails if a future table misses it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE (schemaname = 'work')
       OR (schemaname = 'org' AND tablename IN ('teams','team_memberships','invitations'))
       OR (schemaname = 'platform' AND tablename IN ('notifications','tombstones','idempotency_keys'))
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    EXECUTE format(
      'CREATE POLICY tenant_scoped ON %I.%I TO ensemus_app '
      'USING (organization_id = app.current_organization_id()) '
      'WITH CHECK (organization_id = app.current_organization_id())',
      t.schemaname, t.tablename);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA work TO ensemus_app;

-- People
GRANT SELECT, INSERT, DELETE ON org.teams, org.team_memberships TO ensemus_app;
GRANT UPDATE (name, parent_id) ON org.teams TO ensemus_app;
GRANT SELECT, INSERT ON org.invitations TO ensemus_app;
GRANT UPDATE (accepted_at, revoked_at) ON org.invitations TO ensemus_app;

-- A person holding an invitation link is not a member yet, so this finds exactly the one invitation
-- matching the hash of their token, and nothing else.
CREATE FUNCTION app.current_invitation_hash() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.invitation_token_hash', true), '') $$;
CREATE POLICY invitations_by_token ON org.invitations FOR SELECT TO ensemus_app
  USING (token_hash = app.current_invitation_hash());

-- Relationships and work
GRANT SELECT, INSERT, DELETE ON work.clients, work.projects TO ensemus_app;
GRANT UPDATE (display_name, classification) ON work.clients TO ensemus_app;
GRANT UPDATE (name, client_id) ON work.projects TO ensemus_app;

GRANT SELECT, INSERT ON work.work_units TO ensemus_app;
GRANT UPDATE (project_id, owner_membership_id, title, objective, status, completion_criteria,
              execution_plan, classification, due_at, version, updated_at)
  ON work.work_units TO ensemus_app;

GRANT SELECT, INSERT, DELETE ON work.work_dependencies, work.work_assignments TO ensemus_app;
GRANT SELECT, INSERT, DELETE ON work.artifacts, work.work_artifacts TO ensemus_app;

-- An approval's action can never be edited, by any application code. Only its status can move.
GRANT SELECT, INSERT ON work.approvals TO ensemus_app;
GRANT UPDATE (status, decided_at) ON work.approvals TO ensemus_app;
GRANT SELECT, INSERT ON work.approval_decisions TO ensemus_app;

-- Platform
GRANT SELECT, INSERT ON platform.notifications TO ensemus_app;
GRANT UPDATE (read_at, remind_at, reminders_sent) ON platform.notifications TO ensemus_app;
GRANT SELECT, INSERT ON platform.tombstones, platform.idempotency_keys TO ensemus_app;

-- Append-only records, enforced for everyone including the owner.
CREATE FUNCTION app.reject_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER approval_decisions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON work.approval_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER tombstones_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.tombstones
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();

-- The work graph stays acyclic under concurrency. An advisory lock serializes edge inserts per
-- tenant, so two inserts that would together close a cycle cannot both pass (QA-005).
CREATE FUNCTION work.prevent_dependency_cycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE has_cycle boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('work_dependencies:' || NEW.organization_id::text, 0));
  WITH RECURSIVE reachable(node_id, visited) AS (
    SELECT NEW.dependent_id, ARRAY[NEW.dependent_id]
    UNION ALL
    SELECT d.dependent_id, r.visited || d.dependent_id
    FROM reachable r
    JOIN work.work_dependencies d
      ON d.organization_id = NEW.organization_id AND d.prerequisite_id = r.node_id
    WHERE NOT d.dependent_id = ANY(r.visited)
  )
  SELECT EXISTS (SELECT 1 FROM reachable WHERE node_id = NEW.prerequisite_id) INTO has_cycle;
  IF has_cycle THEN
    RAISE EXCEPTION 'INVALID_DEPENDENCY_CYCLE' USING ERRCODE = 'EN001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_work_dependency_cycle
  BEFORE INSERT ON work.work_dependencies
  FOR EACH ROW EXECUTE FUNCTION work.prevent_dependency_cycle();

-- Team hierarchy gets the same protection.
CREATE FUNCTION org.prevent_team_cycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE has_cycle boolean;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('teams:' || NEW.organization_id::text, 0));
  WITH RECURSIVE ancestors(id, parent_id, visited) AS (
    SELECT t.id, t.parent_id, ARRAY[t.id]
    FROM org.teams t
    WHERE t.organization_id = NEW.organization_id AND t.id = NEW.parent_id
    UNION ALL
    SELECT t.id, t.parent_id, a.visited || t.id
    FROM ancestors a
    JOIN org.teams t ON t.organization_id = NEW.organization_id AND t.id = a.parent_id
    WHERE NOT t.id = ANY(a.visited)
  )
  SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id) INTO has_cycle;
  IF has_cycle THEN
    RAISE EXCEPTION 'INVALID_TEAM_CYCLE' USING ERRCODE = 'EN002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_team_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON org.teams
  FOR EACH ROW EXECUTE FUNCTION org.prevent_team_cycle();
