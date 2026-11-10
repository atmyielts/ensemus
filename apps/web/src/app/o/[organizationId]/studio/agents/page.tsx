import Link from 'next/link';
import { listAgentDrafts } from '@ensemus/application/agent-drafts';
import { ActionLink, Empty, PageHead, StatusBadge, formatDateTime } from '@/components/ui';
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
      <Link href={base}>Back to Automation Studio</Link>
      <PageHead
        title="Assistant drafts"
        description="Define a purpose, choose boundaries, rehearse the rules, then review and publish."
        actions={<ActionLink href={`${base}/agents/new`}>Create assistant</ActionLink>}
      />
      {drafts.length ? (
        <>
          <ul className="list" aria-label="Assistant drafts">
            {drafts.map((d) => (
              <li key={d.id}>
                <Link href={`${base}/agents/${d.id}`}>
                  <strong>{d.name}</strong>
                  <br />
                  <small>
                    Revision {d.version} · Updated {formatDateTime(d.updatedAt)}
                  </small>
                </Link>
                <StatusBadge status={d.status} />
              </li>
            ))}
          </ul>
          <p className="muted">Up to 200 recent drafts are shown. Saving a draft starts no run.</p>
        </>
      ) : (
        <Empty
          title="No assistant drafts yet"
          action={<ActionLink href={`${base}/agents/new`}>Create assistant</ActionLink>}
        >
          Start with the result your team needs. No model or outside action runs while you prepare
          it.
        </Empty>
      )}
    </>
  );
}
