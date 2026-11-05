import { listWorkUnits } from '@ensemus/application';
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
  searchParams: Promise<{ status?: string; cursor?: string; error?: string }>;
}) {
  const { organizationId } = await params;
  const { status, cursor, error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const base = `/o/${organizationId}`;
  const filter = WORK_STATES.includes(status as WorkState) ? (status as WorkState) : undefined;
  const { items, nextCursor } = await listWorkUnits(database, context, {
    ...(filter ? { status: filter } : {}),
    ...(cursor ? { cursor } : {}),
  });

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
      <ErrorNotice code={error} />
      <form className="row" method="get" style={{ marginBottom: '1rem' }}>
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
          {filter ? 'No work has this status.' : 'No work yet. Start with the outcome you want.'}
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
