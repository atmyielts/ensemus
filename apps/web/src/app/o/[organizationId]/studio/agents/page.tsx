import Link from 'next/link';
import { listAgentDrafts } from '@ensemus/application/agent-drafts';
import {
  ActionLink,
  BackLink,
  Empty,
  PageHead,
  StatusBadge,
  formatDateTime,
} from '@/components/ui';
import { requireStudio, studioRead } from '@/server/studio-pages';
export const metadata = { title: 'Assistant drafts | Ensemus' };
export default async function AgentDraftsPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireStudio(organizationId),
    drafts = await studioRead(listAgentDrafts(database, context)),
    base = `/o/${organizationId}/studio`;
  return (
    <>
      <BackLink href={base}>Automation Studio</BackLink>
      <PageHead
        title="Assistant drafts"
        description="Say what an assistant should help with and what it may do. Rehearse it, ask a colleague to review it, then publish it for your team."
        actions={<ActionLink href={`${base}/agents/new`}>Create assistant</ActionLink>}
      />
      {drafts.length ? (
        <div className="card">
          <ul className="list" aria-label="Assistant drafts">
            {drafts.map((d) => (
              <li key={d.id}>
                <span>
                  <Link href={`${base}/agents/${d.id}`}>{d.name}</Link>
                  <br />
                  <small>
                    Version {d.version} · Updated {formatDateTime(d.updatedAt)}
                  </small>
                </span>
                <StatusBadge status={d.status} />
              </li>
            ))}
          </ul>
          <p className="studio-next-step">
            The 200 most recent drafts are shown. Saving a draft never starts it.
          </p>
        </div>
      ) : (
        <Empty
          title="No assistant drafts yet"
          action={
            <ActionLink href={`${base}/agents/new`} variant="secondary">
              Create your first assistant
            </ActionLink>
          }
        >
          Start with the result your team needs, such as a weekly summary or a first draft of a
          reply. Nothing runs while you prepare it.
        </Empty>
      )}
    </>
  );
}
