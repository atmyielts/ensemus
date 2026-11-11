// The words a run page uses, and the only words it has for a run. Every status, step and reason arrives as
// a code, and a code becomes words only by being looked up here: an unknown one gets a fixed line and is
// never shown itself. So nothing a model wrote can reach a person through a timeline (ADR-028 FD-5).
// Shared by the page and its watcher, so this imports types only.
import type { AgentRunView, ExecutionStepView } from '@ensemus/contracts/ai';
import type {
  AgentRunStatus,
  AiReasonCode,
  RunControlKind,
  StepLabelCode,
  StopCode,
} from '@ensemus/domain/ai';

export type Tone = '' | 'active' | 'attention' | 'done' | 'bad';

type StatusWords = { label: string; tone: Tone; note: string; live: boolean };

const STATUS = new Map<string, StatusWords>(
  Object.entries({
    queued: {
      label: 'Waiting to start',
      tone: '',
      live: true,
      note: 'This run is recorded, and is waiting for a worker to pick it up.',
    },
    preparing: {
      label: 'Getting ready',
      tone: 'active',
      live: true,
      note: 'A worker has picked this up and is getting ready.',
    },
    running: {
      label: 'Running',
      tone: 'active',
      live: true,
      note: 'The agent is working. Each step checks again that it is still allowed.',
    },
    paused: {
      label: 'Paused',
      tone: 'attention',
      live: true,
      note: 'Nothing further happens until someone resumes this run.',
    },
    waiting_for_approval: {
      label: 'Waiting for approval',
      tone: 'attention',
      live: true,
      note: 'The agent asked to do something outside Ensemus. It will not happen unless the person asked approves it.',
    },
    waiting_for_child: {
      label: 'Waiting for another agent',
      tone: 'active',
      live: true,
      note: 'This run asked another agent to do part of the work, and is waiting for it.',
    },
    verifying: {
      label: 'Checking the result',
      tone: 'active',
      live: true,
      note: 'The agent has finished, and its result is being checked.',
    },
    completed: {
      label: 'Finished',
      tone: 'done',
      live: false,
      note: 'The agent finished and its result passed the checks. That does not mark the work done: a person still does that.',
    },
    failed: {
      label: 'Failed',
      tone: 'bad',
      live: false,
      note: 'This run did not finish, and it stays that way. To try again, start a new run.',
    },
    cancelled: {
      label: 'Stopped',
      tone: '',
      live: false,
      note: 'This run was stopped, and it stays that way. To try again, start a new run.',
    },
    budget_exhausted: {
      label: 'Budget used up',
      tone: 'bad',
      live: false,
      note: 'This run stopped because there was no budget left for its next step.',
    },
    policy_denied: {
      label: 'Stopped by policy',
      tone: 'bad',
      live: false,
      note: 'Your organization’s policy did not allow this run’s next step, so it stopped there.',
    },
    timed_out: {
      label: 'Ran out of time',
      tone: 'bad',
      live: false,
      note: 'This run reached its time limit, and stopped. Time spent waiting does not count towards that limit.',
    },
    outcome_unverified: {
      label: 'Outcome unknown',
      tone: 'attention',
      live: false,
      note: 'We could not confirm what happened. Something may or may not have taken effect outside Ensemus, and Ensemus will not retry it. Check before trying again.',
    },
  } satisfies Record<AgentRunStatus, StatusWords>),
);

const UNKNOWN_STATUS: StatusWords = {
  label: 'Unknown',
  tone: 'attention',
  live: false,
  note: 'This run is in a state this page does not recognise, so it cannot say what the run is doing.',
};

export const runStatusWords = (status: string): StatusWords => STATUS.get(status) ?? UNKNOWN_STATUS;

export const isLiveStatus = (status: string) => runStatusWords(status).live;

const STEP_LABEL = new Map<string, string>(
  Object.entries({
    PREPARING: 'Getting ready',
    THINKING: 'Working out the next step',
    READING_WORK: 'Reading this work',
    READING_FILE: 'Reading an attached file',
    DRAFTING: 'Drafting a file',
    PROPOSING_EMAIL: 'Proposing an email',
    WAITING_FOR_APPROVAL: 'Waiting for someone to approve',
    SENDING_EMAIL: 'Sending an email',
    DELEGATING: 'Asking another agent to help',
    WAITING_FOR_CHILD: 'Waiting for the other agent',
    CHECKING_RESULT: 'Checking the result',
    STOPPING: 'Stopping',
    READING_ACCOUNT: 'Reading from a connected account',
    WRITING_DRAFT: 'Saving a draft in a connected account',
    PROPOSING_CHANGE: 'Proposing a change in a connected account',
  } satisfies Record<StepLabelCode, string>),
);

export const stepLabel = (code: string) => STEP_LABEL.get(code) ?? 'A step this page does not name';

