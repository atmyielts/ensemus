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
  const tone =
    run.status === 'failed'
      ? 'bad'
      : run.status === 'completed'
        ? 'done'
        : run.status === 'cancelled'
          ? ''
          : 'active';
  return (
    <OneActionAtATime>
      <BackLink href={`${base}/studio/runs`}>Workflow runs</BackLink>
      <PageHead
        title={run.title}
        description={
          <>
            {run.processName} · Started {formatDateTime(run.createdAt)}
          </>
        }
        actions={
          <ActionLink href={`${base}/work/${run.rootWorkUnitId}`} variant="secondary">
            Open workflow work
          </ActionLink>
        }
      />
      <ErrorNotice code={query.error} />
      {query.proposal === 'saved' && (
        <p className="notice good" role="status">
          The email was saved and is waiting for approval. Open the step’s outside action to follow
          its approval and delivery.
        </p>
      )}
      {query.stop === 'requested' && (
        <p className="notice" role="status">
          Your stop request is recorded. Refresh to see when the workflow has stopped; an action
          already under way outside Ensemus may still need checking.
        </p>
      )}
      <div className="detail-layout">
        <ProcessStepList organizationId={organizationId} run={run} />

        <aside className="card" aria-labelledby="workflow-progress">
          <div className="spread">
            <h2 id="workflow-progress">Progress</h2>
            <span className={`badge ${tone}`}>{runStatusNames[run.status]}</span>
          </div>
          {run.stopCode && <p className="notice gap-above">{runCodeText(run.stopCode)}</p>}
          <dl className="details gap-above-small">
            <div>
              <dt>Started</dt>
              <dd>{formatDateTime(run.createdAt)}</dd>
            </div>
            {run.finishedAt && (
              <div>
                <dt>Finished</dt>
                <dd>{formatDateTime(run.finishedAt)}</dd>
              </div>
            )}
            <div>
              <dt>Cost</dt>
              <dd>{runCostText(run.cost)}</dd>
            </div>
          </dl>
          <p className="link-line divided">
            <Link href={`${base}/studio/runs/${run.id}`}>Refresh workflow status</Link>
          </p>
          {run.canManage && liveRun(run.status) && run.stopCode !== 'STOP_REQUESTED' && (
            <section className="divided" aria-labelledby="stop-workflow">
              <h3 id="stop-workflow">Stop further steps</h3>
              <p className="muted">
                <small>
                  No new step will start. Something already under way outside Ensemus is not called
                  back, and an unclear delivery is never marked as failed.
                </small>
              </p>
              <form action={stopWorkflowRunAction} className="fields gap-above-small">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="runId" value={run.id} />
                <input type="hidden" name="version" value={run.version} />
                <input type="hidden" name="requestKey" value={randomUUID()} />
                <label className="check">
                  <input type="checkbox" name="confirmed" value="yes" required />I want to stop
                  further steps and review any action already in progress.
                </label>
                <div>
                  <SubmitButton className="danger" working="Recording the stop request">
                    Request stop
                  </SubmitButton>
                </div>
              </form>
            </section>
          )}
          <details className="divided">
            <summary>Technical details</summary>
            <p className="gap-above-small">
              Run identifier: <code>{run.id}</code>
            </p>
            <p>
              Workflow version identifier: <code>{run.specId}</code>
            </p>
            <p>Record version: {run.version}</p>
            {run.stopCode && /^[A-Z][A-Z0-9_]{1,63}$/.test(run.stopCode) && (
              <p>
                Recorded code: <code>{run.stopCode}</code>
              </p>
            )}
          </details>
        </aside>
      </div>
    </OneActionAtATime>
  );
}
