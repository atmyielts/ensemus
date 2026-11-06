-- REVIEWED SECURITY SQL (ADR-024 D4). Changes here need human review, never agent approval.

-- The new tables get forced RLS and the tenant policy, like every other tenant table.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE (schemaname = 'work' AND tablename = 'work_transitions')
       OR (schemaname = 'platform' AND tablename = 'blob_lifecycle')
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
--> statement-breakpoint

-- A status change's history is a record, so nothing may rewrite it.
GRANT SELECT, INSERT ON work.work_transitions TO ensemus_app;
--> statement-breakpoint
CREATE TRIGGER work_transitions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON work.work_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- Bytes waiting to be removed. A row disappears only when its upload safely became an artifact.
GRANT SELECT, INSERT, DELETE ON platform.blob_lifecycle TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, attempts, purge_after, purged_at) ON platform.blob_lifecycle TO ensemus_app;
--> statement-breakpoint

GRANT UPDATE (run_requested_at, run_requested_by_membership_id, plan_reviewer_membership_id, run_id)
  ON work.work_units TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (claimed_by_user_id, claimed_at) ON org.invitations TO ensemus_app;
--> statement-breakpoint

-- Existing rows follow the new rules. These run as the table owner, and forced RLS is lifted only
-- for this transaction's duration, so nothing else can reach the rows meanwhile.
ALTER TABLE work.work_units NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE work.work_assignments NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE work.approvals NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Being a work's creator no longer grants access by itself. Whoever had that hidden access now has
-- it as an assignment, which the page lists and the owner can remove.
INSERT INTO work.work_assignments (organization_id, work_unit_id, membership_id, responsibility)
SELECT organization_id, id, created_by_membership_id, 'contributor'
FROM work.work_units
WHERE created_by_membership_id IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Work paused today was paused by its one remaining open approval.
UPDATE work.approvals a SET holds_work = true
FROM work.work_units w
WHERE a.status = 'pending'
  AND w.organization_id = a.organization_id
  AND w.id = a.work_unit_id
  AND w.status = 'awaiting_approval';
--> statement-breakpoint

ALTER TABLE work.work_units FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE work.work_assignments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE work.approvals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- GRANT UPDATE on holds_work is deliberately absent: which approval holds the pause is set once, when
-- the approval is created, and no application code can move it.

-- An operator can put dead events back in the queue. The dispatcher's existing column grants cover
-- this, so no new privilege is needed. It also reads which tenants exist from event metadata alone.
