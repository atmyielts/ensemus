// The pieces of the Assistants pages. Each takes a PresentedRun and never a DelegatedRun, so nothing a run
// carries can reach the page except through the words in present.ts.
import Link from 'next/link';
import { ConfirmForm } from '@/components/confirm-form';
import { ActionLink, formatDateTime } from '@/components/ui';
import { stopDelegatedRunAction } from '@/server/assistant-actions';
import type { PresentedRun, StopNotice } from './present';

export function RunBadge({ run }: { run: PresentedRun }) {
  return <span className={`badge ${run.badge.tone}`}>{run.badge.label}</span>;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** How much work it did, in words: rounds of thinking and the actions it took. */
const usageWords = (run: PresentedRun) =>
  `${plural(run.rounds, 'round of work', 'rounds of work')} and ${plural(run.actions, 'action', 'actions')}`;

/**
 * Said when the part that runs assistants cannot be reached from here. It is not an empty list, because nobody
 * here knows whether anything is running, and it is not an error, because nothing went wrong with the request.
 */
export function AssistantsUnavailable({
  subject,
  workHref,
}: {
  subject: 'list' | 'run';
  workHref: string;
}) {
  return (
    <section className="card" aria-labelledby="unavailable-heading">
      <h2 id="unavailable-heading">Assistants are not available here yet</h2>
      <p>
        {subject === 'list'
          ? 'Ensemus cannot read what assistants are doing here, so this page cannot say whether anything has been handed to one. That is different from nothing running.'
          : 'Ensemus cannot read this from here, or ask it to stop. That is different from it having stopped.'}
      </p>
      <p>
        Your work, approvals and everything else carry on as usual.{' '}
        <Link href={workHref}>Go to your work</Link>
      </p>
    </section>
  );
}

export function RunList({
  base,
  label,
  id,
  runs,
}: {
  base: string;
  label: string;
  id: string;
  runs: readonly PresentedRun[];
}) {
  return (
    <section className="card" aria-labelledby={id}>
      <h2 id={id}>{label}</h2>
      <ul className="list run-list">
        {runs.map((run) => (
          <li key={run.id}>
            <span className="run-summary">
              <Link href={`${base}/assistants/${run.id}`}>{run.workTitle}</Link>
              <span className="run-sentence">
                {run.agentName}. {run.sentence}
              </span>
              <small>
                {run.finishedAt ? (
                  <>Ended {formatDateTime(run.finishedAt)}</>
                ) : (
                  <>Started {formatDateTime(run.startedAt)}</>
                )}
                {run.cost && `. Cost ${run.cost}`}
              </small>
            </span>
            <span className="row run-side">
              <RunBadge run={run} />
              {run.canStop && (
                <Link
                  className="button ghost compact-action"
                  href={`${base}/assistants/${run.id}#stop-heading`}
                  aria-label={`Review and stop the assistant on ${run.workTitle}`}
                >
                  Review and stop
                </Link>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function StopNoticeLine({ notice }: { notice: StopNotice | null }) {
  if (!notice) return null;
  return notice.tone === 'error' ? (
    <p className="notice error" role="alert">
      {notice.text}
    </p>
  ) : (
    <p className="notice" role="status">
      {notice.text}
    </p>
  );
}

/** The summary beside the timeline: where it is, when, what it cost, and the work it belongs to. */
export function RunFacts({ run, workHref }: { run: PresentedRun; workHref: string }) {
  return (
    <section className="card" aria-labelledby="state-heading">
      <h2 id="state-heading">Where it has got to</h2>
      <p>
        <RunBadge run={run} />
      </p>
      <p className="run-state">{run.sentence}</p>
      <dl className="details gap-above">
        <div>
          <dt>Started</dt>
          <dd>{formatDateTime(run.startedAt)}</dd>
        </div>
        {run.finishedAt && (
          <div>
            <dt>Ended</dt>
            <dd>{formatDateTime(run.finishedAt)}</dd>
          </div>
        )}
        {run.cost && (
          <div>
            <dt>Cost</dt>
            <dd>{run.cost}</dd>
          </div>
        )}
        <div>
          <dt>Work it has done</dt>
          <dd>{usageWords(run)}</dd>
        </div>
      </dl>
      <p className="gap-above">
        <ActionLink href={workHref} variant="secondary">
          Open the work
        </ActionLink>
      </p>
    </section>
  );
}

/** Which form this is, for a screen reader, is in the summary. It works with no JavaScript. */
export function StopRun({ run, organizationId }: { run: PresentedRun; organizationId: string }) {
  if (run.finished && !run.canStop) return null;
  return (
    <section className="card" aria-labelledby="stop-heading">
      <h2 id="stop-heading">Stop it</h2>
      {run.canStop ? (
        <>
          <p className="muted">
            It finishes the step it is on, then does nothing more. Whatever it has already done
            stays done.
          </p>
          <ConfirmForm
            action={stopDelegatedRunAction}
            fields={
              <>
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="runId" value={run.id} />
              </>
            }
            summary="Stop this assistant"
            summaryLabel={`Stop the assistant on ${run.workTitle}`}
            consequence="Yes, ask it to stop. Whatever it has already done stays done."
            confirmLabel="Ask it to stop"
            confirmFullLabel={`Ask the assistant on ${run.workTitle} to stop`}
          />
        </>
      ) : (
        <p>This one cannot be stopped by you from here.</p>
      )}
    </section>
  );
}

/** What it did, step by step, as a timeline. The kind of thing it did, never what it wrote. */
export function RunSteps({ run }: { run: PresentedRun }) {
  return (
    <section className="card" aria-labelledby="steps-heading">
      <h2 id="steps-heading">What it has done</h2>
      <p className="muted">
        Each step says the kind of thing it did, and never what it wrote. The newest is last.
      </p>
      {run.steps.length === 0 ? (
        <p className="gap-above">No steps are recorded yet.</p>
      ) : (
        <ol className="step-timeline gap-above">
          {run.steps.map((step, index) => (
            <li key={index} className={step.tone ? `is-${step.tone}` : undefined}>
              <span className="step-what">
                {step.what}
                <small>{formatDateTime(step.at)}</small>
              </span>
              <span className={`badge ${step.tone}`}>{step.how}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Ids for someone looking into a run with support, kept out of the way of the story. */
export function RunTechnical({ run }: { run: PresentedRun }) {
  return (
    <details>
      <summary>Technical details</summary>
      <dl className="details gap-above">
        <div>
          <dt>Rounds of work</dt>
          <dd>{run.rounds}</dd>
        </div>
        <div>
          <dt>Actions taken</dt>
          <dd>{run.actions}</dd>
        </div>
        <div>
          <dt>Run reference</dt>
          <dd className="technical-reference">{run.id}</dd>
        </div>
        <div>
          <dt>Work reference</dt>
          <dd className="technical-reference">{run.workUnitId}</dd>
        </div>
      </dl>
    </details>
  );
}

/** Reads the run again. An ordinary form, so it works with no JavaScript and always asks the server. */
export function CheckAgain({ action, keepRequested }: { action: string; keepRequested: boolean }) {
  return (
    <form method="get" action={action}>
      {keepRequested && <input type="hidden" name="stop" value="requested" />}
      <button className="secondary" type="submit">
        Check again
      </button>
    </form>
  );
}
