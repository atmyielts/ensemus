// Human wording for known error codes. Kept apart from server packages so components stay light.
/** The same words whether the browser or the server notices first. */
export const FILE_TOO_LARGE =
  'That file is larger than 25 MB, so it was not added. Attach a smaller one.';

const MESSAGE_FOR = new Map<string, string>([
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
  ['BILLING_NOT_ENABLED', 'Billing is not available on this deployment.'],
  ['RATE_CARD_NOT_APPROVED', 'Nothing can be billed until an approved rate card is in place.'],
  ['PLAN_NOT_AVAILABLE', 'That plan is not available.'],
  ['SUBSCRIPTION_EXISTS', 'This organization already has a subscription.'],
  ['NO_SUBSCRIPTION', 'This organization has no subscription.'],
  [
    'QUOTE_CHANGED',
    'The price changed after you saw it, so nothing was bought. Check it and try again.',
  ],
  ['TOP_UP_NOT_ALLOWED', 'This plan does not allow top-ups.'],
  [
    'TAX_TREATMENT_MISSING',
    'Tax for this place has not been set up, so no invoice can be issued yet.',
  ],
  ['TAX_PROVIDER_UNAVAILABLE', 'Tax could not be worked out just now. Nothing was charged.'],
  ['INVOICE_NOT_PAYABLE', 'This invoice cannot be paid in its current state.'],
  ['PAYMENT_NOT_RESOLVABLE', 'Only a payment in an unknown state can be resolved.'],
  ['PAYMENT_PROCESSOR_NOT_CONFIGURED', 'Payments are not set up on this deployment.'],
  [
    'TENANT_READ_ONLY',
    'This organization is read-only, so nothing can be changed. Billing and support still work.',
  ],
  [
    'TENANT_SUSPENDED',
    'This organization is suspended. Its data is kept, and billing, export and support still work.',
  ],
  ['LEGAL_HOLD_ACTIVE', 'This is under a legal hold, so it cannot be deleted.'],
  ['RETENTION_BASIS_REQUIRED', 'A retention period has to say whose sign-off it rests on.'],
  ['OFFBOARDING_IN_PROGRESS', 'This organization is already being offboarded.'],
  ['OFFBOARDING_NOT_CANCELLABLE', 'Erasure has started, so this can no longer be cancelled.'],
  ['OFFBOARDING_CONFIRMATION_MISMATCH', 'That does not match this organization’s name.'],
  ['BREAK_GLASS_DISABLED', 'Support access to content is turned off on this deployment.'],
  ['BREAK_GLASS_NOT_AUTHORIZABLE', 'This request can no longer be decided.'],
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
