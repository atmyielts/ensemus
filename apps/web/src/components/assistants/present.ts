// What the Assistants pages may show, worked out with no React and no request, so all of it can be tested
// without a browser (tests/unit/assistants-wording.test.ts). The pages render a PresentedRun and never a
// DelegatedRun: anything a run carries that is not named here cannot reach a page, and a code only ever comes
// out as words chosen here, so neither a new code nor a stray string from a model can be shown as it stands.
import { describeRunStatus, isRunFinished } from '@ensemus/application/assistants';
import type { DelegatedRun } from '@ensemus/application/product-ports';

export type PresentedStep = { what: string; how: string; at: Date };

export type PresentedRun = {
  id: string;
  workUnitId: string;
  workTitle: string;
  agentName: string;
  sentence: string;
  badge: { label: string; tone: string };
  finished: boolean;
  canStop: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  rounds: number;
  actions: number;
  cost: string | null;
  steps: readonly PresentedStep[];
};

// Maps, because a plain object also answers for keys like __proto__, and handing those to React crashes the
// page. ui.tsx's StatusBadge is not used here: it repeats a status it does not know, and these are not its
// statuses.
const BADGES = new Map<string, { label: string; tone: string }>([
  ['queued', { label: 'Waiting to start', tone: '' }],
  ['preparing', { label: 'Getting ready', tone: 'active' }],
  ['running', { label: 'In progress', tone: 'active' }],
  ['paused', { label: 'On hold', tone: 'attention' }],
  ['waiting_for_approval', { label: 'Waiting for approval', tone: 'attention' }],
  ['waiting_for_child', { label: 'Waiting on another assistant', tone: 'active' }],
  ['verifying', { label: 'Checking', tone: 'active' }],
  ['completed', { label: 'Done', tone: 'done' }],
  ['failed', { label: 'Did not finish', tone: 'bad' }],
  ['cancelled', { label: 'Stopped', tone: '' }],
  ['budget_exhausted', { label: 'Out of budget', tone: 'bad' }],
  ['policy_denied', { label: 'Not allowed', tone: 'bad' }],
  ['timed_out', { label: 'Ran out of time', tone: 'bad' }],
  ['outcome_unverified', { label: 'Not confirmed', tone: 'attention' }],
]);
const UNKNOWN_BADGE = { label: 'Unknown', tone: 'attention' };

const STEP_LABELS = new Map<string, string>([
  ['PREPARING', 'Getting ready'],
  ['THINKING', 'Working out what to do next'],
  ['READING_WORK', 'Reading the work'],
  ['READING_FILE', 'Reading a file'],
  ['DRAFTING', 'Writing a draft'],
  ['PROPOSING_EMAIL', 'Proposing an email for someone to approve'],
  ['WAITING_FOR_APPROVAL', 'Waiting for someone to approve'],
  ['SENDING_EMAIL', 'Sending an approved email'],
  ['DELEGATING', 'Handing part of this to another assistant'],
  ['WAITING_FOR_CHILD', 'Waiting for another assistant to finish'],
  ['CHECKING_RESULT', 'Checking the result'],
  ['STOPPING', 'Winding down'],
]);

const STEP_STATES = new Map<string, string>([
  ['in_flight', 'Under way'],
  ['completed', 'Done'],
  ['failed', 'Did not work'],
  ['cancelled', 'Called off'],
]);

export function stepWords(labelCode: string, state: string): { what: string; how: string } {
  return {
    what: STEP_LABELS.get(labelCode) ?? 'A step Ensemus has no plain words for',
    how: STEP_STATES.get(state) ?? 'State not known',
  };
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  // A millionth of a dollar is what the ledger counts in, so a small amount does not round to nothing.
  maximumFractionDigits: 6,
});

/** Null means no cost to show, which is different from a cost of zero, and the page leaves the line out. */
export function costWords(run: Pick<DelegatedRun, 'costMicros' | 'costIsEstimate'>): string | null {
  const { costMicros, costIsEstimate } = run;
  if (costMicros === null || !Number.isFinite(costMicros) || costMicros < 0) return null;
  const amount = usd.format(costMicros / 1_000_000);
  return costIsEstimate ? `${amount} (estimate)` : amount;
}

export function presentRun(run: DelegatedRun): PresentedRun {
  return {
    id: run.id,
    workUnitId: run.workUnitId,
    workTitle: run.workTitle,
    agentName: run.agentName,
    sentence: describeRunStatus(run),
    badge: BADGES.get(run.status) ?? UNKNOWN_BADGE,
    finished: isRunFinished(run),
    canStop: run.canStop,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    rounds: run.turnsUsed,
    actions: run.toolCallsUsed,
    cost: costWords(run),
    steps: run.steps.map((step) => ({ ...stepWords(step.labelCode, step.state), at: step.at })),
  };
}

/** The address bar is untrusted. Only something that could be a cursor goes on to the port. */
export function cursorFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

export type StopAttempt = { ok: true } | { ok: false; code: string; failure?: unknown };

/** Where a stop goes next: back to the run, which is read again. A code and never a message. */
export function afterStopPath(base: string, runId: string, attempt: StopAttempt): string {
  const path = `${base}/assistants/${runId}`;
  return attempt.ok ? `${path}?stop=requested` : `${path}?stop=failed&error=${attempt.code}`;
}

export type StopOutcome = { kind: 'requested' } | { kind: 'failed'; code: string };

export function stopOutcomeFrom(params: { stop?: unknown; error?: unknown }): StopOutcome | null {
  if (params.stop === 'requested') return { kind: 'requested' };
  if (params.stop !== 'failed') return null;
  return { kind: 'failed', code: typeof params.error === 'string' ? params.error : 'UNEXPECTED' };
}

const STOP_FAILURES = new Map<string, string>([
  ['INVALID_INPUT', 'The box asking you to confirm was not ticked.'],
  ['FORBIDDEN', 'You do not have permission to stop this one.'],
  ['NOT_FOUND', 'Ensemus could not find it for you.'],
  ['INVALID_STATE', 'It cannot be stopped from where it is now.'],
  ['INVALID_TRANSITION', 'It cannot be stopped from where it is now.'],
  ['VERSION_CONFLICT', 'It changed just as you asked. Look at where it is now, and try again.'],
  ['CAPABILITY_UNAVAILABLE', 'The part of Ensemus that stops assistants is not available here.'],
]);
const STOP_FAILED_GENERIC = 'Something went wrong on our side.';

export type StopNotice = { tone: 'plain' | 'error'; text: string };

/**
 * What to say after a stop, given the run as it reads now. The address only says what was asked and how
 * that went, and a person can type any of it, so nothing here says a run has stopped: only the run's own
 * sentence does that, and that comes from its status.
 */
export function stopNotice(
  outcome: StopOutcome | null,
  run: Pick<PresentedRun, 'finished'>,
): StopNotice | null {
  if (!outcome) return null;
  if (outcome.kind === 'requested') {
    return {
      tone: 'plain',
      text: run.finished
        ? 'This has ended. The line below says how.'
        : 'You asked it to stop, and it has not stopped yet. An assistant finishes the step it is on first, so check again in a moment.',
    };
  }
  if (run.finished) {
    return {
      tone: 'plain',
      text: 'Your request to stop did not go through, but this has ended anyway. The line below says how.',
    };
  }
  return {
    tone: 'error',
    text: `It did not stop. ${STOP_FAILURES.get(outcome.code) ?? STOP_FAILED_GENERIC}`,
  };
}