const STEP_STATE = new Map<string, string>([
  ['in_flight', 'In progress'],
  ['completed', 'Done'],
  ['failed', 'Failed'],
  ['cancelled', 'Stopped'],
]);

/** A step still open on a run that has ended never reported back, and calling it in progress is untrue. */
export function stepStateWords(state: string, runIsLive: boolean) {
  if (state === 'in_flight' && !runIsLive) return 'We do not know how this ended';
  return STEP_STATE.get(state) ?? 'Unknown';
}

const STOP_REASON = new Map<string, string>(
  Object.entries({
    TURN_LIMIT: 'It reached the most steps this agent is allowed.',
    TOOL_LIMIT: 'It reached the most tool uses this agent is allowed.',
    TOKEN_LIMIT: 'It reached the most text this agent is allowed to process.',
    COST_LIMIT: 'It reached the most this agent is allowed to spend on one run.',
    TIME_LIMIT: 'It reached this agent’s time limit.',
    BUDGET_EXHAUSTED: 'The budget for this has been used up.',
    BUDGET_NOT_CONFIGURED: 'No budget is set, so no model could be used.',
    RATE_CARD_MISSING: 'The model has no rate card, so its cost could not be measured.',
    ENTITLEMENT_DENIED: 'Your plan does not include this.',
    POLICY_DENIED: 'Your organization’s policy does not allow this.',
    PROFILE_CHANGED: 'The model’s settings changed during the run, so it did not continue.',
    MODEL_UNAVAILABLE: 'The approved model was not available, so nothing was sent to another one.',
    CREDENTIAL_UNAVAILABLE: 'The model’s key could not be used.',
    INVALID_OUTPUT: 'The model’s answer could not be used.',
    HALTED: 'Agents were stopped on this deployment.',
    STOPPED_BY_PERSON: 'Someone stopped it.',
    WORK_STOPPED: 'The work it was on was stopped.',
    INITIATOR_INACTIVE: 'The person who started it no longer has access.',
    UNKNOWN_EXTERNAL_STATE:
      'We do not know whether something outside Ensemus took effect. A person has to find out and record it.',
    APPROVAL_DENIED: 'The person asked did not approve it.',
    APPROVAL_EXPIRED: 'The approval it needed expired.',
    DELEGATION_DENIED: 'It asked another agent for more than it could give.',
    CHILD_FAILED: 'Another agent it asked to help did not finish.',
    WORKER_UNAVAILABLE: 'No worker was available to pick it up.',
    OUTPUT_UNVERIFIED: 'Its result could not be checked.',
    STRANDED: 'The process running it was lost.',
    INTERNAL_ERROR: 'Something went wrong on our side.',
  } satisfies Record<StopCode, string>),
);

export const stopReason = (code: string) =>
  STOP_REASON.get(code) ?? 'The reason is one this page does not recognise.';

const DECISION_NOTE = new Map<string, string>(
  Object.entries({
    ENTITLEMENT_DENIED: 'Your plan does not include this.',
    CLASS_DENIED: 'Data of this sensitivity may not go there.',
    CLASS_NOT_ON_PROFILE: 'This model is not approved for data of this sensitivity.',
    PURPOSE_NOT_ON_PROFILE: 'This model is not approved for this purpose.',
    WRONG_REGION: 'This model is in the wrong region.',
    REGION_REQUIRED: 'This model has no region recorded.',
    CONTRACT_MISSING: 'No contract is recorded for this model.',
    PROFILE_NOT_ACTIVE: 'This model is not active.',
    PROFILE_CHANGED: 'This model’s settings changed during the run.',
    PROFILE_NOT_QUALIFIED: 'This model has not passed its test.',
    CAPABILITY_MISSING: 'This model cannot do what the agent needs.',
    FALLBACK_NOT_ALLOWED: 'Falling back to another model was not allowed.',
    BILLING_OWNER_CROSSED: 'Falling back to a model billed differently was not allowed.',
    NO_CANDIDATE: 'No approved model could take this.',
    BUDGET_EXHAUSTED: 'The budget for this has been used up.',
    BUDGET_NOT_CONFIGURED: 'No budget is set.',
    RATE_CARD_MISSING: 'This model has no rate card.',
    SECRET_FOUND_IN_PAYLOAD: 'Something that looks like a secret was found, so it was not sent.',
    HALTED: 'Agents were stopped.',
    POLICY_UNREADABLE: 'The policy could not be read, so this was refused.',
    UNKNOWN_INPUT: 'This was refused because something about it was not recognised.',
    TOOL_NOT_GRANTED: 'This agent has not been given that tool.',
    TOOL_DENIED_BY_SPEC: 'This agent is not allowed that tool.',
    TOOL_UNKNOWN: 'The agent asked for a tool that does not exist.',
    TOOL_ARGS_INVALID: 'The agent’s request to a tool was not valid.',
    RESOURCE_NOT_PERMITTED: 'The person who started this does not have access to that.',
    DESTRUCTIVE_DENIED: 'Agents are not allowed to do something that cannot be undone.',
    APPROVAL_REQUIRED: 'This needs someone’s approval first.',
    INITIATOR_INACTIVE: 'The person who started this no longer has access.',
    DELEGATION_WIDENED: 'It asked another agent to have more than it has itself.',
    DELEGATION_DEPTH: 'Agents asking agents went too deep.',
    DELEGATION_FANOUT: 'It asked too many other agents.',
    SCOPE_NOT_GRANTED: 'That connected account was not given permission for this.',
    CONNECTION_NOT_YOURS: 'That connected account belongs to someone else.',
    CONNECTION_TYPE_MISMATCH: 'That connected account cannot do this.',
  } satisfies Record<Exclude<AiReasonCode, 'ALLOWED'>, string>),
);

