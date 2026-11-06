import {
  countUnread,
  INBOX_SIZE,
  listMyNotifications,
  listMyPendingApprovals,
} from '@ensemus/application';
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
  'approval.outdated': 'A review of your work was closed, because the work changed',
  'approval.superseded':
    'A review you asked for was closed, because a plan started and asks its own reviewer',
  'approval.work_finished': 'A review you asked for was closed, because the work finished',
  'approval.work_reopened': 'A review you asked for was closed, because the work was reopened',
  'work.run_withdrawn': 'A plan you asked to run was withdrawn, because someone moved the work',
  'work.stopped': 'Work you own was stopped',
  'work.failed': 'Work you own did not finish',
  'work.assigned': 'You were put on some work',
  'work.owner_recovered':
    'Another owner chose a new owner for restricted work whose owner was disabled',
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
  // In the order they come back in: reminders, then anything else unread, then what has been read.
  const [ordered, unread, pending] = await Promise.all([
    listMyNotifications(database, context),
    countUnread(database, context),
    listMyPendingApprovals(database, context),
  ]);
  // Notifications hold references only. A decision still waiting for this person is one they are
  // allowed to read, so its title can be shown, which tells the rows of a busy inbox apart.
  const titleOf = new Map(
    pending.map((approval) => [`approval:${approval.id}`, approval.workTitle]),
  );

  return (
    <>
      <PageHead
        title="Inbox"
        description="What needs you. Reminders come first, then anything else you have not opened. Reminders appear here, and nothing is sent by email yet."
      />
      <ErrorNotice code={error} />
      {unread > INBOX_SIZE && (
        <p className="notice" role="status">
          You have {unread} unopened items, and this shows {INBOX_SIZE} of them. Each one you open
          brings the next one up.
        </p>
      )}
      {ordered.length === 0 ? (
        <Empty action={<Link href={`${base}/work`}>Go to your work</Link>}>
          Nothing here. When an approval needs your decision, it appears here.
        </Empty>
      ) : (
        <div className="card">
          <ul className="list">
            {ordered.map((notification) => (
              <li key={notification.id}>
                <form className="inbox-item" action={openNotificationAction}>
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
                  {titleOf.has(notification.targetRef) && (
                    <small>{titleOf.get(notification.targetRef)}</small>
                  )}
                </form>
                <span className="row">
                  <small>
                    {formatDateTime(notification.lastRemindedAt ?? notification.createdAt)}
                  </small>
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
