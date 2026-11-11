import { randomUUID } from 'node:crypto';
import type { ProcessRunView } from '@ensemus/application/process-runs';
import Link from 'next/link';
import { ProcessEmailForm } from './process-email-form';
import { stepStatusText, stepKindNames, runCodeText, liveRun } from '@/lib/process-run-present';
export function ProcessStepList({
  organizationId,
  run,
}: {
  organizationId: string;
  run: ProcessRunView;
}) {
  const base = `/o/${organizationId}`;
  return (
    <section className="card" aria-labelledby="workflow-steps">
      <h2 id="workflow-steps">Workflow steps</h2>
      <ol className="list">
        {run.steps.map((step) => (
          <li key={step.key} className="block">
            <div className="spread">
              <h3>{step.label}</h3>
              <span
                className={`badge ${step.status === 'done' ? 'done' : step.status === 'failed' ? 'bad' : step.status === 'waiting' ? 'active' : ''}`}
              >
                {stepStatusText(step.status)}
              </span>
            </div>
            <small>
              {stepKindNames[step.kind]} ·{' '}
              {step.after.length
                ? `Waits for ${step.after.map((key) => run.steps.find((before) => before.key === key)?.label ?? 'a step that is no longer listed').join('; ')}`
                : 'First step'}
            </small>
            {step.stopCode && (
              <p className="notice gap-above-small">{runCodeText(step.stopCode)}</p>
            )}
            {step.status === 'skipped' && (
              <p className="muted gap-above-small">
                This step did not happen because the workflow stopped.
              </p>
            )}
            <ul className="studio-links gap-above-small">
              {step.workUnitId ? (
                <li className="link-line">
                  <Link href={`${base}/work/${step.workUnitId}`}>Open this step’s work</Link>
                </li>
              ) : (
                <li className="muted">
                  <small>
                    {step.status === 'pending'
                      ? 'Its work is created when the step starts.'
                      : 'No work was created for this step.'}
                  </small>
                </li>
              )}
              {step.approvalId && (
                <li className="link-line">
                  <Link href={`${base}/approvals/${step.approvalId}`}>Open the exact approval</Link>
                </li>
              )}
              {step.externalActionId && (
                <li className="link-line">
                  <Link href={`${base}/external-actions/${step.externalActionId}`}>
                    Open the outside action and its delivery
                  </Link>
                </li>
              )}
              {step.agentRunId && (
                <li className="link-line">
                  <Link href={`${base}/assistants/${step.agentRunId}`}>
                    Open the assistant’s activity
                  </Link>
                </li>
              )}
            </ul>
            {run.canManage &&
              liveRun(run.status) &&
              run.stopCode !== 'STOP_REQUESTED' &&
              step.kind === 'external_action' &&
              step.toolId === 'email.send' &&
              step.status === 'waiting' &&
              !step.externalActionId && (
                <details className="gap-above-small">
                  <summary>Write the email for this step</summary>
                  <ProcessEmailForm
                    organizationId={organizationId}
                    runId={run.id}
                    stepKey={step.key}
                    requestKey={randomUUID()}
                  />
                </details>
              )}
            <details className="gap-above-small">
              <summary>Technical details</summary>
              <p className="gap-above-small">
                Step key: <code>{step.key}</code>
              </p>
              {step.stopCode && /^[A-Z][A-Z0-9_]{1,63}$/.test(step.stopCode) && (
                <p>
                  Recorded code: <code>{step.stopCode}</code>
                </p>
              )}
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
