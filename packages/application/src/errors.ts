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
  | 'TENANT_BUSY'
  | 'EXTERNAL_ACTION_NOT_EDITABLE'
  | 'EXTERNAL_ACTION_NOT_RESOLVABLE'
  | 'EXTERNAL_ACTION_NOT_RETRYABLE'
  | 'CONNECTION_NOT_ACTIVE'
  | 'CONNECTOR_NOT_AVAILABLE'
  | 'RESTRICTED_NOT_ALLOWED'
  | 'MODEL_PROFILE_NOT_ACTIVE'
  | 'MODEL_PROBE_REQUIRED'
  | 'MODEL_ENDPOINT_NOT_ALLOWED'
  | 'MODEL_CREDENTIALS_NOT_REVIEWED'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_CARD_MISSING'
  | 'BUDGET_NOT_CONFIGURED'
  | 'BUDGET_EXHAUSTED'
  | 'ENTITLEMENT_DENIED'
  | 'POLICY_DENIED'
  | 'AGENT_SPEC_INVALID'
  | 'AGENT_EVALUATION_REQUIRED'
  | 'AGENT_RUN_ACTIVE'
  | 'AGENT_RUN_NOT_CONTROLLABLE'
  | 'AI_HALTED'
  | 'KILL_SWITCH_NOT_YOURS'
  | 'TOOL_DENIED'
  | 'NO_ELIGIBLE_APPROVER'
  | 'DELEGATION_DENIED'
  | 'KNOWLEDGE_SOURCE_CLOSED'
  | 'KNOWLEDGE_FORMAT_UNSUPPORTED'
  | 'KNOWLEDGE_GRANT_TOO_WIDE'
  | 'KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE'
  | 'KNOWLEDGE_NO_MODEL'
  | 'KNOWLEDGE_FACT_NEEDS_EVIDENCE'
  | 'KNOWLEDGE_FACT_NEEDS_PERSON'
  | 'KNOWLEDGE_ARTIFACT_NOT_GROUNDED'
  | 'MCP_TOOL_NOT_APPROVED'
  | 'CLIENT_ONBOARDING_EXISTS'
  | 'CAPABILITY_UNAVAILABLE'
  | 'MFA_REQUIRED'
  | 'SSO_REQUIRED'
  | 'SSO_DOMAIN_NOT_VERIFIED'
  | 'SIMULATION_REQUIRED'
  | 'SIMULATION_STALE'
  | 'REVIEW_SELF_DECISION'
  | 'REVIEW_NOT_APPROVED'
  | 'GRAPH_INVALID'
  | 'DRAFT_INVALID'
  | 'OBJECT_SCHEMA_INVALID'
  | 'OBJECT_RECORD_INVALID'
  | 'PACK_INVALID'
  | 'PACK_CAPABILITY_UNREVIEWED'
  | 'PACK_NOT_ROLLBACKABLE'
  | 'OUTCOME_CHANGED'
  | 'LICENSE_NOT_VALID'
  | 'EXPORT_ALREADY_RUNNING'
  | 'EXPORT_NOT_READY'
  | 'EXPORT_SUPERSEDED'
  | 'IMPORT_TARGET_NOT_EMPTY'
  | 'IMPORT_ALREADY_USED'
  | 'IMPORTED_PERSON_ALREADY_LINKED'
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
  | 'OBJECT_DELETE_UNCONFIRMED'
  | 'OBJECT_DELETE_IN_PROGRESS'
  | 'RETENTION_BASIS_REQUIRED'
  | 'OFFBOARDING_IN_PROGRESS'
  | 'OFFBOARDING_NOT_CANCELLABLE'
  | 'OFFBOARDING_CONFIRMATION_MISMATCH'
  | 'BREAK_GLASS_DISABLED'
  | 'BREAK_GLASS_NOT_AUTHORIZABLE'
  // Workspace suites (ADR-038).
  | 'OAUTH_STATE_INVALID'
  | 'OAUTH_DENIED'
  | 'OAUTH_EXPIRED'
  | 'OAUTH_EXCHANGE_FAILED'
  | 'OAUTH_SCOPES_INSUFFICIENT'
  | 'OAUTH_CLIENT_NOT_CONFIGURED'
  | 'OAUTH_CAPABILITY_UNAVAILABLE'
  | 'DIRECTORY_TEAM_READ_ONLY';

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
  TENANT_BUSY:
    'This organization is busy with another change right now, so nothing was changed. Try again in a moment.',
  EXTERNAL_ACTION_NOT_EDITABLE:
    'This can no longer be changed, because Ensemus has already tried to send it.',
  EXTERNAL_ACTION_NOT_RESOLVABLE: 'Only an action in an unknown state can be resolved.',
  EXTERNAL_ACTION_NOT_RETRYABLE: 'Only an action that was not sent can be asked for again.',
  CONNECTION_NOT_ACTIVE: 'This connection is not active.',
  CONNECTOR_NOT_AVAILABLE: 'This connector is not available on this deployment.',
  RESTRICTED_NOT_ALLOWED: 'Restricted work cannot be sent outside this deployment.',
  MODEL_PROFILE_NOT_ACTIVE: 'This model profile is not active.',
  MODEL_PROBE_REQUIRED: 'This model profile has to pass its test before it can be used.',
  MODEL_ENDPOINT_NOT_ALLOWED: 'That address cannot be used for a model on this deployment.',
  MODEL_CREDENTIALS_NOT_REVIEWED:
    'Keys for hosted providers are not enabled on this deployment yet.',
  MODEL_UNAVAILABLE:
    'The approved model is not available, so nothing was sent. Your work is unchanged.',
  RATE_CARD_MISSING: 'This model profile has no rate card, so its cost cannot be measured.',
  BUDGET_NOT_CONFIGURED: 'No budget is set, so agents cannot run yet.',
  BUDGET_EXHAUSTED: 'The budget for this has been used up.',
  ENTITLEMENT_DENIED: 'Your plan does not include this.',
  POLICY_DENIED: 'Your organization’s policy does not allow this.',
  AGENT_SPEC_INVALID: 'This agent definition is not valid.',
  AGENT_EVALUATION_REQUIRED:
    'This agent version needs a passing evaluation before it can be published.',
  AGENT_RUN_ACTIVE: 'An agent is already running on this work.',
  AGENT_RUN_NOT_CONTROLLABLE: 'This run has finished, so it cannot be changed.',
  AI_HALTED: 'Agents are stopped on this deployment right now.',
  KILL_SWITCH_NOT_YOURS: 'This stop was set by the operator of this deployment.',
  TOOL_DENIED: 'This agent is not allowed to do that.',
  NO_ELIGIBLE_APPROVER: 'Nobody else can approve this, so it was not sent.',
  DELEGATION_DENIED: 'An agent cannot give another agent more than it has itself.',
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
  CAPABILITY_UNAVAILABLE: 'This is not available on this deployment yet.',
  MFA_REQUIRED: 'Confirm it is you with your authenticator app, then try again.',
  SSO_REQUIRED: 'This organization asks you to sign in through its identity provider.',
  SSO_DOMAIN_NOT_VERIFIED: 'This email domain has not been verified by the operator yet.',
  SIMULATION_REQUIRED: 'Run a simulation first. Nothing is published without one.',
  SIMULATION_STALE: 'This changed after it was simulated. Run the simulation again.',
  REVIEW_SELF_DECISION: 'This asks for something risky, so someone else has to review it.',
  REVIEW_NOT_APPROVED: 'This has not been approved for publishing.',
  GRAPH_INVALID: 'This workflow cannot be run as drawn. Fix what is marked and try again.',
  DRAFT_INVALID: 'This agent cannot be published as set up. Fix what is marked and try again.',
  OBJECT_SCHEMA_INVALID: 'That shape is not allowed. Fix what is marked and try again.',
  OBJECT_RECORD_INVALID: 'That does not fit this type. Fix what is marked and try again.',
  PACK_INVALID: 'This pack cannot be installed.',
  PACK_CAPABILITY_UNREVIEWED: 'Everything this pack asks for has to be decided first.',
  PACK_NOT_ROLLBACKABLE: 'There is no earlier version of this pack to go back to.',
  OUTCOME_CHANGED: 'This preview changed after you read it. Read it again.',
  LICENSE_NOT_VALID:
    'That file could not be verified, so nothing was changed. Everything already installed stays as it was.',
  EXPORT_ALREADY_RUNNING: 'An export of this organization is already running.',
  EXPORT_NOT_READY: 'This export is not ready to download.',
  EXPORT_SUPERSEDED:
    'Data or access changed after this export started, so this copy can no longer be downloaded. Make a new export.',
  IMPORT_TARGET_NOT_EMPTY: 'An archive can only be imported into a new, empty organization.',
  IMPORT_ALREADY_USED: 'This organization has already taken an archive.',
  IMPORTED_PERSON_ALREADY_LINKED: 'This person has already been linked to a member.',
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
  OBJECT_DELETE_UNCONFIRMED:
    'Storage has not confirmed this deletion. Its recovery evidence must be reviewed before trying again.',
  OBJECT_DELETE_IN_PROGRESS:
    'A file deletion is already in progress or unconfirmed. A new hold cannot promise to preserve those bytes yet.',
  RETENTION_BASIS_REQUIRED: 'A retention period has to say whose sign-off it rests on.',
  OFFBOARDING_IN_PROGRESS: 'This organization is already being offboarded.',
  OFFBOARDING_NOT_CANCELLABLE: 'Erasure has started, so this can no longer be cancelled.',
  OFFBOARDING_CONFIRMATION_MISMATCH: 'That does not match this organization’s name.',
  BREAK_GLASS_DISABLED: 'Support access to content is turned off on this deployment.',
  BREAK_GLASS_NOT_AUTHORIZABLE: 'This request can no longer be decided.',
  OAUTH_STATE_INVALID:
    'This sign-in link is not valid or has already been used. Start connecting again from the connections page.',
  OAUTH_DENIED: 'Access was not granted, so nothing was connected.',
  OAUTH_EXPIRED: 'This took longer than ten minutes, so nothing was connected. Start again.',
  OAUTH_EXCHANGE_FAILED:
    'The provider did not finish connecting, so nothing was connected. Start again. If it was Microsoft 365, an administrator of that directory can remove the app’s consent under Enterprise applications in Microsoft Entra.',
  OAUTH_SCOPES_INSUFFICIENT:
    'Some of the access you chose was not granted, so nothing was connected. Start again and allow all of it. If it was Microsoft 365, an administrator of that directory can remove the app’s consent under Enterprise applications in Microsoft Entra.',
  OAUTH_CLIENT_NOT_CONFIGURED:
    'The app chosen to connect through is not set up on this deployment, so nothing was connected. Start again with your own app’s details, or ask whoever runs Ensemus to set up its app.',
  OAUTH_CAPABILITY_UNAVAILABLE: 'That kind of access cannot be connected yet.',
  DIRECTORY_TEAM_READ_ONLY:
    'This team comes from your directory, so it changes only there. Change the group at the provider.',
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
  TENANT_BUSY: 503,
  EXTERNAL_ACTION_NOT_EDITABLE: 409,
  EXTERNAL_ACTION_NOT_RESOLVABLE: 409,
  EXTERNAL_ACTION_NOT_RETRYABLE: 409,
  CONNECTION_NOT_ACTIVE: 409,
  CONNECTOR_NOT_AVAILABLE: 409,
  RESTRICTED_NOT_ALLOWED: 403,
  MODEL_PROFILE_NOT_ACTIVE: 409,
  MODEL_PROBE_REQUIRED: 409,
  MODEL_ENDPOINT_NOT_ALLOWED: 400,
  MODEL_CREDENTIALS_NOT_REVIEWED: 409,
  MODEL_UNAVAILABLE: 503,
  RATE_CARD_MISSING: 409,
  BUDGET_NOT_CONFIGURED: 409,
  BUDGET_EXHAUSTED: 409,
  ENTITLEMENT_DENIED: 403,
  POLICY_DENIED: 403,
  AGENT_SPEC_INVALID: 400,
  AGENT_EVALUATION_REQUIRED: 409,
  AGENT_RUN_ACTIVE: 409,
  AGENT_RUN_NOT_CONTROLLABLE: 409,
  AI_HALTED: 503,
  KILL_SWITCH_NOT_YOURS: 403,
  TOOL_DENIED: 403,
  NO_ELIGIBLE_APPROVER: 409,
  DELEGATION_DENIED: 403,
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
  CAPABILITY_UNAVAILABLE: 409,
  MFA_REQUIRED: 403,
  SSO_REQUIRED: 403,
  SSO_DOMAIN_NOT_VERIFIED: 409,
  SIMULATION_REQUIRED: 409,
  SIMULATION_STALE: 409,
  REVIEW_SELF_DECISION: 403,
  REVIEW_NOT_APPROVED: 409,
  GRAPH_INVALID: 400,
  DRAFT_INVALID: 400,
  OBJECT_SCHEMA_INVALID: 400,
  OBJECT_RECORD_INVALID: 400,
  PACK_INVALID: 400,
  PACK_CAPABILITY_UNREVIEWED: 409,
  PACK_NOT_ROLLBACKABLE: 409,
  OUTCOME_CHANGED: 409,
  LICENSE_NOT_VALID: 400,
  EXPORT_ALREADY_RUNNING: 409,
  EXPORT_NOT_READY: 409,
  EXPORT_SUPERSEDED: 410,
  IMPORT_TARGET_NOT_EMPTY: 409,
  IMPORT_ALREADY_USED: 409,
  IMPORTED_PERSON_ALREADY_LINKED: 409,
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
  OBJECT_DELETE_UNCONFIRMED: 409,
  OBJECT_DELETE_IN_PROGRESS: 409,
  RETENTION_BASIS_REQUIRED: 400,
  OFFBOARDING_IN_PROGRESS: 409,
  OFFBOARDING_NOT_CANCELLABLE: 409,
  OFFBOARDING_CONFIRMATION_MISMATCH: 400,
  BREAK_GLASS_DISABLED: 409,
  BREAK_GLASS_NOT_AUTHORIZABLE: 409,
  OAUTH_STATE_INVALID: 400,
  OAUTH_DENIED: 409,
  OAUTH_EXPIRED: 409,
  OAUTH_EXCHANGE_FAILED: 409,
  OAUTH_SCOPES_INSUFFICIENT: 409,
  OAUTH_CLIENT_NOT_CONFIGURED: 409,
  OAUTH_CAPABILITY_UNAVAILABLE: 400,
  DIRECTORY_TEAM_READ_ONLY: 409,
};

