// The pieces of the Assistants pages. Each takes a PresentedRun and never a DelegatedRun, so nothing a run
// carries can reach the page except through the words in present.ts.
import Link from 'next/link';
import { ConfirmForm } from '@/components/confirm-form';
import { formatDateTime } from '@/components/ui';
import { stopDelegatedRunAction } from '@/server/assistant-actions';
import type { PresentedRun, StopNotice } from './present';

export function RunBadge({ run }: { run: PresentedRun }) {
  return <span className={`badge ${run.badge.tone}`}>{run.badge.label}</span>;
}

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
      <h2 id="unavailable-heading">Assistants are not available on this deployment yet</h2>
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
      <ul className="list">
        {runs.map((run) => (
          <li key={run.id}>
            <span>
              <Link href={`${base}/assistants/${run.id}`}>{run.workTitle}</Link>
              <br />
              <small>
                {run.agentName}. {run.sentence}
              </small>
              <br />
              <small className="muted">
                {run.finishedAt
                  ? `Ended ${formatDateTime(run.finishedAt)}`
                  : `Started ${formatDateTime(run.startedAt)}`}
                {run.cost && `. Cost ${run.cost}`}
              </small>
            </span>
            <span className="row">
              {run.canStop && (
                <Link
                  href={`${base}/assistants/${run.id}#stop-heading`}
                  aria-label={`Review and stop the assistant on ${run.workTitle}`}
                >
                  Review and stop
                </Link>
              )}
              <RunBadge run={run} />
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

export function RunFacts({ run, workHref }: { run: PresentedRun; workHref: string }) {
  return (
    <section className="card" aria-labelledby="state-heading">
      <h2 id="state-heading">Where it has got to</h2>
      <p>
        <RunBadge run={run} /> {run.sentence}
      </p>
      <dl className="facts">
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
        <div>
          <dt>Rounds of work</dt>
          <dd>{run.rounds}</dd>
        </div>
        <div>
          <dt>Actions taken</dt>
          <dd>{run.actions}</dd>
        </div>
        {run.cost && (
          <div>
            <dt>Cost</dt>
            <dd>{run.cost}</dd>
          </div>
        )}
      </dl>
      <p className="gap-above">
        <Link href={workHref}>Open the work</Link> to see what came of it.
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
      ) : (
        <p>This one cannot be stopped by you from here.</p>
      )}
    </section>
  );
}

export function RunSteps({ run }: { run: PresentedRun }) {
  return (
    <section className="card" aria-labelledby="steps-heading">
      <h2 id="steps-heading">What it has done</h2>
      <p className="muted">
        This shows the kind of thing it did at each step, and never what it wrote.
      </p>
      {run.steps.length === 0 ? (
        <p>No steps are recorded yet.</p>
      ) : (
        <ol className="list">
          {run.steps.map((step, index) => (
            <li key={index}>
              <span>
                {step.what}
                <br />
                <small className="muted">{formatDateTime(step.at)}</small>
              </span>
              <span className="badge">{step.how}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Reads the run again. An ordinary form, so it works with no JavaScript and always asks the server. */
export function CheckAgain({
  action,
  keepRequested,
}: {
  action: string;
  keepRequested: boolean;
}) {
  return (
    <form method="get" action={action}>
      {keepRequested && <input type="hidden" name="stop" value="requested" />}
      <button className="quiet" type="submit">
        Check again
      </button>
    </form>
  );
}
