import { randomUUID } from 'node:crypto';
import { listDirectory } from '@ensemus/application';
import {
  decideControl,
  listRunnableAgents,
  mayControlRun,
  workStartRefusal,
} from '@ensemus/application/ai-run-control';
import { getRunTimeline, type RunSummary } from '@ensemus/application/ai-timeline';
import { RUN_CONTROL_KINDS, type RunControlKind } from '@ensemus/domain/ai';
import { can } from '@ensemus/domain/policy';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SubmitButton } from '@/components/submit-button';
import {
  BackLink,
  ClassificationBadge,
  Empty,
  ErrorNotice,
  formatDateTime,
  PageHead,
} from '@/components/ui';
import { orNotFound, requireTenant } from '@/server/tenant';
import { controlRunAction, startRunAction } from './actions';
import {
  costLine,
  isLiveStatus,
  pendingNote,
  runSignature,
  runStatusWords,
  stepLabel,
  stepNote,
  stepStateWords,
  stopReason,
} from './run-view';
import { RunWatcher } from './run-watcher';
import { RunLoading } from './run-loading';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metadata: Metadata = { title: 'Assistant activity | Ensemus' };

const CONTROL_LABEL: Record<RunControlKind, string> = {
  stop: 'Stop this run',
  pause: 'Pause',
  resume: 'Resume',
};

const when = (iso: string) => formatDateTime(new Date(iso));

function RunBadge({ status }: { status: string }) {
  const { label, tone } = runStatusWords(status);
  return <span className={`badge ${tone}`}>{label}</span>;
}

function StartForm({
  organizationId,
  workUnitId,
  agents,
  again,
}: {
  organizationId: string;
  workUnitId: string;
  agents: readonly { versionId: string; name: string; versionNumber: number }[];
  again: boolean;
}) {
  return (
    <form className="fields" action={startRunAction}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="workUnitId" value={workUnitId} />
      <input type="hidden" name="requestKey" value={randomUUID()} />
      <label>
        Assistant
        <select name="agentVersionId" required>
          {agents.map((agent) => (
            <option key={agent.versionId} value={agent.versionId}>
              {agent.name} (version {agent.versionNumber})
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        It works with your access and no more, within the limits set when it was published. Anything
        it wants to send outside Ensemus needs someone’s approval first.
      </p>
      <div>
        <SubmitButton working="Starting">{again ? 'Start a new run' : 'Start a run'}</SubmitButton>
      </div>
    </form>
  );
}

function RunFacts({ run, startedBy }: { run: RunSummary; startedBy: string }) {
  const { view } = run;
  const cost = costLine(view.cost_micros, view.cost_is_estimate);
  return (
    <dl className="facts">
      <div>
        <dt>Status</dt>
        <dd>
          <RunBadge status={view.status} />
        </dd>
      </div>
      <div>
        <dt>Assistant</dt>
        <dd>
          {run.agentName} (version {run.versionNumber})
        </dd>
      </div>
      <div>
        <dt>Started by</dt>
        <dd>{startedBy}</dd>
      </div>
      <div>
        <dt>Who can see what it has read</dt>
        <dd>
          <ClassificationBadge value={view.effective_classification} />
        </dd>
      </div>
      <div>
        <dt>{cost.label}</dt>
        <dd>
          {cost.amount}
          {cost.note && <span className="muted"> {cost.note}</span>}
        </dd>
      </div>
      <div>
        <dt>Requested</dt>
        <dd>{when(view.created_at)}</dd>
      </div>
      {view.ended_at && (
        <div>
          <dt>Ended</dt>
          <dd>{when(view.ended_at)}</dd>
        </div>
      )}
    </dl>
  );
}

/** Counts a builder looks for, kept out of the way of everyone else. */
function RunCounts({ run }: { run: RunSummary }) {
  const { view } = run;
  return (
    <details className="gap-above">
      <summary>Technical details</summary>
      <dl className="facts gap-above">
        <div>
          <dt>Model steps</dt>
          <dd>{view.model_turns}</dd>
        </div>
        <div>
          <dt>Tool uses</dt>
          <dd>{view.tool_calls}</dd>
        </div>
        <div>
          <dt>Tokens in and out</dt>
          <dd>
            {view.input_tokens} in, {view.output_tokens} out
          </dd>
        </div>
      </dl>
    </details>
  );
}

export default async function AgentRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; workUnitId: string }>;
  searchParams: Promise<{ error?: string; run?: string }>;
}) {
  const { organizationId, workUnitId } = await params;
  const { error, run: askedFor } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  if (!UUID.test(workUnitId)) notFound();
  if (askedFor !== undefined && !UUID.test(askedFor)) notFound();
  const timeline = await orNotFound(
    getRunTimeline(database, context, workUnitId, askedFor ? { runId: askedFor } : {}),
  );
  // Refusals must resolve before a streaming boundary commits HTTP headers. Secondary display queries
  // can stream after the tenant, work and selected run have all been authorized.
  return (
    <Suspense fallback={<RunLoading />}>
      <AgentRunContent
        organizationId={organizationId}
        error={error}
        tenant={{ context, database }}
        timeline={timeline}
      />
    </Suspense>
  );
}