/**
 * How many links of an error's cause chain pgCode reads, starting at error.cause. Drizzle puts
 * PostgreSQL's own error one link down (DrizzleQueryError's cause), and a transaction helper or the
 * application may wrap that wrapper once or twice more before a caller sees it: five links cover the
 * deepest of those with room to spare, and the bound keeps the walk finite on a cyclic or very long chain.
 */
export const PG_CAUSE_DEPTH = 5;

/**
 * A SQLSTATE: five digits or upper-case letters, PostgreSQL's own (55P03) and Ensemus's raised ones
 * (EN850) alike. An AppError's own code (TENANT_BUSY) never has this shape.
 */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Reads the Postgres error code below the wrapper Drizzle adds: the first SQLSTATE found walking down the
 * cause chain from error.cause, at most PG_CAUSE_DEPTH links. The error itself is never read, so a thrown
 * error's own code is never taken for PostgreSQL's, and neither is the code of an AppError anywhere in the
 * chain. Drizzle's own shape, PostgreSQL's error as error.cause, reads exactly as it always has.
 */
export function pgCode(error: unknown): string | undefined {
  let link: unknown = error;
  for (let depth = 0; depth < PG_CAUSE_DEPTH; depth++) {
    if (!link || typeof link !== 'object') return undefined;
    link = (link as { cause?: unknown }).cause;
    if (!link || typeof link !== 'object' || link instanceof AppError) continue;
    const code = (link as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE.test(code)) return code;
  }
  return undefined;
}

