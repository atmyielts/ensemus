import { AppError, listProjects, listWorkOverview } from '@ensemus/application';
import { WORK_STATES, type CompletionCriterion, type WorkState } from '@ensemus/domain/work-unit';
import Link from 'next/link';
import {
  ActionLink,
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
        description="Everything you can see, newest first. Open a piece of work to move it along."
        actions={<ActionLink href={`${base}/work/new`}>New work</ActionLink>}
      />
      <ErrorNotice code={notice} />
      {projectId && (
        <p className="notice">
          Showing work in {projectName ?? 'this project'}.{' '}
          <Link href={`${base}/work`}>Show all work</Link>
        </p>
      )}
      {/* With nothing here at all, a filter only gets in the way of the first step. */}
      {(items.length > 0 || filter || projectId) && (
        <form className="inline-form filter" method="get">
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
          <button className="secondary" type="submit">
            Filter
          </button>
        </form>
      )}
      {items.length === 0 ? (
        filter || projectId ? (
          <Empty
            title="Nothing matches"
            action={
              <ActionLink href={`${base}/work`} variant="secondary">
                Show all work
              </ActionLink>
            }
          >
            No work matches this filter. Try another status, or show everything.
          </Empty>
        ) : (
          <Empty
            title="Work starts with an outcome"
            action={
              <ActionLink href={`${base}/compose`} variant="secondary">
                Describe an outcome
              </ActionLink>
            }
          >
            No work yet. Describe the outcome you want, and you can hand it out and follow it here.
          </Empty>
        )
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
                  Done when
                </th>
                <th role="columnheader" scope="col">
                  Due
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
                      <small className="work-meta">
                        <span>
                          <span className="due-word">Owner: </span>
                          {work.ownerName ?? 'Owner unknown'}
                        </span>
                        {/* Most work is for everyone inside, so only a narrower audience is named. */}
                        {work.classification !== 'internal' && (
                          <span>
                            <span className="visually-hidden">Who can see this: </span>
                            <ClassificationBadge value={work.classification} />
                          </span>
                        )}
                      </small>
                    </td>
                    <td role="cell">
                      <StatusBadge status={work.status} />
                    </td>
                    <td role="cell">
                      <span className="due-word">Done when: </span>
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <p className="gap-above-large">
          <ActionLink
            variant="secondary"
            href={`${base}/work?${new URLSearchParams({
              ...(filter ? { status: filter } : {}),
              ...(projectId ? { project: projectId } : {}),
              cursor: nextCursor,
            })}`}
          >
            Next page
          </ActionLink>
        </p>
      )}
    </>
  );
}
