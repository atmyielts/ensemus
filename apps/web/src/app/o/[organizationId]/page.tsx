import { listMyPendingApprovals, listMyWork } from '@ensemus/application';
import { isOverdue } from '@ensemus/domain/work-unit';
import Link from 'next/link';
import {
  ActionLink,
  Empty,
  formatDate,
  formatDateTime,
  PageHead,
  StatusBadge,
} from '@/components/ui';
import { homeListNotes, homeSummary } from '@/lib/work-view';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Home | Ensemus' };

// Home shows what needs this person first, ordered by consequence, not by recency: decisions waiting
// for them, then their own work that is late, blocked or failed, then everything else they are on.
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
  // What is already under Needs you is not repeated straight below it.
  const inAttention = new Set(attention.map((item) => item.id));
  const others = work.filter((item) => !inAttention.has(item.id));
  const notes = homeListNotes({ shown: others.length > 0, workHasMore, attentionHasMore });
  const needsYou = pending.length + attention.length;
  const nothingYet = needsYou === 0 && work.length === 0;
  const roleOn = (item: { ownerMembershipId: string }) =>
    item.ownerMembershipId === context.membershipId ? 'You own this' : 'You are on this';

  return (
    <>
      <PageHead
        title={`Hello, ${firstName}`}
        description={homeSummary({
          needsYou,
          moreNeedYou: attentionHasMore,
          onWork: work.length > 0,
        })}
        actions={
          <ActionLink href={`${base}/work/new`} variant={nothingYet ? 'secondary' : 'primary'}>
            New work
          </ActionLink>
        }
      />
      {nothingYet ? (
        <Empty
          title="Start with the outcome you want"
          action={<ActionLink href={`${base}/compose`}>Describe an outcome</ActionLink>}
        >
          You are not on any open work. Start by describing the outcome you want. You review a
          private preview first, and nothing is created until you confirm it.
        </Empty>
      ) : (
        <div className="stack">
          {needsYou > 0 && (
            <section className="card" aria-labelledby="needs-heading">
              <h2 id="needs-heading">Needs you</h2>
              <ul className="list">
                {pending.map((approval) => (
                  <li key={approval.id} className="block">
                    <span className="row">
                      <Link href={`${base}/approvals/${approval.id}`}>{approval.workTitle}</Link>
                      <span className="badge attention">Your decision</span>
                    </span>
                    <small>
                      Waiting for your approval · Decide by {formatDateTime(approval.expiresAt)}
                    </small>
                  </li>
                ))}
                {attention.map((item) => (
                  <li key={item.id} className="block">
                    <span className="row">
                      <Link href={`${base}/work/${item.id}`}>{item.title}</Link>
                      <StatusBadge status={item.status} />
                    </span>
                    <small>
                      {roleOn(item)}
                      {item.dueAt && isOverdue(item.dueAt, now) && (
                        <> · Was due {formatDate(item.dueAt)}</>
                      )}
                    </small>
                  </li>
                ))}
              </ul>
              {attentionHasMore && (
                <p className="gap-above">
                  There is more than this. <Link href={`${base}/work`}>See all your work</Link>
                </p>
              )}
            </section>
          )}
          <section className="card" aria-labelledby="mine-heading">
            <h2 id="mine-heading">Your work</h2>
            {work.length === 0 ? (
              <Empty action={<Link href={`${base}/compose`}>Describe an outcome</Link>}>
                You are not on any open work. Start by describing the outcome you want.
              </Empty>
            ) : (
              <>
                {notes.allListed && <p className="muted">{notes.allListed}</p>}
                {others.length > 0 && (
                  <ul className="list">
                    {others.map((item) => (
                      <li key={item.id} className="block">
                        <span className="row">
                          <Link href={`${base}/work/${item.id}`}>{item.title}</Link>
                          <StatusBadge status={item.status} />
                        </span>
                        <small>
                          {roleOn(item)}
                          {item.dueAt && <> · Due {formatDate(item.dueAt)}</>}
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
                {notes.more && (
                  <p className={others.length > 0 ? 'gap-above' : undefined}>
                    {notes.more} <Link href={`${base}/work`}>See all work</Link>
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
