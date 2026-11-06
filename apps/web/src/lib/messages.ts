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
  [
    'LICENSE_NOT_VALID',
    'That file could not be verified, so nothing was changed. Everything already installed stays as it was.',
  ],
  ['EXPORT_ALREADY_RUNNING', 'An export of this organization is already running.'],
  ['EXPORT_NOT_READY', 'This export is not ready to download.'],
  [
    'EXPORT_SUPERSEDED',
    'Data or access changed after this export started, so this copy can no longer be downloaded. Make a new export.',
  ],
  ['IMPORT_TARGET_NOT_EMPTY', 'An archive can only be imported into a new, empty organization.'],
  ['IMPORT_ALREADY_USED', 'This organization has already taken an archive.'],
  ['IMPORTED_PERSON_ALREADY_LINKED', 'This person has already been linked to a member.'],
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
