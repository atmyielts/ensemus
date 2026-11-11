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
  [
    'IDEMPOTENCY_KEY_REUSED',
    'This request was already submitted with different details. Reload before starting another.',
  ],
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
    'TENANT_BUSY',
    'This organization is busy with another change right now, so nothing was changed. Try again in a moment.',
  ],
  [
    'EXTERNAL_ACTION_NOT_EDITABLE',
    'This can no longer be changed, because Ensemus has already tried to send it.',
  ],
  ['EXTERNAL_ACTION_NOT_RESOLVABLE', 'Only an action in an unknown state can be resolved.'],
  ['EXTERNAL_ACTION_NOT_RETRYABLE', 'Only an action that was not sent can be asked for again.'],
  ['CONNECTION_NOT_ACTIVE', 'This connection is not active.'],
  ['CONNECTOR_NOT_AVAILABLE', 'This connector is not available on this deployment.'],
  ['RESTRICTED_NOT_ALLOWED', 'Restricted work cannot be sent outside this deployment.'],
  ['KNOWLEDGE_SOURCE_CLOSED', 'This source has been removed, and cannot be used again.'],
  ['KNOWLEDGE_FORMAT_UNSUPPORTED', 'That kind of file cannot be added to company knowledge yet.'],
  ['KNOWLEDGE_GRANT_TOO_WIDE', 'A source this sensitive cannot be shared that widely.'],
  [
    'KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE',
    'Who can see this comes from where it is stored. Change it there.',
  ],
  [
    'KNOWLEDGE_NO_MODEL',
    'No approved model can answer this. Your documents were not sent anywhere.',
  ],
  [
    'KNOWLEDGE_FACT_NEEDS_EVIDENCE',
    'A fact has to rest on a passage from a source that is still open.',
  ],
  [
    'KNOWLEDGE_FACT_NEEDS_PERSON',
    'Only a person who did not propose this fact can verify it, as themselves.',
  ],
  [
    'KNOWLEDGE_ARTIFACT_NOT_GROUNDED',
    'This cannot be accepted yet, because its citations have not all been confirmed.',
  ],
  ['MCP_TOOL_NOT_APPROVED', 'An administrator has not approved this tool.'],
  ['CLIENT_ONBOARDING_EXISTS', 'This deal already has an onboarding.'],
  ['CAPABILITY_UNAVAILABLE', 'This is not available on this deployment yet.'],
  ['MFA_REQUIRED', 'Confirm it is you with your authenticator app, then try again.'],
  ['SSO_REQUIRED', 'This organization asks you to sign in through its identity provider.'],
  ['SSO_DOMAIN_NOT_VERIFIED', 'This email domain has not been verified by the operator yet.'],
  ['SIMULATION_REQUIRED', 'Run a simulation first. Nothing is published without one.'],
  ['SIMULATION_STALE', 'This changed after it was simulated. Run the simulation again.'],
  ['REVIEW_SELF_DECISION', 'This asks for something risky, so someone else has to review it.'],
  ['REVIEW_NOT_APPROVED', 'This has not been approved for publishing.'],
  ['GRAPH_INVALID', 'This workflow cannot be run as drawn. Fix what is marked and try again.'],
  ['DRAFT_INVALID', 'This agent cannot be published as set up. Fix what is marked and try again.'],
  ['OBJECT_SCHEMA_INVALID', 'That shape is not allowed. Fix what is marked and try again.'],
  ['OBJECT_RECORD_INVALID', 'That does not fit this type. Fix what is marked and try again.'],
  ['PACK_INVALID', 'This pack cannot be installed.'],
  ['PACK_CAPABILITY_UNREVIEWED', 'Everything this pack asks for has to be decided first.'],
  ['PACK_NOT_ROLLBACKABLE', 'There is no earlier version of this pack to go back to.'],
  ['OUTCOME_CHANGED', 'This preview changed after you read it. Read it again.'],
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
  [
    'OAUTH_STATE_INVALID',
    'This sign-in link is not valid or has already been used. Start connecting again from the connections page.',
  ],
  ['OAUTH_DENIED', 'Access was not granted, so nothing was connected.'],
  ['OAUTH_EXPIRED', 'This took longer than ten minutes, so nothing was connected. Start again.'],
  [
    'OAUTH_EXCHANGE_FAILED',
    'The provider did not finish connecting, so nothing was connected. Start again.',
  ],
  [
    'OAUTH_SCOPES_INSUFFICIENT',
    'Some of the access you chose was not granted, so nothing was connected. Start again and allow all of it.',
  ],
  [
    'OAUTH_CLIENT_NOT_CONFIGURED',
    'Connecting through Ensemus’s own app is not set up on this deployment. Use your own app instead.',
  ],
  ['OAUTH_CAPABILITY_UNAVAILABLE', 'That kind of access cannot be connected yet.'],
  [
    'DIRECTORY_TEAM_READ_ONLY',
    'This team comes from your directory, so it changes only there. Change the group at the provider.',
  ],
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
