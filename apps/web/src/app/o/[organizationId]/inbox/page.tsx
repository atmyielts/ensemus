import { listMyNotifications } from '@ensemus/application';
import Link from 'next/link';
import { SubmitButton } from '@/components/submit-button';
import { Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { openNotificationAction } from '@/server/work-actions';

export const metadata = { title: 'Inbox | Ensemus' };

const KIND_WORDS: Record<string, string> = {
  'approval.requested': 'An approval needs your decision',
  'approval.decided': 'A review of your work was decided',
  'approval.expired': 'A review of your work ran out of time',
  'approval.closed': 'A review of your work was closed, because the reviewer lost access',
  'work.stopped': 'Work you own was stopped',
  'work.failed': 'Work you own did not finish',
  'work.assigned': 'You were put on some work',
  'member.join_requested': 'Someone is asking to join, and needs confirming',
};

/** Turns a notification's reference into a page. The page checks access when it is opened. */
function targetPath(base: string, targetRef: string) {
  const separator = targetRef.indexOf(':');
  const type = targetRef.slice(0, separator);
  const id = encodeURIComponent(targetRef.slice(separator + 1));
  if (separator > 0 && type === 'approval') return `${base}/approvals/${id}`;
  if (separator > 0 && type === 'work_unit') return `${base}/work/${id}`;
  if (separator > 0 && type === 'invitation') return `${base}/people`;
  return `${base}/inbox`;
}

export default async function InboxPage({
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
  const notifications = await listMyNotifications(database, context);
  // The sort is stable, so each group stays newest first.
  const ordered = [...notifications].sort((a, b) => Number(!!a.readAt) - Number(!!b.readAt));

  return (
    <>
      <PageHead title="Inbox" description="What needs you, with anything new at the top." />
      <ErrorNotice code={error} />
      {ordered.length === 0 ? (
        <Empty action={<Link href={`${base}/work`}>Go to your work</Link>}>
          Nothing here. When an approval needs your decision, it appears here.
        </Empty>
      ) : (
        <div className="card">
          <ul className="list">
            {ordered.map((notification) => (
              <li key={notification.id}>
                <form action={openNotificationAction}>
                  <input type="hidden" name="organizationId" value={organizationId} />
                  <input type="hidden" name="id" value={notification.id} />
                  <input
                    type="hidden"
                    name="target"
                    value={targetPath(base, notification.targetRef)}
                  />
                  <SubmitButton className="link">
                    {KIND_WORDS[notification.kind] ?? 'Something needs your attention'}
                  </SubmitButton>
                </form>
                <span className="row">
                  <small>{formatDateTime(notification.createdAt)}</small>
                  {notification.remindersSent > 0 && !notification.readAt && (
                    <span className="badge attention">Reminder</span>
                  )}
                  {!notification.readAt && <span className="badge active">New</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