/** Why a rule decided a step the way it did. Null when there is nothing to explain. */
export function decisionNote(code: string | null): string | null {
  if (code === null || code === 'ALLOWED') return null;
  return (
    DECISION_NOTE.get(code) ?? 'A rule decided this, for a reason this page does not recognise.'
  );
}

const OUTCOME_NOTE = new Map<string, string>([
  [
    'unknown_external_state',
    'We do not know whether this took effect outside Ensemus, and it will not be retried.',
  ],
  ['needs_approval', 'This needs someone’s approval first.'],
  ['denied', 'This was refused.'],
  ['invalid_output', 'The model’s answer could not be used.'],
  ['model_unavailable', 'The approved model was not available.'],
  ['credential_unavailable', 'The model’s key could not be used.'],
  ['budget_exhausted', 'There was no budget left for this.'],
  ['policy_denied', 'Policy did not allow this.'],
]);

/** One sentence about a step, if it needs one. A rule's reason is more specific than its outcome. */
export function stepNote(step: Pick<ExecutionStepView, 'outcome' | 'decision_code'>) {
  const decided = decisionNote(step.decision_code);
  if (step.outcome === 'unknown_external_state' || !decided) {
    return (step.outcome && OUTCOME_NOTE.get(step.outcome)) ?? decided;
  }
  return decided;
}

/**
 * Says what was asked for and has not happened yet. A control is a request the worker reaches at its next
 * check, so the status alone would look as if the button did nothing, and calling it done would be untrue.
 */
export function pendingNote(status: string, latest: RunControlKind | null): string | null {
  if (!isLiveStatus(status) || latest === null) return null;
  if (latest === 'stop') {
    return 'A stop is recorded. The run ends at its next check, and this page will say when it has.';
  }
  if (latest === 'pause' && status !== 'paused') {
    return 'A pause is recorded. The run pauses at its next check.';
  }
  if (latest === 'resume' && status === 'paused') {
    return 'A resume is recorded. The run continues at its next check.';
  }
  return null;
}

/** Whole micro-USD to dollars, with integers throughout, so nothing rounds on the way to the page. */
export function formatMicros(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0{1,4}$/, '');
  return `$${whole}.${fraction.padEnd(2, '0')}`;
}

/** How a cost reads. An estimate is called one, because a provider's own figure may well differ. */
export function costLine(micros: number, isEstimate: boolean) {
  return {
    label: isEstimate ? 'Estimated cost' : 'Cost',
    amount: formatMicros(micros),
    note: isEstimate
      ? 'This is an estimate, not a bill. Your model provider’s own figure may differ.'
      : null,
  };
}

/**
 * Everything on the page that moves, as one string. The watcher compares this with what the server sent,
 * so it asks for a new page only when there is something new to show.
 */
export function runSignature(
  run: Pick<
    AgentRunView,
    | 'status'
    | 'stop_code'
    | 'effective_classification'
    | 'model_turns'
    | 'tool_calls'
    | 'input_tokens'
    | 'output_tokens'
    | 'cost_micros'
    | 'cost_is_estimate'
    | 'ended_at'
  >,
  steps: readonly Pick<
    ExecutionStepView,
    'step_number' | 'state' | 'label_code' | 'outcome' | 'decision_code' | 'ended_at'
  >[],
): string {
  return JSON.stringify([
    run.status,
    run.stop_code,
    run.effective_classification,
    run.model_turns,
    run.tool_calls,
    run.input_tokens,
    run.output_tokens,
    run.cost_micros,
    run.cost_is_estimate,
    run.ended_at,
    steps.map((step) => [
      step.step_number,
      step.state,
      step.label_code,
      step.outcome,
      step.decision_code,
      step.ended_at,
    ]),
  ]);
}
