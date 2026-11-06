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
  ['FEATURE_NOT_ENABLED', 'This is not switched on for this deployment.'],
  ['SKILL_NAME_TAKEN', 'A skill with that name already exists here. Choose another.'],
  ['SKILL_SIGNER_KEY_INVALID', 'That is not a valid Ed25519 public key.'],
  [
    'SKILL_SIGNER_EXISTS',
    'That key is already on file. A key that was revoked cannot be trusted again.',
  ],
  ['SKILL_BUNDLE_TOO_LARGE', 'That bundle is larger than 8 MiB, so it was not stored.'],
  [
    'SKILL_VERSION_NOT_PUBLISHABLE',
    'This version cannot be published. It has to be verified, and its signer still trusted.',
  ],
  [
    'SKILL_PUBLISH_SAME_PERSON',
    'Someone other than whoever uploaded this version has to publish it.',
  ],
  ['SKILL_VERSION_NOT_USABLE', 'This version cannot be used right now.'],
  ['SANDBOX_INPUT_TOO_LARGE', 'That input is larger than 1 MiB, so it was not accepted.'],
  ['SANDBOX_CLASSIFICATION_NOT_ALLOWED', 'This skill cannot be given data of that classification.'],
  ['SANDBOX_RUN_NOT_CANCELLABLE', 'This run has already finished.'],
  ['MARKETPLACE_PUBLISHER_REQUIRED', 'This organization has to become a publisher first.'],
  ['MARKETPLACE_PUBLISHER_EXISTS', 'This organization is already a publisher.'],
  [
    'MARKETPLACE_NOT_PUBLIC',
    'Only a package marked public can be submitted, because other organizations would see it.',
  ],
  [
    'MARKETPLACE_VERSION_NOT_SUBMITTABLE',
    'Only a verified version of your own package, signed by a key you still trust, can be submitted.',
  ],
  [
    'MARKETPLACE_SUBMISSION_NOT_WITHDRAWABLE',
    'This can no longer be withdrawn. If it is listed, ask for it to be delisted.',
  ],
  ['MARKETPLACE_LISTING_NOT_AVAILABLE', 'That listing is not available.'],
  ['MARKETPLACE_ALREADY_INSTALLED', 'This organization already has this listing.'],
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
