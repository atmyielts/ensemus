import { AppError } from '@ensemus/application';
import { getSimulation } from '@ensemus/application/simulations';
import { getAgentDraft } from '@ensemus/application/agent-drafts';
import { getProcessDraft } from '@ensemus/application/process-specs';
import { findBundledWorkflow } from '@ensemus/packs/bundled';
import Link from 'next/link';
import {
  ActionLink,
  BackLink,
  Empty,
  PageHead,
  StatusBadge,
  formatDateTime,
} from '@/components/ui';
import { requireStudio, studioRead } from '@/server/studio-pages';
import { webProductPorts } from '@/server/product-ports';
import { studioScenarioName, studioToolName } from '@/lib/studio-present';

export const metadata = { title: 'Rehearsal report | Ensemus' };
export default async function SimulationPage({
  params,
}: {
  params: Promise<{ organizationId: string; simulationId: string }>;
}) {
  const { organizationId, simulationId } = await params;
  const { database, context } = await requireStudio(organizationId);
  const run = await studioRead(getSimulation(database, context, simulationId));
  const base = `/o/${organizationId}/studio`;
  let parent = base,
    parentLabel = 'Automation Studio',
    currentHash: string | null = null,
    currentUnavailable = false;
  const stepLabels: Record<string, string> = {};
  if (run.subjectKind === 'agent_draft' && run.subjectId) {
    const current = await studioRead(getAgentDraft(database, context, run.subjectId));
    parent = `${base}/agents/${current.id}`;
    parentLabel = 'Assistant draft';
    currentHash = current.specSha256;
  } else if (run.subjectKind === 'process_draft' && run.subjectId) {
    try {
      const current = await studioRead(
        getProcessDraft(database, context, webProductPorts(), run.subjectId),
      );
      parent = `${base}/workflows/${current.id}`;
      parentLabel = 'Workflow draft';
      currentHash = current.specSha256;
      if (current.issues.length) currentUnavailable = true;
      else if (currentHash === run.subjectSha256)
        for (const node of current.graph.nodes) stepLabels[node.id] = node.label;
    } catch (error) {
      if (
        error instanceof AppError &&
        ['CAPABILITY_UNAVAILABLE', 'GRAPH_INVALID', 'DRAFT_INVALID'].includes(error.code)
      )
        currentUnavailable = true;
      else throw error;
    }
  } else if (run.subjectKind === 'bundled_workflow') {
    parent = `/o/${organizationId}/get-started`;
    parentLabel = 'Company setup';
    const bundle = run.subjectKey ? findBundledWorkflow(run.subjectKey) : undefined;
    // Catalog labels can change; use the saved report's generic step numbering instead of inventing a
    // historical name from today's module. The setup DAL separately validates the current exact hash.
    if (bundle) parentLabel = 'Company setup and the current catalog';
  }
  const report = run.report;
  const reportMatches =
    report?.subjectSha256 === run.subjectSha256 && report.scenarioKey === run.scenarioKey;
  const usable = Boolean(
    reportMatches &&
    ((run.status === 'passed' && report?.outcome === 'passed') ||
      (run.status === 'failed' && report?.outcome === 'failed')),
  );
  const status = run.status === 'passed' && !usable ? 'errored' : run.status;
  const stale =
    !currentUnavailable &&
    run.subjectKind !== 'bundled_workflow' &&
    currentHash !== run.subjectSha256;
  const waiting = run.status === 'queued' || run.status === 'running';
  const decisionLabel = {
    allowed: 'Allowed',
    needs_approval: 'Would wait for a person to approve',
    denied: 'Stopped by a rule',
    would_write_outside: 'Would propose a change outside Ensemus',
  };
  return (
    <>
      <BackLink href={parent}>{parentLabel}</BackLink>
      <PageHead title="Rehearsal report" description={studioScenarioName(run.scenarioKey)} />
      <p className="notice">
        This was a practice run with made-up examples. No AI model was called, nothing was sent and
        nothing outside Ensemus changed.
      </p>
      {stale && (
        <p className="notice warn">
          The draft has changed since this rehearsal, so it says nothing about the current version.
          Go back to the draft and rehearse it again.
        </p>
      )}
      {currentUnavailable && (
        <p className="notice warn">
          The current workflow could not be checked here. This report is history only and does not
          make the workflow ready to publish.
        </p>
      )}
      <div className="detail-layout">
        <div className="stack">
          {waiting ? (
            <section className="card" aria-labelledby="rehearsal-waiting">
              <h2 id="rehearsal-waiting">
                {run.status === 'queued' ? 'Waiting to start' : 'The rehearsal is running'}
              </h2>
              <p className="muted">
                There is no result yet. Refresh in a moment; a rehearsal that has not finished never
                counts as passed.
              </p>
              <p className="link-line gap-above">
                <Link href={`${base}/simulations/${run.id}`}>Refresh this report</Link>
              </p>
            </section>
          ) : usable && report ? (
            <section className="card" aria-labelledby="rehearsal-outcome">
              <h2 id="rehearsal-outcome">
                {report.outcome === 'passed'
                  ? 'The rehearsal passed'
                  : 'The rehearsal found problems'}
              </h2>
              <p className="muted">
                {report.outcome === 'passed'
                  ? 'Every step behaved as your rules say it should. Some steps are meant to be stopped, such as a hostile instruction hidden in a document.'
                  : 'At least one step did not behave as your rules say it should. Look at the draft again before you rehearse it once more.'}
              </p>
              <dl className="facts gap-above">
                <div>
                  <dt>Approvals it would need</dt>
                  <dd>{report.approvalsNeeded}</dd>
                </div>
                <div>
                  <dt>Model replies</dt>
                  <dd>
                    {report.limits.turnsUsed} of {report.limits.turnsAllowed}
                  </dd>
                </div>
                <div>
                  <dt>Ability uses</dt>
                  <dd>
                    {report.limits.toolCallsUsed} of {report.limits.toolCallsAllowed}
                  </dd>
                </div>
              </dl>
              <h3 className="gap-above-large">Step by step</h3>
              <ol className="list" aria-label="Synthetic rehearsal steps">
                {report.steps.map((step) => (
                  <li key={step.index}>
                    <span>
                      <strong>
                        {step.subject === 'model'
                          ? 'The AI model answers'
                          : step.subject === 'finish'
                            ? 'Finish, with what shows it is done'
                            : (stepLabels[step.subject] ??
                              (studioToolName(step.subject) !== step.subject
                                ? studioToolName(step.subject)
                                : `Step ${step.index + 1}`))}
                      </strong>
                      <br />
                      <small>
                        {step.subject === 'model'
                          ? 'Played by a script; no real model was called'
                          : decisionLabel[step.decision]}
                      </small>
                    </span>
                  </li>
                ))}
              </ol>
              <h3 className="gap-above-large">Changes outside Ensemus</h3>
              {report.wouldWriteOutside.length ? (
                <>
                  <p className="muted">These were only described; none was carried out.</p>
                  <ul>
                    {report.wouldWriteOutside.map((tool, index) => (
                      <li key={`${index}-${tool}`}>{studioToolName(tool)}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted">None.</p>
              )}
            </section>
          ) : (
            <Empty
              title="No usable result"
              action={
                <ActionLink href={parent} variant="secondary">
                  Back to the draft
                </ActionLink>
              }
            >
              The result is missing, incomplete or does not match this version, so it does not count
              as passed. Rehearse the draft again.
            </Empty>
          )}
        </div>

        <aside className="card" aria-labelledby="rehearsal-summary">
          <div className="spread">
            <h2 id="rehearsal-summary">Summary</h2>
            <StatusBadge status={status} />
          </div>
          <dl className="details gap-above-small">
            <div>
              <dt>Requested</dt>
              <dd>{formatDateTime(run.createdAt)}</dd>
            </div>
            {run.finishedAt && (
              <div>
                <dt>Finished</dt>
                <dd>{formatDateTime(run.finishedAt)}</dd>
              </div>
            )}
          </dl>
          <ul className="studio-links divided">
            <li className="link-line">
              <Link href={`${base}/simulations/${run.id}`}>Refresh the report</Link>
            </li>
            <li className="link-line">
              <Link href={parent}>Return to {parentLabel.toLowerCase()}</Link>
            </li>
          </ul>
          <details className="divided">
            <summary>Technical details</summary>
            <dl className="details gap-above-small">
              <div>
                <dt>Version fingerprint</dt>
                <dd>
                  <code>{run.subjectSha256}</code>
                </dd>
              </div>
              <div>
                <dt>Example</dt>
                <dd>
                  <code>{run.scenarioKey}</code>
                </dd>
              </div>
              <div>
                <dt>Stored status</dt>
                <dd>
                  <code>{run.status}</code>
                </dd>
              </div>
              {run.outcomeCode && (
                <div>
                  <dt>Outcome code</dt>
                  <dd>
                    <code>{run.outcomeCode}</code>
                  </dd>
                </div>
              )}
            </dl>
            {report && (
              <>
                <h3 className="gap-above">Rule codes</h3>
                <ul>
                  {report.steps.map((step) => (
                    <li key={step.index}>
                      <code>
                        {step.subject}: {step.reasonCode}
                      </code>
                    </li>
                  ))}
                </ul>
                {report.failureCodes.length > 0 && (
                  <ul>
                    {report.failureCodes.map((code, index) => (
                      <li key={`${index}-${code}`}>
                        <code>{code}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </details>
        </aside>
      </div>
    </>
  );
}
