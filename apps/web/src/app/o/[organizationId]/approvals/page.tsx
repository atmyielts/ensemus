import { Card } from '@/components/ui/card';
import { listDirectory, listMyPendingApprovals } from '@ensemus/application';
import { ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import {
  ActionLink,
  Empty,
  ErrorNotice,
  formatDateTime,
  PageHead,
  StatusBadge,
} from '@/components/ui';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Approvals | Ensemus' };

const TOOL_WORDS: Record<string, string> = {
  'work.review': 'Review this work',
  'email.send': 'Send an email',
  'gmail.send': 'Send an email from Gmail',
  'gmail.create_draft': 'Save a draft in Gmail',
  'outlook.send': 'Send an email from Outlook',
  'outlook.create_draft': 'Save a draft in Outlook',
  'calendar.create_event': 'Create a calendar event',
  'calendar.update_event': 'Change a calendar event',
  'drive.create_file': 'Create a file in Google Drive',
  'onedrive.create_file': 'Create a file in OneDrive',
  'docs.edit': 'Edit a Google document',
  'sheets.write_range': 'Write cells in a Google sheet',
  'excel.write_range': 'Write cells in an Excel workbook',
  'teams.post_message': 'Post a message in a Teams channel',
};

export default async function ApprovalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const base = `/o/${organizationId}`;
  const pending = await listMyPendingApprovals(database, context);
  // Who asked for each one, named the way the approval's own page names them.
  const members = pending.length ? await listDirectory(database, context) : [];
  const askedBy = (index: number) => {
    const requested = pending[index]?.requestedByMembershipId;
    if (!requested) return 'Ensemus, as part of the plan';
    return members.find((m) => m.membershipId === requested)?.name ?? 'Someone no longer here';
  };

  return (
    <>
      <PageHead
        title="Approvals"
        description="Review requests from your team and assistants, ordered by deadline."
      />
      <ErrorNotice code={error} />
      {pending.length === 0 ? (
        <Empty
          title="Nothing to decide right now"
          action={
            <ActionLink href={`${base}/work`} variant="secondary">
              Go to your work
            </ActionLink>
          }
        >
          No approvals are waiting for you. When someone asks you to review their work, or an
          assistant asks before it sends or changes something, it appears here with exactly what
          would change.
        </Empty>
      ) : (
        <Card asChild className="approval-queue">
          <section className="card" aria-labelledby="waiting-heading">
            <h2 id="waiting-heading">Waiting for you</h2>
            <ul className="approval-rows" role="list">
              {pending.map((approval, index) => {
                const who = askedBy(index);
                return (
                  <li key={approval.id}>
                    <Link
                      className="approval-row"
                      href={`${base}/approvals/${approval.id}`}
                      aria-labelledby={`approval-${approval.id}`}
                    >
                      <span className="approval-subject">
                        <span id={`approval-${approval.id}`} className="approval-title">
                          {approval.workTitle}
                        </span>
                        <small>
                          {TOOL_WORDS[approval.toolName] ?? 'A proposed action'}
                          {' · '}
                          {approval.toolName === 'work.review'
                            ? `Asked by ${who}`
                            : `An assistant asked, for ${who}`}
                        </small>
                      </span>
                      <span className="approval-meta">
                        <small>Decide by {formatDateTime(approval.expiresAt)}</small>
                        <StatusBadge status="pending" />
                      </span>
                      <ChevronRightIcon className="approval-chevron" aria-hidden="true" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        </Card>
      )}
    </>
  );
}