async function AgentRunContent({
  organizationId,
  error,
  tenant,
  timeline,
}: {
  organizationId: string;
  error: string | undefined;
  tenant: Pick<Awaited<ReturnType<typeof requireTenant>>, 'context' | 'database'>;
  timeline: Awaited<ReturnType<typeof getRunTimeline>>;
}) {
  const { context, database } = tenant;
  const { work, runs, selected, steps, latestControl } = timeline;

  const page = `/o/${organizationId}/work/${work.id}/run`;
  const anyLive = runs.some((run) => isLiveStatus(run.view.status));
  const mayStart =
    can(context.role, 'agent.run') &&
    timeline.canChangeWork &&
    !anyLive &&
    workStartRefusal(work) === null;
  const [agents, members] = await Promise.all([
    mayStart ? listRunnableAgents(database, context) : [],
    selected ? listDirectory(database, context) : [],
  ]);
  const startedBy = selected
    ? (members.find((member) => member.membershipId === selected.initiatorMembershipId)?.name ??
      'Someone no longer here')
    : '';

  const live = selected ? isLiveStatus(selected.view.status) : false;
  const newest = runs[0]?.view.id;
  const latest = selected?.view.id === newest ? selected : null;
  const words = selected ? runStatusWords(selected.view.status) : null;
  const pending = selected ? pendingNote(selected.view.status, latestControl) : null;
  const controls = selected
    ? RUN_CONTROL_KINDS.filter(
        (kind) =>
          mayControlRun(context, selected, kind) &&
          decideControl(selected.view.status, latestControl, kind) === 'record',
      )
    : [];
  const earlier = runs.filter((run) => run.view.id !== selected?.view.id);
  const start = mayStart ? (
    agents.length > 0 ? (
      <StartForm
        organizationId={organizationId}
        workUnitId={work.id}
        agents={agents}
        again={runs.length > 0}
      />
    ) : (
      <p className="muted">
        No assistant has been published yet, so there is nothing to start. Someone who manages
        assistants has to publish one first.
      </p>
    )
  ) : null;

  return (
    <>
      <BackLink href={`/o/${organizationId}/work/${work.id}`}>Back to the work</BackLink>
      <PageHead
        title="Assistant activity"
        description={`What assistants have done on “${work.title}”, and starting a new run.`}
      />
      <ErrorNotice code={error} />
      <div className="stack">
        {selected && words ? (
          <section className="card" aria-labelledby="run-heading">
            <h2 id="run-heading">
              {live ? 'This run' : selected === latest ? 'Last run' : 'An earlier run'}
            </h2>
            {live && (
              <RunWatcher
                runUrl={`/api/v1/organizations/${organizationId}/agent-runs/${selected.view.id}`}
                stepsUrl={`/api/v1/organizations/${organizationId}/agent-runs/${selected.view.id}/steps`}
                signature={runSignature(selected.view, steps)}
              />
            )}
            <p>{words.note}</p>
            {selected.view.stop_code && <p>{stopReason(selected.view.stop_code)}</p>}
            {pending && (
              <p className="notice warn" role="status">
                {pending}
              </p>
            )}
            <RunFacts run={selected} startedBy={startedBy} />
            <RunCounts run={selected} />
            {controls.length > 0 && (
              <div className="row gap-above">
                {controls.map((kind) => (
                  <form key={kind} action={controlRunAction}>
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="workUnitId" value={work.id} />
                    <input type="hidden" name="agentRunId" value={selected.view.id} />
                    <input type="hidden" name="kind" value={kind} />
                    <SubmitButton
                      className={kind === 'stop' ? 'danger' : 'secondary'}
                      working="Recording that"
                    >
                      {CONTROL_LABEL[kind]}
                    </SubmitButton>
                  </form>
                ))}
              </div>
            )}
            {live && (
              <p className="muted gap-above">
                This page keeps itself up to date. <Link href={page}>Check again</Link>
              </p>
            )}
          </section>
        ) : (
          <Empty title="Nothing has run yet">
            No assistant has run on this work yet.
            {start ? ' You can start one below.' : ''}
          </Empty>
        )}

        {selected && (
          <section className="card" aria-labelledby="steps-heading">
            <h2 id="steps-heading">What it did</h2>
            <p className="muted">
              This shows what kind of step each one was. What the model read and wrote is not kept
              here, and it is deleted when the run ends.
            </p>
            {steps.length === 0 ? (
              <Empty>No steps yet.</Empty>
            ) : (
              <ol className="list">
                {steps.map((step) => {
                  const note = stepNote(step);
                  return (
                    <li key={step.step_number} className="block">
                      <div className="row">
                        <span>{stepLabel(step.label_code)}</span>
                        <span className="muted">{stepStateWords(step.state, live)}</span>
                        <span className="muted">{when(step.started_at)}</span>
                      </div>
                      {note && <p className="muted">{note}</p>}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        )}

        {start && (
          <section className="card" aria-labelledby="start-heading">
            <h2 id="start-heading">{runs.length > 0 ? 'Try again' : 'Start'}</h2>
            {start}
          </section>
        )}

        {earlier.length > 0 && (
          <section className="card" aria-labelledby="earlier-heading">
            <h2 id="earlier-heading">Other runs on this work</h2>
            <ul className="list">
              {earlier.map((run) => (
                <li key={run.view.id}>
                  <Link href={`${page}?run=${run.view.id}`}>
                    {run.agentName}, requested {when(run.view.created_at)}
                  </Link>
                  <RunBadge status={run.view.status} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
