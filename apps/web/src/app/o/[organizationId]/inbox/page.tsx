import { Card } from '@/components/ui/card';
import {
  NOTIFY_FEDERATION_GRANT_ACCEPTED,
  NOTIFY_FEDERATION_ITEM_RECEIVED,
} from '@ensemus/domain/federation-events';
import {
  countUnread,
  INBOX_SIZE,
  listMyNotifications,
  listMyPendingApprovals,
} from '@ensemus/application';
import { ChevronRightIcon } from 'lucide-react';
import { SubmitButton } from '@/components/submit-button';
import { Badge } from '@/components/ui/badge';
import { ActionLink, Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { openNotificationAction } from '@/server/work-actions';

export const metadata = { title: 'Inbox | Ensemus' };

const KIND_WORDS: Record<string, string> = {
  [NOTIFY_FEDERATION_GRANT_ACCEPTED]: 'A collaboration invitation was accepted',
  [NOTIFY_FEDERATION_ITEM_RECEIVED]: 'An organization shared an item with you',
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
  'external_action.unknown': "We don't know whether something was sent, and it needs you to look",
  'external_action.failed': 'Something you asked to send was not sent',
  'external_action.sent': 'Something you asked to send was sent',
};

/** Turns a notification's reference into a page. The page checks access when it is opened. */
function targetPath(base: string, targetRef: string) {
  const separator = targetRef.indexOf(':');
  const type = targetRef.slice(0, separator);
  const id = encodeURIComponent(targetRef.slice(separator + 1));
  if (separator > 0 && type === 'approval') return `${base}/approvals/${id}`;
  if (separator > 0 && type === 'work_unit') return `${base}/work/${id}`;
  if (separator > 0 && type === 'invitation') return `${base}/people`;
  if (separator > 0 && type === 'federation_grant') return `${base}/collaboration#grant-${id}`;
  if (separator > 0 && type === 'federation_item') return `${base}/collaboration/received/${id}`;
  if (separator > 0 && type === 'external_action') return `${base}/external-actions/${id}`;
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
        description="Review requests and work updates. Reminders come first, followed by unread items."
        actions={
          <ActionLink href={`${base}/notifications`} variant="secondary">
            Email settings
          </ActionLink>
        }
      />
      <ErrorNotice code={error} />
      {unread > INBOX_SIZE && (
        <p className="notice" role="status">
          You have {unread} unopened items, and this shows {INBOX_SIZE} of them. Each one you open
          brings the next one up.
        </p>
      )}
      {ordered.length === 0 ? (
        <Empty
          title="You are all caught up"
          action={
            <ActionLink href={`${base}/work`} variant="secondary">
              Go to your work
            </ActionLink>
          }
        >
          Nothing here. When a decision needs you, or something you own changes, it appears here.
        </Empty>
      ) : (
        <Card asChild className="block bg-transparent">
          <div className="activity-list">
            <ul className="activity-rows" role="list">
              {ordered.map((notification) => {
                const workTitle = titleOf.get(notification.targetRef);
                const message = KIND_WORDS[notification.kind] ?? 'Something needs your attention';
                return (
                  <li key={notification.id}>
                    <form action={openNotificationAction}>
                      <input type="hidden" name="organizationId" value={organizationId} />
                      <input type="hidden" name="id" value={notification.id} />
                      <input
                        type="hidden"
                        name="target"
                        value={targetPath(base, notification.targetRef)}
                      />
                      <SubmitButton
                        className="quiet activity-row grid h-auto w-full grid-cols-[var(--activity-columns)] gap-x-3 gap-y-1 rounded-none border-0 px-3 py-2.5 text-start whitespace-normal hover:bg-accent dark:hover:bg-accent"
                        working="Opening notification"
                      >
                        <span className="activity-subject">
                          <span className="activity-title">{workTitle ?? message}</span>
                          {workTitle && <small>{message}</small>}
                        </span>
                        <span className="activity-meta">
                          <small>
                            {formatDateTime(notification.lastRemindedAt ?? notification.createdAt)}
                          </small>
                          {notification.remindersSent > 0 && !notification.readAt && (
                            <Badge variant="outline" className="badge attention border-transparent">
                              Reminder
                            </Badge>
                          )}
                          {!notification.readAt && (
                            <Badge variant="outline" className="badge active border-transparent">
                              New
                            </Badge>
                          )}
                        </span>
                        <ChevronRightIcon className="activity-chevron" aria-hidden="true" />
                      </SubmitButton>
                    </form>
                  </li>
                );
              })}
            </ul>
          </div>
        </Card>
      )}
    </>
  );
}
