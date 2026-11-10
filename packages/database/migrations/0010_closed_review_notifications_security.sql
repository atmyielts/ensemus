-- REVIEWED SECURITY SQL (ADR-024 D4). Changes here need human review, never agent approval.

-- Migration 0004 closed every open approval but the newest on each Work Unit, without clearing what
-- had been sent about them. So someone can still hold an unread request for a review that can no longer
-- be decided, and reminders keep raising it. Nothing that closes an approval now leaves this behind.
-- (0005 says of the approval it marks as holding the work that it paused it. With two open, that was
-- only the newest of them, and that file cannot be corrected now that it has been applied.)

-- These run as the table owner, and forced RLS is lifted only for this transaction's duration, so
-- nothing else can reach the rows meanwhile. It grants nothing.
ALTER TABLE platform.notifications NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE work.approvals NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

UPDATE platform.notifications n SET read_at = now(), remind_at = NULL
FROM work.approvals a
WHERE n.read_at IS NULL
  AND n.organization_id = a.organization_id
  AND n.target_ref = 'approval:' || a.id::text
  AND a.status <> 'pending';
--> statement-breakpoint

ALTER TABLE platform.notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE work.approvals FORCE ROW LEVEL SECURITY;
