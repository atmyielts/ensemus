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
  // M8 (ADR-032).
  | 'BILLING_NOT_ENABLED'
  | 'RATE_CARD_NOT_APPROVED'
  | 'PLAN_NOT_AVAILABLE'
  | 'SUBSCRIPTION_EXISTS'
  | 'NO_SUBSCRIPTION'
  | 'QUOTE_CHANGED'
  | 'TOP_UP_NOT_ALLOWED'
  | 'TAX_TREATMENT_MISSING'
  | 'TAX_PROVIDER_UNAVAILABLE'
  | 'INVOICE_NOT_PAYABLE'
  | 'PAYMENT_NOT_RESOLVABLE'
  | 'PAYMENT_PROCESSOR_NOT_CONFIGURED'
  | 'TENANT_READ_ONLY'
  | 'TENANT_SUSPENDED'
  | 'LEGAL_HOLD_ACTIVE'
  | 'RETENTION_BASIS_REQUIRED'
  | 'OFFBOARDING_IN_PROGRESS'
  | 'OFFBOARDING_NOT_CANCELLABLE'
  | 'OFFBOARDING_CONFIRMATION_MISMATCH'
  | 'BREAK_GLASS_DISABLED'
  | 'BREAK_GLASS_NOT_AUTHORIZABLE';

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
  BILLING_NOT_ENABLED: 'Billing is not available on this deployment.',
  RATE_CARD_NOT_APPROVED: 'Nothing can be billed until an approved rate card is in place.',
  PLAN_NOT_AVAILABLE: 'That plan is not available.',
  SUBSCRIPTION_EXISTS: 'This organization already has a subscription.',
  NO_SUBSCRIPTION: 'This organization has no subscription.',
  QUOTE_CHANGED:
    'The price changed after you saw it, so nothing was bought. Check it and try again.',
  TOP_UP_NOT_ALLOWED: 'This plan does not allow top-ups.',
  TAX_TREATMENT_MISSING: 'Tax for this place has not been set up, so no invoice can be issued yet.',
  TAX_PROVIDER_UNAVAILABLE: 'Tax could not be worked out just now. Nothing was charged.',
  INVOICE_NOT_PAYABLE: 'This invoice cannot be paid in its current state.',
  PAYMENT_NOT_RESOLVABLE: 'Only a payment in an unknown state can be resolved.',
  PAYMENT_PROCESSOR_NOT_CONFIGURED: 'Payments are not set up on this deployment.',
  TENANT_READ_ONLY:
    'This organization is read-only, so nothing can be changed. Billing and support still work.',
  TENANT_SUSPENDED:
    'This organization is suspended. Its data is kept, and billing, export and support still work.',
  LEGAL_HOLD_ACTIVE: 'This is under a legal hold, so it cannot be deleted.',
  RETENTION_BASIS_REQUIRED: 'A retention period has to say whose sign-off it rests on.',
  OFFBOARDING_IN_PROGRESS: 'This organization is already being offboarded.',
  OFFBOARDING_NOT_CANCELLABLE: 'Erasure has started, so this can no longer be cancelled.',
  OFFBOARDING_CONFIRMATION_MISMATCH: 'That does not match this organization’s name.',
  BREAK_GLASS_DISABLED: 'Support access to content is turned off on this deployment.',
  BREAK_GLASS_NOT_AUTHORIZABLE: 'This request can no longer be decided.',
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
  BILLING_NOT_ENABLED: 409,
  RATE_CARD_NOT_APPROVED: 409,
  PLAN_NOT_AVAILABLE: 409,
  SUBSCRIPTION_EXISTS: 409,
  NO_SUBSCRIPTION: 409,
  QUOTE_CHANGED: 409,
  TOP_UP_NOT_ALLOWED: 409,
  TAX_TREATMENT_MISSING: 409,
  TAX_PROVIDER_UNAVAILABLE: 503,
  INVOICE_NOT_PAYABLE: 409,
  PAYMENT_NOT_RESOLVABLE: 409,
  PAYMENT_PROCESSOR_NOT_CONFIGURED: 409,
  TENANT_READ_ONLY: 403,
  TENANT_SUSPENDED: 403,
  LEGAL_HOLD_ACTIVE: 409,
  RETENTION_BASIS_REQUIRED: 400,
  OFFBOARDING_IN_PROGRESS: 409,
  OFFBOARDING_NOT_CANCELLABLE: 409,
  OFFBOARDING_CONFIRMATION_MISMATCH: 400,
  BREAK_GLASS_DISABLED: 409,
  BREAK_GLASS_NOT_AUTHORIZABLE: 409,
};

/** Reads the Postgres error code through the wrapper Drizzle adds. */
export function pgCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

/**
 * What PostgreSQL refused below the application, as what a person is told (ADR-032 D5, D6). A write in a
 * tenant that is not served in full, and a deletion under a legal hold, reach here from any path at all.
 */
export function refusalFromDatabase(error: unknown): AppError | null {
  const code = pgCode(error);
  if (code === '25006') return new AppError('TENANT_READ_ONLY');
  if (code === 'EN804') return new AppError('LEGAL_HOLD_ACTIVE');
  return null;
}
