import { listProcessDrafts } from '@ensemus/application/process-specs';
import Link from 'next/link';
import {
  ActionLink,
  BackLink,
  ClassificationBadge,
  Empty,
  PageHead,
  StatusBadge,
  formatDateTime,
} from '@/components/ui';
import { requireStudio, studioRead } from '@/server/studio-pages';
export const metadata = { title: 'Workflow drafts | Ensemus' };
export default async function WorkflowsPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireStudio(organizationId),
    drafts = await studioRead(listProcessDrafts(database, context)),
    base = `/o/${organizationId}/studio/workflows`;
  return (
    <>
      <BackLink href={`/o/${organizationId}/studio`}>Automation Studio</BackLink>
      <PageHead
        title="Workflow drafts"
        description="Connect work, assistants, approvals and evidence checks. Save a definition, rehearse its rules, then request human review."
        actions={<ActionLink href={`${base}/new`}>Create workflow</ActionLink>}
      />
      {drafts.length ? (
        <>
          <ul className="list" aria-label="Readable workflow drafts">
            {drafts.map((draft) => (
              <li key={draft.id}>
                <div>
                  <Link href={`${base}/${draft.id}`}>
                    <strong>{draft.name}</strong>
                  </Link>
                  <p className="muted">
                    Revision {draft.version} · Updated {formatDateTime(draft.updatedAt)}
                  </p>
                </div>
                <ClassificationBadge value={draft.classification} />
                <StatusBadge status={draft.status} />
              </li>
            ))}
          </ul>
          <p className="muted">
            Up to 200 recent readable drafts are shown. Open a draft to check it against the current
            catalog; a stored hash alone does not prove current readiness.
          </p>
        </>
      ) : (
        <Empty
          title="No workflow drafts yet"
          action={<ActionLink href={`${base}/new`}>Create workflow</ActionLink>}
        >
          Start with work for a person. No model or outside action runs while you prepare the
          definition.
        </Empty>
      )}
    </>
  );
}
