// Typed, safe errors. Messages are fixed text meant for people, and never echo input or data.

export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'PREREQUISITES_INCOMPLETE'
  | 'EVIDENCE_MISSING'
  | 'OWNER_CONFIRMATION_REQUIRED'
  | 'RUN_ALREADY_REQUESTED'
  | 'REASON_REQUIRED'
  | 'DEPENDENCY_CYCLE'
  | 'TEAM_CYCLE'
  | 'INVALID_STATE'
  | 'INVALID_INPUT'
  | 'FILE_TOO_LARGE'
  | 'APPROVAL_NOT_PENDING'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_WRONG_APPROVER'
  | 'APPROVAL_HASH_MISMATCH'
  | 'APPROVAL_SELF_APPROVAL'
  | 'APPROVAL_STALE'
  | 'REVIEW_ALREADY_OPEN'
  | 'INVITATION_INVALID'
  | 'LAST_OWNER'
  | 'RESTORE_PENDING'
  | 'EXTERNAL_ACTION_NOT_EDITABLE'
  | 'EXTERNAL_ACTION_NOT_RESOLVABLE'
  | 'EXTERNAL_ACTION_NOT_RETRYABLE'
  | 'CONNECTION_NOT_ACTIVE'
  | 'CONNECTOR_NOT_AVAILABLE'
  | 'RESTRICTED_NOT_ALLOWED'
  | 'LICENSE_NOT_VALID'
  | 'EXPORT_ALREADY_RUNNING'
  | 'EXPORT_NOT_READY'
  | 'EXPORT_SUPERSEDED'
  | 'IMPORT_TARGET_NOT_EMPTY'
  | 'IMPORT_ALREADY_USED'
  | 'IMPORTED_PERSON_ALREADY_LINKED';

const MESSAGES: Record<ErrorCode, string> = {
  NOT_FOUND: 'Not found or not permitted.',
  FORBIDDEN: 'You do not have permission to do that.',
  VERSION_CONFLICT: 'Someone else changed this first. Reload to see the latest version.',
  INVALID_TRANSITION: 'That status change is not allowed from the current status.',
  PREREQUISITES_INCOMPLETE: 'This work is waiting on prerequisites that are not complete.',
  EVIDENCE_MISSING: 'The evidence this work requires has not been provided yet.',
  OWNER_CONFIRMATION_REQUIRED:
    'This work asks for no evidence, so only its accountable owner can confirm it is done.',
  RUN_ALREADY_REQUESTED: 'Someone already asked this plan to run. That request still stands.',
  REASON_REQUIRED: 'A reason is required.',
  DEPENDENCY_CYCLE: 'That dependency would create a loop.',
  TEAM_CYCLE: 'A team cannot sit inside itself or inside one of its own teams.',
  INVALID_STATE: 'That cannot be done in the current state.',
  INVALID_INPUT: 'Please check the details and try again.',
  FILE_TOO_LARGE: 'That file is larger than 25 MB, so it was not added. Attach a smaller one.',
  APPROVAL_NOT_PENDING: 'This approval has already been decided.',
  APPROVAL_EXPIRED: 'This approval has expired.',
  APPROVAL_WRONG_APPROVER: 'This approval is assigned to someone else.',
  APPROVAL_HASH_MISMATCH: 'The action changed after you reviewed it. Review it again.',
  APPROVAL_SELF_APPROVAL: 'You cannot approve your own request.',
  APPROVAL_STALE: 'This work changed after the review was requested. Ask for a new review.',
  REVIEW_ALREADY_OPEN: 'A review of this work is already open. It has to be decided first.',
  INVITATION_INVALID: 'This invitation is not valid. Ask for a new one.',
  LAST_OWNER: 'An organization must keep at least one owner.',
  RESTORE_PENDING:
    'This organization is being restored from a backup, and is unavailable until that is finished.',
  EXTERNAL_ACTION_NOT_EDITABLE:
    'This can no longer be changed, because Ensemus has already tried to send it.',
  EXTERNAL_ACTION_NOT_RESOLVABLE: 'Only an action in an unknown state can be resolved.',
  EXTERNAL_ACTION_NOT_RETRYABLE: 'Only an action that was not sent can be asked for again.',
  CONNECTION_NOT_ACTIVE: 'This connection is not active.',
  CONNECTOR_NOT_AVAILABLE: 'This connector is not available on this deployment.',
  RESTRICTED_NOT_ALLOWED: 'Restricted work cannot be sent outside this deployment.',
  LICENSE_NOT_VALID:
    'That file could not be verified, so nothing was changed. Everything already installed stays as it was.',
  EXPORT_ALREADY_RUNNING: 'An export of this organization is already running.',
  EXPORT_NOT_READY: 'This export is not ready to download.',
  EXPORT_SUPERSEDED:
    'Data or access changed after this export started, so this copy can no longer be downloaded. Make a new export.',
  IMPORT_TARGET_NOT_EMPTY: 'An archive can only be imported into a new, empty organization.',
  IMPORT_ALREADY_USED: 'This organization has already taken an archive.',
  IMPORTED_PERSON_ALREADY_LINKED: 'This person has already been linked to a member.',
};

