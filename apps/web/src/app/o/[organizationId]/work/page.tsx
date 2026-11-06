import { AppError, listProjects, listWorkUnits } from '@ensemus/application';
import { WORK_STATES, type WorkState } from '@ensemus/domain/work-unit';
import Link from 'next/link';
import {
  ClassificationBadge,
  Empty,
  ErrorNotice,
  formatDate,
  PageHead,
  StatusBadge,
} from '@/components/ui';
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
  const projectId = typeof project === 'string' && UUID.test(project) ? project : undefined;
  const scope = {
    ...(filter ? { status: filter } : {}),
    ...(projectId ? { projectId } : {}),
  };
  const projectName = projectId
    ? (await listProjects(database, context)).find((p) => p.id === projectId)?.name
    : undefined;

  // A page reached through a broken link starts again from the top, and says so.
  let notice = error;
  const page = await listWorkUnits(database, context, {
    ...scope,
    ...(cursor ? { cursor } : {}),
  }).catch((failure: unknown) => {
    if (!(failure instanceof AppError) || failure.code !== 'INVALID_INPUT') throw failure;
    notice = 'INVALID_INPUT';
    return listWorkUnits(database, context, scope);
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
      <form className="row" method="get" style={{ marginBottom: '1rem' }}>
        {projectId && <input type="hidden" name="project" value={projectId} />}
        <label className="check">
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
        <Empty action={<Link href={`${base}/work/new`}>Describe an outcome</Link>}>
          {filter || projectId
            ? 'No work matches this filter.'
            : 'No work yet. Start with the outcome you want.'}
        </Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Work</th>
                <th scope="col">Status</th>
                <th scope="col">Due</th>
                <th scope="col">Sensitivity</th>
              </tr>
            </thead>
            <tbody>
              {items.map((work) => (
                <tr key={work.id}>
                  <td>
                    <Link href={`${base}/work/${work.id}`}>{work.title}</Link>
                  </td>
                  <td>
                    <StatusBadge status={work.status} />
                  </td>
                  <td>{work.dueAt ? formatDate(work.dueAt) : <small>None</small>}</td>
                  <td>
                    <ClassificationBadge value={work.classification} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <p style={{ marginTop: '1rem' }}>
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
