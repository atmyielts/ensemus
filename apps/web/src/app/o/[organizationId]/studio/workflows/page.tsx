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
        description="A workflow is the steps a process goes through: work for people, help from assistants, approvals and the checks that say it is done."
        actions={<ActionLink href={`${base}/new`}>Create workflow</ActionLink>}
      />
      {drafts.length ? (
        <div className="card">
          <ul className="list" aria-label="Readable workflow drafts">
            {drafts.map((draft) => (
              <li key={draft.id}>
                <span>
                  <Link href={`${base}/${draft.id}`}>{draft.name}</Link>
                  <br />
                  <small>
                    Version {draft.version} · Updated {formatDateTime(draft.updatedAt)}
                  </small>
                </span>
                <span className="row">
                  <ClassificationBadge value={draft.classification} />
                  <StatusBadge status={draft.status} />
                </span>
              </li>
            ))}
          </ul>
          <p className="studio-next-step">
            The 200 most recent drafts you can read are shown. Open one to see whether it is ready
            to rehearse.
          </p>
        </div>
      ) : (
        <Empty
          title="No workflow drafts yet"
          action={
            <ActionLink href={`${base}/new`} variant="secondary">
              Create your first workflow
            </ActionLink>
          }
        >
          Name the process and choose who can see it. Then add its steps one at a time. Nothing runs
          while you prepare it.
        </Empty>
      )}
    </>
  );
}