export class AppError extends Error {
  override name = 'AppError';
  constructor(
    readonly code: ErrorCode,
    /** What the audit log calls this, when that says more than the person is told. */
    readonly auditAs?: 'FOREIGN_REFERENCE',
  ) {
    super(MESSAGES[code]);
  }
}

/**
 * A request named a project, person, team or client that is not in this tenant. Every form only ever
 * offers ones that are, so this is someone writing their own request. They hear what a typing mistake
 * would hear, whether it exists elsewhere or nowhere, so no ID can be probed, and the log says what it
 * was (NEXT-01).
 */
export const foreignReference = () => new AppError('INVALID_INPUT', 'FOREIGN_REFERENCE');

export const HTTP_STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  VERSION_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  PREREQUISITES_INCOMPLETE: 409,
  EVIDENCE_MISSING: 409,
  OWNER_CONFIRMATION_REQUIRED: 403,
  RUN_ALREADY_REQUESTED: 409,
  REASON_REQUIRED: 400,
  DEPENDENCY_CYCLE: 409,
  TEAM_CYCLE: 409,
  INVALID_STATE: 409,
  INVALID_INPUT: 400,
  FILE_TOO_LARGE: 413,
  APPROVAL_NOT_PENDING: 409,
  APPROVAL_EXPIRED: 409,
  APPROVAL_WRONG_APPROVER: 403,
  APPROVAL_HASH_MISMATCH: 409,
  APPROVAL_SELF_APPROVAL: 403,
  APPROVAL_STALE: 409,
  REVIEW_ALREADY_OPEN: 409,
  INVITATION_INVALID: 400,
  LAST_OWNER: 409,
  RESTORE_PENDING: 503,
  EXTERNAL_ACTION_NOT_EDITABLE: 409,
  EXTERNAL_ACTION_NOT_RESOLVABLE: 409,
  EXTERNAL_ACTION_NOT_RETRYABLE: 409,
  CONNECTION_NOT_ACTIVE: 409,
  CONNECTOR_NOT_AVAILABLE: 409,
  RESTRICTED_NOT_ALLOWED: 403,
  LICENSE_NOT_VALID: 400,
  EXPORT_ALREADY_RUNNING: 409,
  EXPORT_NOT_READY: 409,
  EXPORT_SUPERSEDED: 410,
  IMPORT_TARGET_NOT_EMPTY: 409,
  IMPORT_ALREADY_USED: 409,
  IMPORTED_PERSON_ALREADY_LINKED: 409,
};

/** Reads the Postgres error code through the wrapper Drizzle adds. */
export function pgCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}
