// Typed, safe errors. Messages are fixed text meant for people, and never echo input or data.

export type ErrorCode =
  | 'IDEMPOTENCY_KEY_REUSED'
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
  | 'KNOWLEDGE_SOURCE_CLOSED'
  | 'KNOWLEDGE_FORMAT_UNSUPPORTED'
  | 'KNOWLEDGE_GRANT_TOO_WIDE'
  | 'KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE'
  | 'KNOWLEDGE_NO_MODEL'
  | 'KNOWLEDGE_FACT_NEEDS_EVIDENCE'
  | 'KNOWLEDGE_FACT_NEEDS_PERSON'
  | 'KNOWLEDGE_ARTIFACT_NOT_GROUNDED'
  | 'MCP_TOOL_NOT_APPROVED'
  | 'CLIENT_ONBOARDING_EXISTS';

const MESSAGES: Record<ErrorCode, string> = {
  IDEMPOTENCY_KEY_REUSED: 'This request key was already used with different details.',
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
  KNOWLEDGE_SOURCE_CLOSED: 'This source has been removed, and cannot be used again.',
  KNOWLEDGE_FORMAT_UNSUPPORTED: 'That kind of file cannot be added to company knowledge yet.',
  KNOWLEDGE_GRANT_TOO_WIDE: 'A source this sensitive cannot be shared that widely.',
  KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE:
    'Who can see this comes from where it is stored. Change it there.',
  KNOWLEDGE_NO_MODEL: 'No approved model can answer this. Your documents were not sent anywhere.',
  KNOWLEDGE_FACT_NEEDS_EVIDENCE:
    'A fact has to rest on a passage from a source that is still open.',
  KNOWLEDGE_FACT_NEEDS_PERSON:
    'Only a person who did not propose this fact can verify it, as themselves.',
  KNOWLEDGE_ARTIFACT_NOT_GROUNDED:
    'This cannot be accepted yet, because its citations have not all been confirmed.',
  MCP_TOOL_NOT_APPROVED: 'An administrator has not approved this tool.',
  CLIENT_ONBOARDING_EXISTS: 'This deal already has an onboarding.',
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
  IDEMPOTENCY_KEY_REUSED: 409,
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
  KNOWLEDGE_SOURCE_CLOSED: 409,
  KNOWLEDGE_FORMAT_UNSUPPORTED: 415,
  KNOWLEDGE_GRANT_TOO_WIDE: 403,
  KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE: 409,
  KNOWLEDGE_NO_MODEL: 409,
  KNOWLEDGE_FACT_NEEDS_EVIDENCE: 409,
  KNOWLEDGE_FACT_NEEDS_PERSON: 403,
  KNOWLEDGE_ARTIFACT_NOT_GROUNDED: 409,
  MCP_TOOL_NOT_APPROVED: 409,
  CLIENT_ONBOARDING_EXISTS: 409,
};

/** Reads the Postgres error code through the wrapper Drizzle adds. */
export function pgCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}
