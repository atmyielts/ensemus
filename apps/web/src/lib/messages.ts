// Human wording for known error codes. Kept apart from server packages so components stay light.
/** The same words whether the browser or the server notices first. */
export const FILE_TOO_LARGE =
  'That file is larger than 25 MB, so it was not added. Attach a smaller one.';

const MESSAGE_FOR = new Map<string, string>([
  ['MODEL_PROFILE_NOT_ACTIVE', 'This model profile is not active.'],
  ['MODEL_PROBE_REQUIRED', 'This model profile has to pass its test before it can be used.'],
  ['MODEL_ENDPOINT_NOT_ALLOWED', 'That address cannot be used for a model on this deployment.'],
  [
    'MODEL_CREDENTIALS_NOT_REVIEWED',
    'Keys for hosted providers are not enabled on this deployment yet.',
  ],
  [
    'MODEL_UNAVAILABLE',
    'The approved model is not available, so nothing was sent. Your work is unchanged.',
  ],
  ['RATE_CARD_MISSING', 'This model profile has no rate card, so its cost cannot be measured.'],
  ['BUDGET_NOT_CONFIGURED', 'No budget is set, so agents cannot run yet.'],
  ['BUDGET_EXHAUSTED', 'The budget for this has been used up.'],
  ['ENTITLEMENT_DENIED', 'Your plan does not include this.'],
  ['POLICY_DENIED', 'Your organization’s policy does not allow this.'],
  ['AGENT_SPEC_INVALID', 'This agent definition is not valid.'],
  [
    'AGENT_EVALUATION_REQUIRED',
    'This agent version needs a passing evaluation before it can be published.',
  ],
  ['AGENT_RUN_ACTIVE', 'An agent is already running on this work.'],
  ['AGENT_RUN_NOT_CONTROLLABLE', 'This run has finished, so it cannot be changed.'],
  ['AI_HALTED', 'Agents are stopped on this deployment right now.'],
  ['KILL_SWITCH_NOT_YOURS', 'This stop was set by the operator of this deployment.'],
  ['TOOL_DENIED', 'This agent is not allowed to do that.'],
  ['NO_ELIGIBLE_APPROVER', 'Nobody else can approve this, so it was not sent.'],
  ['DELEGATION_DENIED', 'An agent cannot give another agent more than it has itself.'],
  ['NOT_FOUND', 'Not found, or you do not have access.'],
  ['FORBIDDEN', 'You do not have permission to do that.'],
  ['VERSION_CONFLICT', 'Someone else changed this first. Check the latest version and try again.'],
  ['INVALID_TRANSITION', 'That status change is not allowed from the current status.'],
  ['PREREQUISITES_INCOMPLETE', 'This work is waiting on prerequisites that are not done.'],
  ['EVIDENCE_MISSING', 'The evidence this work requires has not been provided yet.'],
  [
    'OWNER_CONFIRMATION_REQUIRED',
    'This work asks for no evidence, so only its accountable owner can confirm it is done.',
  ],
  ['RUN_ALREADY_REQUESTED', 'Someone already asked this plan to run. That request still stands.'],
  ['REASON_REQUIRED', 'Please give a reason.'],
  ['DEPENDENCY_CYCLE', 'That dependency would create a loop.'],
  [
    'TEAM_CYCLE',
    'A team cannot sit inside itself or inside one of its own teams. Choose a different parent.',
  ],
  ['INVALID_STATE', 'That cannot be done while the work is in this status.'],
  ['INVALID_INPUT', 'Please check the details and try again.'],
  ['FILE_TOO_LARGE', FILE_TOO_LARGE],
  ['APPROVAL_NOT_PENDING', 'This approval has already been decided or closed.'],
  ['APPROVAL_EXPIRED', 'This approval has expired.'],
  ['APPROVAL_WRONG_APPROVER', 'This approval is assigned to someone else.'],
  ['APPROVAL_HASH_MISMATCH', 'The action changed after you reviewed it. Please review it again.'],
  ['APPROVAL_SELF_APPROVAL', 'You cannot approve your own request.'],
  ['APPROVAL_STALE', 'This work changed after the review was requested. Ask for a new review.'],
  ['REVIEW_ALREADY_OPEN', 'A review of this work is already open. It has to be decided first.'],
  ['INVITATION_INVALID', 'This invitation is not valid. Ask for a new one.'],
  ['LAST_OWNER', 'An organization must keep at least one owner.'],
  ['RESTORE_PENDING', 'This organization is being restored from a backup. Try again later.'],
  [
    'EXTERNAL_ACTION_NOT_EDITABLE',
    'This can no longer be changed, because Ensemus has already tried to send it.',
  ],
  ['EXTERNAL_ACTION_NOT_RESOLVABLE', 'Only an action in an unknown state can be resolved.'],
  ['EXTERNAL_ACTION_NOT_RETRYABLE', 'Only an action that was not sent can be asked for again.'],
  ['CONNECTION_NOT_ACTIVE', 'This connection is not active.'],
  ['CONNECTOR_NOT_AVAILABLE', 'This connector is not available on this deployment.'],
  ['RESTRICTED_NOT_ALLOWED', 'Restricted work cannot be sent outside this deployment.'],
  ['UNEXPECTED', 'Something went wrong on our side. Please try again.'],
]);

const GENERIC = 'Something went wrong. Please try again.';

/**
 * The wording for a code from the address bar. A Map, because a plain object also answers for keys
 * like __proto__ and constructor, and handing those to React crashes the page.
 */
export function messageFor(code: string): string {
  return MESSAGE_FOR.get(code) ?? GENERIC;
}
