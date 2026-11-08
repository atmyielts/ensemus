import { AppError } from '@ensemus/application';
import { listProcessRuns } from '@ensemus/application/process-runs';
import { processRunsQuerySchema } from '@ensemus/contracts/studio';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { ActionLink, BackLink, Empty, PageHead, formatDateTime } from '@/components/ui';
import { runStatusNames, runCodeText } from '@/lib/process-run-present';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Workflow runs | Ensemus' };
export default async function ProcessRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireTenant(organizationId),
    search = await searchParams,
    normalized = { ...search };
  if (normalized.status === '') delete normalized.status;
  const parsed = processRunsQuerySchema.safeParse(normalized),
    base = `/o/${organizationId}/studio/runs`,
    builder = canProduct(context.role, 'studio.publish');
  if (!parsed.success)
    return (
      <>
        <BackLink href={base}>Workflow runs</BackLink>
        <PageHead title="Choose a valid workflow filter" />
        <Empty action={<ActionLink href={base}>Reset filters</ActionLink>}>
          The status or page link is not valid. No filter was silently ignored.
        </Empty>
      </>
    );
  const query = {
    ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
    ...(parsed.data.after === undefined ? {} : { after: parsed.data.after }),
  };
  let page: Awaited<ReturnType<typeof listProcessRuns>> | null = null;
  try {
    page = await listProcessRuns(database, context, query);
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE')) throw error;
  }
  return (
    <>
      <BackLink href={builder ? `/o/${organizationId}/studio` : `/o/${organizationId}/work`}>
        {builder ? 'Automation Studio' : 'Work'}
      </BackLink>
      <PageHead
        title="Workflow runs"
        description="Follow real work, people’s decisions and outside-action receipts. Only workflow work you can currently read is included."
        actions={builder ? <ActionLink href={`${base}/new`}>Start workflow</ActionLink> : undefined}
      />
      <form method="get" className="row">
        <label htmlFor="workflow-status">Status</label>
        <select id="workflow-status" name="status" defaultValue={parsed.data.status ?? ''}>
          <option value="">All readable runs</option>
          {Object.entries(runStatusNames).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="submit" className="secondary">
          Apply filter
        </button>
      </form>
      {page === null ? (
        <Empty
          title="Workflow history unavailable"
          action={<ActionLink href={base}>Refresh workflow runs</ActionLink>}
        >
          We could not verify this workflow’s saved history. Ask an administrator to review it
          before continuing.
        </Empty>
      ) : page.items.length ? (
        <>
          <ul className="list" aria-label="Readable workflow runs">
            {page.items.map((run) => (
              <li key={run.id}>
                <div>
                  <Link href={`${base}/${run.id}`}>
                    <strong>{run.title}</strong>
                  </Link>
                  <p className="muted">
                    {run.processName} · Started {formatDateTime(run.createdAt)}
                  </p>
                  {run.stopCode && <p>{runCodeText(run.stopCode)}</p>}
                </div>
                <span
                  className={`badge ${run.status === 'failed' ? 'bad' : run.status === 'completed' ? 'done' : ''}`}
                >
                  {runStatusNames[run.status]}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">
            Cost is measured on an individual run when the ledger and your access allow it; this
            list does not estimate a total.
          </p>
          {page.next && (
            <ActionLink
              href={`${base}?${new URLSearchParams({ ...(query.status ? { status: query.status } : {}), after: page.next })}`}
              variant="secondary"
            >
              Next page
            </ActionLink>
          )}
        </>
      ) : (
        <Empty title="No readable runs for this filter">
          Start an approved workflow or follow workflow work assigned to you.
        </Empty>
      )}
      {builder && (
        <p>
          <Link href={`${base}/catalog`}>Browse bundled workflow definitions</Link> ·{' '}
          <Link href={`/o/${organizationId}/studio/workflows`}>Prepare a workflow definition</Link>
        </p>
      )}
    </>
  );
}
