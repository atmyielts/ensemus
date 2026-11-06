import { listMyPendingApprovals, listMyWork } from '@ensemus/application';
import { isOverdue } from '@ensemus/domain/work-unit';
import Link from 'next/link';
import { Empty, formatDate, PageHead, StatusBadge } from '@/components/ui';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Home | Ensemus' };

// Home shows what needs this person's attention first, ordered by consequence, not by recency.
export default async function HomePage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const { actor, context, database } = await requireTenant(organizationId);
  const base = `/o/${organizationId}`;
  const now = new Date();
  const [pending, mine] = await Promise.all([
    listMyPendingApprovals(database, context),
    listMyWork(database, context, now),
  ]);
  const { attention, attentionHasMore, work, workHasMore } = mine;
  const firstName = actor.name.split(' ')[0];
  const roleOn = (item: { ownerMembershipId: string }) =>
    item.ownerMembershipId === context.membershipId ? 'You own this' : 'You are on this';

  return (
    <>
      <PageHead
        title={`Hello, ${firstName}`}
        description="What needs you, and what is moving."
        actions={
          <Link className="button" href={`${base}/work/new`}>
            New work
          </Link>
        }
      />
      <div className="stack">
        {pending.length > 0 && (
          <section className="card" aria-labelledby="approvals-heading">
            <h2 id="approvals-heading">Waiting for your approval</h2>
            <ul className="list">
              {pending.map((approval) => (
                <li key={approval.id}>
                  <Link href={`${base}/approvals/${approval.id}`}>{approval.workTitle}</Link>
                  <small>Expires {formatDate(approval.expiresAt)}</small>
                </li>
              ))}
            </ul>
          </section>
        )}
        {attention.length > 0 && (
          <section className="card" aria-labelledby="attention-heading">
            <h2 id="attention-heading">Needs attention</h2>
            <ul className="list">
              {attention.map((item) => (
                <li key={item.id}>
                  <span>
                    <Link href={`${base}/work/${item.id}`}>{item.title}</Link>
                    <br />
                    <small>{roleOn(item)}</small>
                  </span>
                  <span className="row">
                    {item.dueAt && isOverdue(item.dueAt, now) && (
                      <small>Was due {formatDate(item.dueAt)}</small>
                    )}
                    <StatusBadge status={item.status} />
                  </span>
                </li>
              ))}
            </ul>
            {attentionHasMore && (
              <p style={{ margin: '0.75rem 0 0' }}>
                There is more than this. <Link href={`${base}/work`}>See all your work</Link>
              </p>
            )}
          </section>
        )}
        <section className="card" aria-labelledby="mine-heading">
          <h2 id="mine-heading">Your work</h2>
          {work.length === 0 ? (
            <Empty action={<Link href={`${base}/work/new`}>Describe an outcome</Link>}>
              You are not on any open work. Start by describing the outcome you want.
            </Empty>
          ) : (
            <>
              <ul className="list">
                {work.map((item) => (
                  <li key={item.id}>
                    <span>
                      <Link href={`${base}/work/${item.id}`}>{item.title}</Link>
                      <br />
                      <small>{roleOn(item)}</small>
                    </span>
                    <span className="row">
                      {item.dueAt && <small>Due {formatDate(item.dueAt)}</small>}
                      <StatusBadge status={item.status} />
                    </span>
                  </li>
                ))}
              </ul>
              {workHasMore && (
                <p style={{ margin: '0.75rem 0 0' }}>
                  These are the most urgent. <Link href={`${base}/work`}>See all work</Link>
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
