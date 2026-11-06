// The Assistants area (UX-19). See docs/06-delivery/m7-slices.md. A thin layer over M4's AgentRunsPort, with
// plain-language wording decided here and a person's right to read or stop a run checked there: nothing in
// this file filters or widens what the port answers.
import type { TenantContext } from '@ensemus/database';
import type { DelegatedRun, ProductPorts } from './ports';

/** One screen's worth. The port still decides what is in it. */
const PAGE_SIZE = 25;

export type AssistantsView = {
  running: readonly DelegatedRun[];
  finished: readonly DelegatedRun[];
  next: string | null;
};

// Maps, because a plain object also answers for keys like __proto__, and a status is someone else's text
// until it is proven to be one of these.
const STILL_GOING = new Map<string, string>([
  ['queued', 'It is waiting to start.'],
  ['preparing', 'It is getting ready to start.'],
  ['running', 'It is working on this now.'],
  ['paused', 'It is on hold, and will do nothing more until someone resumes it.'],
  ['waiting_for_approval', 'It is waiting for a person to approve something before it goes on.'],
  ['waiting_for_child', 'It is waiting for another assistant it handed part of this to.'],
  ['verifying', 'It has done its part, and the result is being checked.'],
]);

const FINISHED = new Map<string, string>([
  ['completed', 'It finished, and the result was checked.'],
  ['failed', 'It did not finish, because something went wrong.'],
  ['cancelled', 'It was stopped before it finished.'],
  ['budget_exhausted', 'It was stopped before it finished, because the money for it ran out.'],
  [
    'policy_denied',
    'It was stopped before it finished, because your organization’s rules do not allow what it needed to do.',
  ],
  ['timed_out', 'It was stopped before it finished, because it ran out of time.'],
  [
    'outcome_unverified',
    'It ended, but Ensemus could not confirm the result. Check it before relying on it.',
  ],
]);

/** Why a run ended. Each reads after the sentence for its status, so none of them says more than why. */
const STOP_REASONS = new Map<string, string>([
  ['TURN_LIMIT', 'It reached its limit on rounds of work.'],
  ['TOOL_LIMIT', 'It reached its limit on actions.'],
  ['TOKEN_LIMIT', 'It reached its limit on how much text it may process.'],
  ['COST_LIMIT', 'It reached the spending limit set for it.'],
  ['TIME_LIMIT', 'It reached the time limit set for it.'],
  ['BUDGET_EXHAUSTED', 'Your organization’s budget for assistants has run out.'],
  ['BUDGET_NOT_CONFIGURED', 'No budget is set for assistants yet.'],
  ['RATE_CARD_MISSING', 'Ensemus has no price on record for the model it uses.'],
  ['ENTITLEMENT_DENIED', 'Your plan does not include this.'],
  ['POLICY_DENIED', 'Your organization’s rules refused something it asked to do.'],
  ['PROFILE_CHANGED', 'The model settings it relies on changed while it was working.'],
  ['MODEL_UNAVAILABLE', 'The model it uses could not be reached.'],
  ['CREDENTIAL_UNAVAILABLE', 'The access details for the model it uses were not available.'],
  ['INVALID_OUTPUT', 'The model gave back something Ensemus could not use.'],
  ['HALTED', 'Assistants were switched off here by someone responsible for them.'],
  ['STOPPED_BY_PERSON', 'Someone asked it to stop.'],
  ['WORK_STOPPED', 'The work it was helping with was stopped.'],
  ['INITIATOR_INACTIVE', 'The person who started it no longer has access.'],
  [
    'UNKNOWN_EXTERNAL_STATE',
    'It tried to do something outside Ensemus, and nobody can tell yet whether that happened. A person needs to check.',
  ],
  ['APPROVAL_DENIED', 'Someone declined an approval it needed.'],
  ['APPROVAL_EXPIRED', 'An approval it needed was not given in time.'],
  ['DELEGATION_DENIED', 'It was not allowed to hand part of this to another assistant.'],
  ['CHILD_FAILED', 'Another assistant it handed part of this to did not finish.'],
  ['WORKER_UNAVAILABLE', 'The part of Ensemus that runs assistants was not available.'],
  ['OUTPUT_UNVERIFIED', 'Its result could not be checked.'],
  ['STRANDED', 'The part of Ensemus running it was lost, so it was closed and will not carry on.'],
  ['INTERNAL_ERROR', 'Something went wrong on our side.'],
]);

const UNKNOWN_STATUS =
  'Ensemus cannot put where this has got to into plain words. Open the work it belongs to, and check before relying on it.';
const UNKNOWN_REASON = 'Ensemus has no plain description of why.';

/** Whether a run has ended. M4's table of transitions, read by status: a status nobody knows has not. */
export function isRunFinished(run: Pick<DelegatedRun, 'status'>): boolean {
  return FINISHED.has(run.status);
}

export async function listMyDelegatedRuns(
  context: TenantContext,
  ports: Pick<ProductPorts, 'agentRuns'>,
  input: { after?: string } = {},
): Promise<AssistantsView> {
  const page = await ports.agentRuns.listMine(context, {
    limit: PAGE_SIZE,
    ...(input.after ? { after: input.after } : {}),
  });
  return {
    running: page.items.filter((run) => !isRunFinished(run)),
    finished: page.items.filter(isRunFinished),
    next: page.next,
  };
}

export async function getDelegatedRun(
  context: TenantContext,
  ports: Pick<ProductPorts, 'agentRuns'>,
  runId: string,
): Promise<DelegatedRun> {
  return ports.agentRuns.get(context, runId);
}

/**
 * A stop that is not honoured is reported as such, because the port's refusal comes straight out of here.
 * Returning only means the request was accepted. The run says when it has stopped, and M4 audits the control.
 */
export async function stopDelegatedRun(
  context: TenantContext,
  ports: Pick<ProductPorts, 'agentRuns'>,
  runId: string,
): Promise<void> {
  await ports.agentRuns.requestStop(context, runId);
}

/**
 * The sentence for a run's status and stop code. Pure, and it knows every code M4 can send. The status is
 * the truth about where a run is, so a stop code on a run still going is not read at all: that is how a
 * person is never told something has stopped before it has. It never repeats a code it does not know.
 */
export function describeRunStatus(run: Pick<DelegatedRun, 'status' | 'stopCode'>): string {
  const going = STILL_GOING.get(run.status);
  if (going) return going;
  const ended = FINISHED.get(run.status);
  if (!ended) return UNKNOWN_STATUS;
  if (run.status === 'completed' || run.stopCode === null) return ended;
  return `${ended} ${STOP_REASONS.get(run.stopCode) ?? UNKNOWN_REASON}`;
}
