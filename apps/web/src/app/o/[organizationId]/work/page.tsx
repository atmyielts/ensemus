import { AppError, listProjects, listWorkOverview } from '@ensemus/application';
import { WORK_STATES, type CompletionCriterion, type WorkState } from '@ensemus/domain/work-unit';
import Link from 'next/link';
import {
  ClassificationBadge,
  Empty,
  ErrorNotice,
  formatDate,
  PageHead,
  StatusBadge,
} from '@/components/ui';
import { evidenceSummary } from '@/lib/work-view';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Work | Ensemus' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LABELS: Record<string, string> = {
  queued: 'Waiting to start',
  ready: 'Ready',
  running: 'In progress',
  blocked: 'Blocked',
  awaiting_approval: 'Waiting for approval',
  verifying: 'Checking',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
};

export default async function WorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ status?: string; cursor?: string; error?: string; project?: string }>;
}) {
  const { organizationId } = await params;
  const { status, cursor, error, project } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const base = `/o/${organizationId}`;
  const filter = WORK_STATES.includes(status as WorkState) ? (status as WorkState) : undefined;
  const projectId =
    typeof project === 'string' && UUID.test(project) ? project.toLowerCase() : undefined;
  const scope = {
    ...(filter ? { status: filter } : {}),
    ...(projectId ? { projectId } : {}),
  };
  const projectName = projectId
    ? (await listProjects(database, context)).find((p) => p.id === projectId)?.name
    : undefined;

  // A page reached through a broken link starts again from the top, and says so.
  let notice = error;
  const page = await listWorkOverview(database, context, {
    ...scope,
    ...(cursor ? { cursor } : {}),
  }).catch((failure: unknown) => {
    if (!(failure instanceof AppError) || failure.code !== 'INVALID_INPUT') throw failure;
    notice = 'INVALID_INPUT';
    return listWorkOverview(database, context, scope);
  });
  const { items, nextCursor } = page;

  return (
    <>
      <PageHead
        title="Work"
        description="Everything you have access to."
        actions={
          <Link className="button" href={`${base}/work/new`}>
            New work
          </Link>
        }
      />
      <ErrorNotice code={notice} />
      {projectId && (
        <p className="notice">
          Showing work in {projectName ?? 'this project'}.{' '}
          <Link href={`${base}/work`}>Show all work</Link>
        </p>
      )}
      <form className="inline-form filter" method="get" style={{ marginBottom: '1rem' }}>
        {projectId && <input type="hidden" name="project" value={projectId} />}
        <label>
          Status
          <select name="status" defaultValue={filter ?? ''}>
            <option value="">All</option>
            {WORK_STATES.map((state) => (
              <option key={state} value={state}>
                {LABELS[state]}
              </option>
            ))}
          </select>
        </label>
        <button className="quiet" type="submit">
          Filter
        </button>
      </form>
      {items.length === 0 ? (
        <Empty
          action={
            filter || projectId ? (
              <Link href={`${base}/work`}>Show all work</Link>
            ) : (
              <Link href={`${base}/work/new`}>Describe an outcome</Link>
            )
          }
        >
          {filter || projectId
            ? 'No work matches this filter.'
            : 'No work yet. Start with the outcome you want.'}
        </Empty>
      ) : (
        <div className="card table-wrap">
          {/* The roles keep this a table for a screen reader when a small screen stacks its rows. */}
          <table className="work-table" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col">
                  Work
                </th>
                <th role="columnheader" scope="col">
                  Status
                </th>
                <th role="columnheader" scope="col">
                  Owner
                </th>
                <th role="columnheader" scope="col">
                  Evidence
                </th>
                <th role="columnheader" scope="col">
                  Due
                </th>
                <th role="columnheader" scope="col">
                  Sensitivity
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {items.map((work) => {
                const evidence = evidenceSummary(
                  work.status as WorkState,
                  work.completionCriteria as CompletionCriterion[],
                  work.evidence,
                );
                return (
                  <tr key={work.id} role="row">
                    <td role="cell">
                      <Link href={`${base}/work/${work.id}`}>{work.title}</Link>
                    </td>
                    <td role="cell">
                      <StatusBadge status={work.status} />
                    </td>
                    <td role="cell">
                      <span className="due-word">Owner: </span>
                      {work.ownerName ?? 'Unknown'}
                    </td>
                    <td role="cell">
                      <span className="due-word">Evidence: </span>
                      {evidence.tone ? (
                        <span className={`badge ${evidence.tone}`}>{evidence.text}</span>
                      ) : (
                        <small>{evidence.text}</small>
                      )}
                    </td>
                    {work.dueAt ? (
                      <td role="cell" className="nowrap">
                        <span className="due-word">Due </span>
                        {formatDate(work.dueAt)}
                      </td>
                    ) : (
                      <td role="cell" className="no-date">
                        <small>None</small>
                      </td>
                    )}
                    <td role="cell">
                      <ClassificationBadge value={work.classification} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <p className="gap-above-large">
          <Link
            href={`${base}/work?${new URLSearchParams({
              ...(filter ? { status: filter } : {}),
              ...(projectId ? { project: projectId } : {}),
              cursor: nextCursor,
            })}`}
          >
            Next page
          </Link>
        </p>
      )}
    </>
  );
}