/**
 * PostgreSQL's lock_not_available: a NOWAIT row lock, or a statement past its lock_timeout, found a row
 * held by another transaction, and the transaction that asked was rolled back whole. The usual holder is
 * a background purge in the same tenant: a record or source purge holds the tenant's organization row
 * FOR NO KEY UPDATE NOWAIT (0514-0516), and the erasure birth fence takes that row FOR SHARE NOWAIT on
 * every insert it guards (0508, 0533), so such an insert is refused at once instead of waiting.
 */
export const LOCK_NOT_AVAILABLE = '55P03';

/** How long a caller refused as TENANT_BUSY is asked to wait before it sends the same request again. */
export const TENANT_BUSY_RETRY_AFTER_SECONDS = 1;

/**
 * Refusals after which the identical request can be sent again: it did nothing, and what stood in its
 * way ends without the caller doing anything. Every other refusal needs the caller to change something.
 */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'RESTORE_PENDING',
  'TENANT_BUSY',
]);

/**
 * Lock contention as the refusal a person is told: the tenant is busy, nothing was changed, and the same
 * request can be sent again. It is never a version conflict, because nothing the caller read has changed.
 * The lock refusal is found however deeply it is wrapped, within PG_CAUSE_DEPTH links (pgCode).
 */
export function busyFromDatabase(error: unknown): AppError | null {
  return pgCode(error) === LOCK_NOT_AVAILABLE ? new AppError('TENANT_BUSY') : null;
}

/**
 * What PostgreSQL refused below the application, as what a person is told (ADR-032 D5, D6). A write in a
 * tenant that is not served in full, and a deletion under a legal hold, reach here from any path at all,
 * and so does a write refused because a purge in the same tenant held a row it needed (TENANT_BUSY).
 */
export function refusalFromDatabase(error: unknown): AppError | null {
  const code = pgCode(error);
  const busy = busyFromDatabase(error);
  if (busy) return busy;
  if (code === '25006') return new AppError('TENANT_READ_ONLY');
  if (code === 'EN850') return new AppError('OBJECT_DELETE_UNCONFIRMED');
  if (code === 'EN851') return new AppError('OBJECT_DELETE_IN_PROGRESS');
  if (code === 'EN804') return new AppError('LEGAL_HOLD_ACTIVE');
  return null;
}
