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
    <section className="fields" aria-labelledby="workflow-steps">
      <h2 id="workflow-steps">Workflow steps</h2>
      <ol className="fields">
        {run.steps.map((step) => (
          <li key={step.key} className="card fields">
            <div className="row">
              <h3>{step.label}</h3>
              <span
                className={`badge ${step.status === 'done' ? 'done' : step.status === 'failed' ? 'bad' : ''}`}
              >
                {stepStatusText(step.status)}
              </span>
            </div>
            <p className="muted">{stepKindNames[step.kind]}.</p>
            <p className="muted">
              {step.after.length
                ? `Waits for all: ${step.after.map((key) => run.steps.find((before) => before.key === key)?.label ?? 'Unavailable saved step').join('; ')}.`
                : 'No earlier step is required by this saved definition.'}
            </p>
            {step.stopCode && <p>{runCodeText(step.stopCode)}</p>}
            <ul>
              {step.workUnitId ? (
                <li>
                  <Link href={`${base}/work/${step.workUnitId}`}>Open this step’s work</Link>
                </li>
              ) : (
                <li>
                  {step.status === 'pending'
                    ? 'Work has not been created for this step yet.'
                    : 'No Work record was created for this step.'}
                </li>
              )}
              {step.approvalId && (
                <li>
                  <Link href={`${base}/approvals/${step.approvalId}`}>Open the exact approval</Link>
                </li>
              )}
              {step.externalActionId && (
                <li>
                  <Link href={`${base}/external-actions/${step.externalActionId}`}>
                    Open delivery and reconciliation
                  </Link>
                </li>
              )}
              {step.agentRunId && (
                <li>
                  <Link href={`${base}/assistants/${step.agentRunId}`}>
                    Open the actual assistant run
                  </Link>
                </li>
              )}
            </ul>
            {step.status === 'skipped' && (
              <p>This step was not performed after the workflow stopped.</p>
            )}
            {run.canManage &&
              liveRun(run.status) &&
              run.stopCode !== 'STOP_REQUESTED' &&
              step.kind === 'external_action' &&
              step.toolId === 'email.send' &&
              step.status === 'waiting' &&
              !step.externalActionId && (
                <details>
                  <summary>Write an email proposal for this step</summary>
                  <ProcessEmailForm
                    organizationId={organizationId}
                    runId={run.id}
                    stepKey={step.key}
                    requestKey={randomUUID()}
                  />
                </details>
              )}
            <details>
              <summary>Step record details</summary>
              <p>
                Saved step key: <code>{step.key}</code>
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
