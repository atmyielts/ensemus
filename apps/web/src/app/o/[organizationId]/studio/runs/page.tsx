import { AppError } from '@ensemus/application';
import { listProcessRuns } from '@ensemus/application/process-runs';
import { processRunsQuerySchema } from '@ensemus/contracts/studio';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { ActionLink, BackLink, Empty, PageHead, formatDateTime } from '@/components/ui';
import { runStatusNames, runCodeText } from '@/lib/process-run-present';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Workflow runs | Ensemus' };
const tone = (status: keyof typeof runStatusNames) =>
  status === 'failed'
    ? 'bad'
    : status === 'completed'
      ? 'done'
      : status === 'cancelled'
        ? ''
        : 'active';
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
        <Empty
          title="This filter link does not work"
          action={<ActionLink href={base}>Show all workflow runs</ActionLink>}
        >
          The status or page in the link is not one we recognise, so nothing was filtered.
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
        description="Each run is a published workflow doing real work. Follow its steps, the people deciding and anything sent outside Ensemus. You see the runs you have access to."
        actions={builder ? <ActionLink href={`${base}/new`}>Start workflow</ActionLink> : undefined}
      />
      <form method="get" className="inline-form filter">
        <label htmlFor="workflow-status">
          Status
          <select id="workflow-status" name="status" defaultValue={parsed.data.status ?? ''}>
            <option value="">All runs</option>
            {Object.entries(runStatusNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="secondary">
          Apply filter
        </button>
      </form>
      {page === null ? (
        <Empty
          title="Workflow history unavailable"
          action={
            <ActionLink href={base} variant="secondary">
              Refresh workflow runs
            </ActionLink>
          }
        >
          We could not check the saved history of these runs. Ask an administrator to look into it
          before you carry on.
        </Empty>
      ) : page.items.length ? (
        <div className="card">
          <ul className="list" aria-label="Readable workflow runs">
            {page.items.map((run) => (
              <li key={run.id}>
                <span>
                  <Link href={`${base}/${run.id}`}>{run.title}</Link>
                  <br />
                  <small>
                    {run.processName} · Started {formatDateTime(run.createdAt)}
                  </small>
                  {run.stopCode && (
                    <>
                      <br />
                      <small>{runCodeText(run.stopCode)}</small>
                    </>
                  )}
                </span>
                <span className={`badge ${tone(run.status)}`}>{runStatusNames[run.status]}</span>
              </li>
            ))}
          </ul>
          {page.next && (
            <p className="studio-next-step">
              <ActionLink
                href={`${base}?${new URLSearchParams({ ...(query.status ? { status: query.status } : {}), after: page.next })}`}
                variant="secondary"
              >
                Next page
              </ActionLink>
            </p>
          )}
        </div>
      ) : (
        <Empty
          title={query.status ? 'No runs with this status' : 'No workflow runs yet'}
          action={
            query.status ? (
              <ActionLink href={base} variant="secondary">
                Show all runs
              </ActionLink>
            ) : builder ? (
              <ActionLink href={`${base}/new`} variant="secondary">
                Start a workflow
              </ActionLink>
            ) : undefined
          }
        >
          {builder
            ? 'Start a published workflow, or install a ready-made one, and its progress appears here.'
            : 'When a workflow gives you a step to do, it appears here.'}
        </Empty>
      )}
      {builder && (
        <p className="muted gap-above-large">
          <Link href={`${base}/catalog`}>Ready-made workflows</Link> ·{' '}
          <Link href={`/o/${organizationId}/studio/workflows`}>Build your own workflow</Link>
        </p>
      )}
    </>
  );
}
