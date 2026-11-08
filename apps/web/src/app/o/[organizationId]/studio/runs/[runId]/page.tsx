import { randomUUID } from 'node:crypto';
import { AppError } from '@ensemus/application';
import { getProcessRun } from '@ensemus/application/process-runs';
import Link from 'next/link';
import {
  ActionLink,
  BackLink,
  Empty,
  ErrorNotice,
  PageHead,
  formatDateTime,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { ProcessStepList } from '@/components/studio/process-step-list';
import { runStatusNames, runCodeText, runCostText, liveRun } from '@/lib/process-run-present';
import { requireTenant, orNotFound } from '@/server/tenant';
import { webProductPorts } from '@/server/product-ports';
import { stopWorkflowRunAction } from '@/server/process-run-actions';
export const metadata = { title: 'Workflow progress | Ensemus' };
export default async function ProcessRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; runId: string }>;
  searchParams: Promise<{ error?: string; stop?: string; proposal?: string }>;
}) {
  const { organizationId, runId } = await params,
    { database, context } = await requireTenant(organizationId),
    base = `/o/${organizationId}`,
    query = await searchParams;
  let run: Awaited<ReturnType<typeof getProcessRun>>;
  try {
    run = await orNotFound(getProcessRun(database, context, webProductPorts(), runId));
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE')) throw error;
    return (
      <>
        <BackLink href={`${base}/studio/runs`}>Workflow runs</BackLink>
        <PageHead title="Workflow history unavailable" />
        <Empty
          action={
            <ActionLink href={`${base}/studio/runs/${runId}`}>Refresh workflow status</ActionLink>
          }
        >
          We could not verify this workflow’s saved history. Ask an administrator to review it
          before continuing.
        </Empty>
      </>
    );
  }
  return (
    <OneActionAtATime>
      <BackLink href={`${base}/studio/runs`}>Workflow runs</BackLink>
      <PageHead
        title={run.title}
        description={`${run.processName} · Started ${formatDateTime(run.createdAt)}`}
        actions={
          <ActionLink href={`${base}/work/${run.rootWorkUnitId}`} variant="secondary">
            Open workflow work
          </ActionLink>
        }
      />
      <ErrorNotice code={query.error} />
      {query.proposal === 'saved' && (
        <p className="notice" role="status">
          The exact email proposal was saved for approval. Open its outside-action record for the
          latest approval and delivery state.
        </p>
      )}
      {query.stop === 'requested' && (
        <p className="notice" role="status">
          Your stop request is recorded. Refresh to follow the worker’s result; an outside action
          already in progress may still need reconciliation.
        </p>
      )}
      <section className="card fields" aria-labelledby="workflow-progress">
        <div className="row">
          <h2 id="workflow-progress">Current progress</h2>
          <span
            className={`badge ${run.status === 'failed' ? 'bad' : run.status === 'completed' ? 'done' : 'active'}`}
          >
            {runStatusNames[run.status]}
          </span>
        </div>
        {run.stopCode && <p className="notice">{runCodeText(run.stopCode)}</p>}
        <p>{runCostText(run.cost)}</p>
        {run.finishedAt && <p>Finished {formatDateTime(run.finishedAt)}.</p>}
        <p>
          <Link href={`${base}/studio/runs/${run.id}`}>Refresh workflow status</Link>
        </p>
      </section>
      <ProcessStepList organizationId={organizationId} run={run} />

      {run.canManage && liveRun(run.status) && run.stopCode !== 'STOP_REQUESTED' && (
        <section className="card fields" aria-labelledby="stop-workflow">
          <h2 id="stop-workflow">Stop further steps</h2>
          <p>
            A committed stop prevents the worker from starting another step. It does not recall an
            outside effect already in progress, and it never turns uncertain delivery into a known
            failure.
          </p>
          <form action={stopWorkflowRunAction} className="fields">
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="runId" value={run.id} />
            <input type="hidden" name="version" value={run.version} />
            <input type="hidden" name="requestKey" value={randomUUID()} />
            <label className="check">
              <input type="checkbox" name="confirmed" value="yes" required />I want to stop further
              steps and review any action already in progress.
            </label>
            <div>
              <SubmitButton className="danger" working="Recording the stop request">
                Request stop
              </SubmitButton>
            </div>
          </form>
        </section>
      )}
      <details>
        <summary>Workflow record details</summary>
        <p>
          Run identifier: <code>{run.id}</code>
        </p>
        <p>
          Saved definition identifier: <code>{run.specId}</code>
        </p>
        <p>Current record version: {run.version}</p>
        {run.stopCode && /^[A-Z][A-Z0-9_]{1,63}$/.test(run.stopCode) && (
          <p>
            Recorded code: <code>{run.stopCode}</code>
          </p>
        )}
      </details>
    </OneActionAtATime>
  );
}
