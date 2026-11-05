import { listMyPendingApprovals, listWorkUnits } from '@ensemus/application';
import Link from 'next/link';
import { Empty, formatDate, PageHead, StatusBadge } from '@/components/ui';
import { requireTenant } from '@/server/tenant';

// Home shows what needs this person's attention first, ordered by consequence, not by recency.
export default async function HomePage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const { actor, context, database } = await requireTenant(organizationId);
  const base = `/o/${organizationId}`;
  const [pending, { items }] = await Promise.all([
    listMyPendingApprovals(database, context),
    listWorkUnits(database, context),
  ]);
  const now = Date.now();
  const active = items.filter((w) => !['completed', 'cancelled'].includes(w.status));
  const mine = active.filter((w) => w.ownerMembershipId === context.membershipId);
  const overdue = mine.filter((w) => w.dueAt && w.dueAt.getTime() < now);
  const blocked = mine.filter((w) => w.status === 'blocked' || w.status === 'failed');
  const firstName = actor.name.split(' ')[0];

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
        {(overdue.length > 0 || blocked.length > 0) && (
          <section className="card" aria-labelledby="attention-heading">
            <h2 id="attention-heading">Needs attention</h2>
            <ul className="list">
              {[...new Map([...blocked, ...overdue].map((w) => [w.id, w])).values()].map((work) => (
                <li key={work.id}>
                  <Link href={`${base}/work/${work.id}`}>{work.title}</Link>
                  <span className="row">
                    {work.dueAt && work.dueAt.getTime() < now && (
                      <small>Was due {formatDate(work.dueAt)}</small>
                    )}
                    <StatusBadge status={work.status} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="card" aria-labelledby="mine-heading">
          <h2 id="mine-heading">Your work</h2>
          {mine.length === 0 ? (
            <Empty action={<Link href={`${base}/work/new`}>Describe an outcome</Link>}>
              Nothing is assigned to you. Start by describing the outcome you want.
            </Empty>
          ) : (
            <ul className="list">
              {mine.slice(0, 12).map((work) => (
                <li key={work.id}>
                  <Link href={`${base}/work/${work.id}`}>{work.title}</Link>
                  <span className="row">
                    {work.dueAt && <small>Due {formatDate(work.dueAt)}</small>}
                    <StatusBadge status={work.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
