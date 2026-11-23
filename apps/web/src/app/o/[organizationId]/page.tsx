import { getWorkDetail, idSchema, listMyPendingApprovals, listMyWork } from '@ensemus/application';
import { isOverdue } from '@ensemus/domain/work-unit';
import {
  CircleIcon,
  CircleDotIcon,
  AlertCircleIcon,
  CheckCheckIcon,
  XIcon,
  ArrowUpRightIcon,
} from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  ActionLink,
  ClassificationBadge,
  Empty,
  formatDate,
  formatDateTime,
  PageHead,
  StatusBadge,
} from '@/components/ui';
import { orNotFound, requireTenant } from '@/server/tenant';
export const metadata = { title: 'My work | Ensemus' };
const GROUP: Record<string, string> = {
  queued: 'Waiting to start',
  ready: 'Ready to start',
  running: 'In progress',
  blocked: 'Blocked',
  awaiting_approval: 'Waiting for approval',
  verifying: 'Being checked',
  failed: 'Needs another look',
};
function StateIcon({ status }: { status: string }) {
  const Icon = ['running', 'verifying'].includes(status)
    ? CircleDotIcon
    : ['blocked', 'failed'].includes(status)
      ? AlertCircleIcon
      : CircleIcon;
  return <Icon className="queue-icon" aria-hidden="true" />;
}
/** The queue, selection and preview are current authorized server views, including without JavaScript. */
export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ view?: string; selected?: string }>;
}) {
  const [{ organizationId }, query] = await Promise.all([params, searchParams]);
  const { actor, context, database } = await requireTenant(organizationId),
    base = `/o/${organizationId}`,
    now = new Date();
  const [pending, mine] = await Promise.all([
    listMyPendingApprovals(database, context),
    listMyWork(database, context, now),
  ]);
  const view = query.view === 'attention' || query.view === 'reviews' ? query.view : 'assigned';
  const selected = query.selected === undefined ? null : idSchema.safeParse(query.selected);
  if (selected && !selected.success) notFound();
  const visible = view === 'assigned' ? mine.work : view === 'attention' ? mine.attention : [];
  const selectedId = selected?.success ? selected.data : null;
  // A preview may name only a row in the current queue; the detail service repeats native Work ACLs.
  if (selectedId && !visible.some((item) => item.id === selectedId)) notFound();
  const detail = selectedId ? await orNotFound(getWorkDetail(database, context, selectedId)) : null;
  const groups = new Map<string, typeof visible>();
  for (const item of visible) {
    const items = groups.get(item.status) ?? [];
    groups.set(item.status, [...items, item]);
  }
  const tab = (value: string) => (value === 'assigned' ? base : `${base}?view=${value}`);
  const showReviews = view === 'reviews' || view === 'attention';
  const empty = visible.length === 0 && (!showReviews || pending.length === 0);
  return (
    <>
      <PageHead
        title="My work"
        actions={<ActionLink href={`${base}/work/new`}>New work</ActionLink>}
      />
      <nav className="workbench-tabs" aria-label="My work views">
        <Link
          className="workbench-tab"
          href={tab('assigned')}
          aria-current={view === 'assigned' ? 'page' : undefined}
        >
          Assigned to you{' '}
          <span className="workbench-count">
            {mine.work.length}
            {mine.workHasMore ? '+' : ''}
          </span>
        </Link>
        <Link
          className="workbench-tab"
          href={tab('attention')}
          aria-current={view === 'attention' ? 'page' : undefined}
        >
          Needs attention{' '}
          <span className="workbench-count">
            {mine.attention.length + pending.length}
            {mine.attentionHasMore ? '+' : ''}
          </span>
        </Link>
        <Link
          className="workbench-tab"
          href={tab('reviews')}
          aria-current={view === 'reviews' ? 'page' : undefined}
        >
          Reviews <span className="workbench-count">{pending.length}</span>
        </Link>
      </nav>
      <div className={`workbench-layout${detail ? ' has-selection' : ''}`}>
        <div className="workbench-queue">
          {empty && (
            <Empty
              title={
                view === 'reviews'
                  ? 'No reviews waiting'
                  : view === 'attention'
                    ? 'Nothing needs your attention'
                    : 'No open work assigned'
              }
              action={
                view === 'assigned' ? (
                  <ActionLink href={`${base}/compose`} variant="secondary">
                    Describe an outcome
                  </ActionLink>
                ) : undefined
              }
            >
              {view === 'assigned'
                ? 'You are not on any open work. Start by describing the outcome you want.'
                : 'This view shows the decisions and work that need you next.'}
            </Empty>
          )}
          {showReviews && pending.length > 0 && (
            <section className="queue-group" aria-labelledby="review-queue-heading">
              <h2 className="queue-heading" id="review-queue-heading">
                <CheckCheckIcon className="queue-icon" aria-hidden="true" />
                Your decisions <span className="workbench-count">{pending.length}</span>
              </h2>
              <ul className="queue-list">
                {pending.map((approval) => (
                  <li className="queue-item" key={approval.id}>
                    <Link className="queue-row" href={`${base}/approvals/${approval.id}`}>
                      <CheckCheckIcon className="queue-icon" aria-hidden="true" />
                      <span className="queue-title">{approval.workTitle}</span>
                      <span className="queue-meta">
                        Decide by {formatDate(approval.expiresAt)}
                        <ArrowUpRightIcon className="queue-icon" aria-hidden="true" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {[...groups].map(([status, items]) => (
            <section className="queue-group" key={status} aria-labelledby={`queue-${status}`}>
              <h2 className="queue-heading" id={`queue-${status}`}>
                <StateIcon status={status} />
                {GROUP[status] ?? 'Your work'}
                <span className="workbench-count">{items.length}</span>
              </h2>
              <ul className="queue-list">
                {items.map((item) => (
                  <li className="queue-item" key={item.id}>
                    <Link
                      className="queue-row"
                      href={`${base}?view=${view}&selected=${item.id}`}
                      aria-current={selectedId === item.id ? 'true' : undefined}
                    >
                      <StateIcon status={item.status} />
                      <span className="queue-title">{item.title}</span>
                      <span className="queue-meta">
                        {item.dueAt && (
                          <time
                            className={`queue-date${isOverdue(item.dueAt, now) ? ' overdue' : ''}`}
                            aria-label={`${isOverdue(item.dueAt, now) ? 'Was due' : 'Due'} ${formatDate(item.dueAt)}`}
                            dateTime={item.dueAt.toISOString()}
                          >
                            {formatDate(item.dueAt)}
                          </time>
                        )}
                        <span
                          className="queue-owner"
                          title={
                            item.ownerMembershipId === context.membershipId
                              ? 'You own this'
                              : 'You contribute to this'
                          }
                        >
                          {Array.from(actor.name)[0]?.toUpperCase() ?? 'Y'}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {(view === 'assigned'
            ? mine.workHasMore
            : view === 'attention' && mine.attentionHasMore) && (
            <p className="queue-more">
              More work is available. <Link href={`${base}/work`}>Open all work</Link>
            </p>
          )}
        </div>
        {detail && (
          <aside className="work-context" aria-label="Selected work">
            <div className="work-context-header">
              <span>Work details</span>
              <Button asChild variant="ghost" size="icon" aria-label="Close work preview">
                <Link href={tab(view)}>
                  <XIcon aria-hidden="true" />
                </Link>
              </Button>
            </div>
            <h2>{detail.work.title}</h2>
            {detail.work.objective && (
              <p className="work-context-objective">{detail.work.objective}</p>
            )}
            <dl className="work-properties">
              <dt>Status</dt>
              <dd>
                <StatusBadge status={detail.work.status} />
              </dd>
              <dt>Owner</dt>
              <dd>
                {detail.work.ownerMembershipId === context.membershipId
                  ? 'You'
                  : (detail.people.find(
                      (person) => person.membershipId === detail.work.ownerMembershipId,
                    )?.name ?? 'Assigned workspace member')}
              </dd>
              <dt>Visibility</dt>
              <dd>
                <ClassificationBadge value={detail.work.classification} />
              </dd>
              {detail.work.dueAt && (
                <>
                  <dt>Due</dt>
                  <dd>{formatDateTime(detail.work.dueAt)}</dd>
                </>
              )}
            </dl>
            <Button asChild variant="outline" className="w-full">
              <Link href={`${base}/work/${detail.work.id}`}>
                Open work details
                <ArrowUpRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </aside>
        )}
      </div>
    </>
  );
}
