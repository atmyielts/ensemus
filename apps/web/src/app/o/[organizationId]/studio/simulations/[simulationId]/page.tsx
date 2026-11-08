import { AppError } from '@ensemus/application';
import { getSimulation } from '@ensemus/application/simulations';
import { getAgentDraft } from '@ensemus/application/agent-drafts';
import { getProcessDraft } from '@ensemus/application/process-specs';
import { findBundledWorkflow } from '@ensemus/packs/bundled';
import Link from 'next/link';
import { BackLink, Empty, PageHead, StatusBadge, formatDateTime } from '@/components/ui';
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
    allowed: 'Would be permitted',
    needs_approval: 'Would wait for a person',
    denied: 'Would be blocked by a rule',
    would_write_outside: 'Would propose an outside change',
  };
  return (
    <>
      <BackLink href={parent}>{parentLabel}</BackLink>
      <PageHead title="Rehearsal report" description={studioScenarioName(run.scenarioKey)} />
      <p className="notice">
        Synthetic rule check only. No real model was called, no email was sent and no outside action
        was performed. Passing this rehearsal is not model or provider qualification.
      </p>
      <div className="row">
        <StatusBadge status={status} />
        <p className="muted">
          Requested {formatDateTime(run.createdAt)}
          {run.finishedAt ? ` · Finished ${formatDateTime(run.finishedAt)}` : ''}
        </p>
      </div>
      {stale && (
        <p className="notice">
          The draft has changed since this snapshot. This historical report cannot establish
          readiness for its current definition. Return to the draft and rehearse its saved snapshot.
        </p>
      )}
      {currentUnavailable && (
        <p className="notice">
          The current workflow definition could not be assessed here. This report is historical
          only; it does not establish current publication readiness.
        </p>
      )}
      {waiting ? (
        <section className="card fields">
          <h2>
            {run.status === 'queued'
              ? 'Waiting for the rehearsal worker'
              : 'The rehearsal is in progress'}
          </h2>
          <p>No result is available yet. A request is not a passing report.</p>
          <Link href={`${base}/simulations/${run.id}`}>Refresh this report</Link>
        </section>
      ) : usable && report ? (
        <>
          <section className="card fields" aria-labelledby="rehearsal-outcome">
            <h2 id="rehearsal-outcome">
              {report.outcome === 'passed'
                ? 'The fixed scenario passed'
                : 'The fixed scenario needs attention'}
            </h2>
            <p>
              {report.outcome === 'passed'
                ? 'The scripted steps met the expected policy behavior. A blocked hostile instruction can be the expected result.'
                : 'One or more scripted checks did not meet the expected policy behavior. Review the saved definition before requesting another rehearsal.'}
            </p>
            <dl className="details">
              <div>
                <dt>Approvals that would be needed</dt>
                <dd>{report.approvalsNeeded}</dd>
              </div>
              <div>
                <dt>Scripted turns</dt>
                <dd>
                  {report.limits.turnsUsed} of {report.limits.turnsAllowed}
                </dd>
              </div>
              <div>
                <dt>Scripted tool calls</dt>
                <dd>
                  {report.limits.toolCallsUsed} of {report.limits.toolCallsAllowed}
                </dd>
              </div>
            </dl>
            <h3>What the scenario checked</h3>
            <ol className="list" aria-label="Synthetic rehearsal steps">
              {report.steps.map((step) => (
                <li key={step.index}>
                  <div>
                    <strong>
                      {step.subject === 'model'
                        ? 'Model call'
                        : step.subject === 'finish'
                          ? 'Finish with evidence'
                          : (stepLabels[step.subject] ??
                            (studioToolName(step.subject) !== step.subject
                              ? studioToolName(step.subject)
                              : `Configured step ${step.index + 1}`))}
                    </strong>
                    <p>
                      {step.subject === 'model'
                        ? 'The real model was not called'
                        : decisionLabel[step.decision]}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <h3>Outside actions considered</h3>
            {report.wouldWriteOutside.length ? (
              <>
                <p>These actions were described by the script only; none was performed.</p>
                <ul>
                  {report.wouldWriteOutside.map((tool, index) => (
                    <li key={`${index}-${tool}`}>{studioToolName(tool)}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>The script recorded no outside writes.</p>
            )}
          </section>
        </>
      ) : (
        <Empty title="No usable finished report">
          The stored result is absent, incomplete or inconsistent with this snapshot. Return to the
          draft to request a fresh rehearsal. An incomplete result never counts as passed.
        </Empty>
      )}
      <details>
        <summary>Snapshot and diagnostic details</summary>
        <dl className="details">
          <div>
            <dt>Snapshot hash</dt>
            <dd>
              <code>{run.subjectSha256}</code>
            </dd>
          </div>
          <div>
            <dt>Scenario</dt>
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
            <h3>Recorded rule codes</h3>
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
      <p>
        <Link href={`${base}/simulations/${run.id}`}>Refresh the report</Link> ·{' '}
        <Link href={parent}>Return to {parentLabel.toLowerCase()}</Link>
      </p>
    </>
  );
}
