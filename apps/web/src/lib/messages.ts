// Human wording for known error codes. Kept apart from server packages so components stay light.
// Each message says what happened and what to do next, in plain words: no codes, ids or operator terms.
/** The same words whether the browser or the server notices first. */
export const FILE_TOO_LARGE =
  'That file is larger than 25 MB, so it was not added. Attach a smaller one.';

const MESSAGE_FOR = new Map<string, string>([
  [
    'MODEL_PROFILE_NOT_ACTIVE',
    'This AI model is turned off, so it cannot be used. An administrator can turn it on in the AI model settings.',
  ],
  [
    'MODEL_PROBE_REQUIRED',
    'This AI model has to pass a quick connection test before anyone can use it. Run the test from its settings page.',
  ],
  [
    'MODEL_ENDPOINT_NOT_ALLOWED',
    'That address cannot be used for a model here. Use an address that whoever runs Ensemus for you has allowed.',
  ],
  [
    'MODEL_CREDENTIALS_NOT_REVIEWED',
    'Your own keys for hosted AI models cannot be used here yet. Whoever runs Ensemus for you can turn this on.',
  ],
  [
    'MODEL_UNAVAILABLE',
    'The approved AI model is not available right now, so nothing was sent. Your work is unchanged. Try again later.',
  ],
  [
    'RATE_CARD_MISSING',
    'This AI model has no prices set, so its cost cannot be tracked. Add its prices in the AI model settings first.',
  ],
  [
    'BUDGET_NOT_CONFIGURED',
    'No spending limit is set yet, so assistants cannot start. An administrator can set one in the budget settings.',
  ],
  [
    'BUDGET_EXHAUSTED',
    'The spending limit for this has been reached, so nothing more will run. An administrator can raise it.',
  ],
  [
    'ENTITLEMENT_DENIED',
    'Your plan does not include this. An owner of your organization can tell you about changing it.',
  ],
  [
    'POLICY_DENIED',
    'Your organization’s rules do not allow this. Ask an administrator if you think they should.',
  ],
  ['AGENT_SPEC_INVALID', 'This agent definition is not valid.'],
  [
    'AGENT_EVALUATION_REQUIRED',
    'This version needs a passing evaluation before it can be published. Attach a report that passes, then publish again.',
  ],
  [
    'AGENT_RUN_ACTIVE',
    'An assistant is already working on this. Wait for it to finish, or stop it first.',
  ],
  [
    'AGENT_RUN_NOT_CONTROLLABLE',
    'This assistant has already finished, so it can no longer be paused or stopped.',
  ],
  [
    'AI_HALTED',
    'Assistants are paused for everyone right now, so nothing new can start. Try again once they are back on.',
  ],
  [
    'KILL_SWITCH_NOT_YOURS',
    'Assistants were paused by whoever runs Ensemus for you, so only they can turn them back on.',
  ],
  ['TOOL_DENIED', 'This assistant is not allowed to do that, so it was not done.'],
  [
    'NO_ELIGIBLE_APPROVER',
    'Nobody else can approve this, so it was not sent. Ask an administrator to add someone who can.',
  ],
  [
    'DELEGATION_DENIED',
    'An assistant cannot hand another assistant more access than it has itself.',
  ],
  [
    'IDEMPOTENCY_KEY_REUSED',
    'This was already sent once with different details. Reload the page before you try again.',
  ],
  ['NOT_FOUND', 'We could not find that. It may have been removed, or it is not shared with you.'],
  ['FORBIDDEN', 'You do not have permission to do that.'],
  ['VERSION_CONFLICT', 'Someone else changed this first. Check the latest version and try again.'],
  [
    'INVALID_TRANSITION',
    'That status change is not allowed from where this work is now. Reload to see its current status.',
  ],
  [
    'PREREQUISITES_INCOMPLETE',
    'This work waits for other work that is not done yet. Finish that first, then try again.',
  ],
  [
    'EVIDENCE_MISSING',
    'This work cannot be marked done yet. Add what “Done when” asks for, then try again.',
  ],
  [
    'OWNER_CONFIRMATION_REQUIRED',
    'This work is set to “Owner confirms”, so only its owner can say it is done.',
  ],
  [
    'RUN_ALREADY_REQUESTED',
    'Someone already asked for this plan to run. That request still stands, so there is nothing more to do.',
  ],
  ['REASON_REQUIRED', 'Please give a reason, so others know why.'],
  [
    'DEPENDENCY_CYCLE',
    'That would make these pieces of work wait for each other forever, so it was not added.',
  ],
  [
    'TEAM_CYCLE',
    'A team cannot sit inside itself or inside one of its own teams. Choose a different parent.',
  ],
  [
    'INVALID_STATE',
    'That cannot be done while the work has this status. Reload to see where it stands.',
  ],
  ['INVALID_INPUT', 'Please check the details and try again.'],
  ['FILE_TOO_LARGE', FILE_TOO_LARGE],
  [
    'APPROVAL_NOT_PENDING',
    'This approval has already been decided or closed, so there is nothing left to do.',
  ],
  [
    'APPROVAL_EXPIRED',
    'The time to decide this approval has passed. Ask for a new one if it is still needed.',
  ],
  ['APPROVAL_WRONG_APPROVER', 'This approval is waiting for someone else to decide.'],
  [
    'APPROVAL_HASH_MISMATCH',
    'The action changed after you reviewed it. Please review it again before you decide.',
  ],
  [
    'APPROVAL_SELF_APPROVAL',
    'You cannot approve your own request. Someone else needs to decide it.',
  ],
  ['APPROVAL_STALE', 'This work changed after the review was requested. Ask for a new review.'],
  [
    'REVIEW_ALREADY_OPEN',
    'A review of this work is already waiting. It needs a decision before you ask for another.',
  ],
  [
    'INVITATION_INVALID',
    'This invitation is not valid. It may have been used already, run out, or been sent to a different email address. Ask the person who invited you for a new one.',
  ],
  ['LAST_OWNER', 'An organization must keep at least one owner. Make someone else an owner first.'],
  [
    'RESTORE_PENDING',
    'This organization is being restored from a backup. Try again in a little while.',
  ],
  [
    'TENANT_BUSY',
    'This organization is busy with another change right now, so nothing was changed. Try again in a moment.',
  ],
  [
    'EXTERNAL_ACTION_NOT_EDITABLE',
    'This can no longer be changed, because Ensemus has already tried to send it.',
  ],
  ['EXTERNAL_ACTION_NOT_RESOLVABLE', 'Only an action in an unknown state can be resolved.'],
  ['EXTERNAL_ACTION_NOT_RETRYABLE', 'Only something that was not sent can be tried again.'],
  [
    'CONNECTION_NOT_ACTIVE',
    'This connection is not working right now. Reconnect it, then try again.',
  ],
  ['CONNECTOR_NOT_AVAILABLE', 'This connector is not available on this deployment.'],
  [
    'RESTRICTED_NOT_ALLOWED',
    'Restricted work cannot be sent to outside services, so nothing was sent.',
  ],
  ['KNOWLEDGE_SOURCE_CLOSED', 'This source has been removed, so it cannot be used again.'],
  ['KNOWLEDGE_FORMAT_UNSUPPORTED', 'That kind of file cannot be added to company knowledge yet.'],
  [
    'KNOWLEDGE_GRANT_TOO_WIDE',
    'This source is too sensitive to share that widely. Choose fewer people.',
  ],
  [
    'KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE',
    'Who can see this comes from where it is stored. Change it there.',
  ],
  [
    'KNOWLEDGE_NO_MODEL',
    'No approved AI model can answer this, so your documents were not sent anywhere.',
  ],
  [
    'KNOWLEDGE_FACT_NEEDS_EVIDENCE',
    'A fact needs a supporting passage from a source that is still available.',
  ],
  [
    'KNOWLEDGE_FACT_NEEDS_PERSON',
    'Someone other than the person who suggested this fact has to verify it, signed in as themselves.',
  ],
  [
    'KNOWLEDGE_ARTIFACT_NOT_GROUNDED',
    'This cannot be accepted yet, because its sources have not all been checked.',
  ],
  ['MCP_TOOL_NOT_APPROVED', 'An administrator has not approved this tool yet.'],
  ['CLIENT_ONBOARDING_EXISTS', 'This deal already has an onboarding. Open that one instead.'],
  ['CAPABILITY_UNAVAILABLE', 'This is not available here yet.'],
  ['MFA_REQUIRED', 'Confirm it is you with your authenticator app, then try again.'],
  [
    'SSO_REQUIRED',
    'This organization asks you to sign in with your company account. On the sign-in page, choose “Sign in through your company”.',
  ],
  [
    'SSO_DOMAIN_NOT_VERIFIED',
    'Company sign-in is not ready for this email address yet. Whoever runs Ensemus for you needs to confirm the domain first.',
  ],
  ['SIMULATION_REQUIRED', 'Run a simulation first. Nothing is published without one.'],
  ['SIMULATION_STALE', 'This changed after it was simulated. Run the simulation again.'],
  [
    'REVIEW_SELF_DECISION',
    'This can do something risky, so someone other than you has to review it.',
  ],
  ['REVIEW_NOT_APPROVED', 'This has not been approved for publishing yet.'],
  ['GRAPH_INVALID', 'This workflow cannot be run as drawn. Fix what is marked and try again.'],
  ['DRAFT_INVALID', 'This agent cannot be published as set up. Fix what is marked and try again.'],
  ['OBJECT_SCHEMA_INVALID', 'That set of fields is not allowed. Fix what is marked and try again.'],
  [
    'OBJECT_RECORD_INVALID',
    'That does not fit this kind of record. Fix what is marked and try again.',
  ],
  ['PACK_INVALID', 'This pack cannot be installed, so nothing was changed.'],
  ['PACK_CAPABILITY_UNREVIEWED', 'Decide on everything this pack asks for first, then install it.'],
  ['PACK_NOT_ROLLBACKABLE', 'There is no earlier version of this pack to go back to.'],
  ['OUTCOME_CHANGED', 'This preview changed after you read it. Read it again.'],
  [
    'LICENSE_NOT_VALID',
    'That file could not be verified, so nothing was changed. Everything already installed stays as it was.',
  ],
  [
    'EXPORT_ALREADY_RUNNING',
    'An export of this organization is already running. Wait for it to finish.',
  ],
  ['EXPORT_NOT_READY', 'This export is not ready to download yet. Check back shortly.'],
  [
    'EXPORT_SUPERSEDED',
    'Data or access changed after this export started, so this copy can no longer be downloaded. Make a new export.',
  ],
  ['IMPORT_TARGET_NOT_EMPTY', 'An archive can only be imported into a new, empty organization.'],
  ['IMPORT_ALREADY_USED', 'This organization has already taken an archive.'],
  ['IMPORTED_PERSON_ALREADY_LINKED', 'This person has already been linked to a member.'],
  ['BILLING_NOT_ENABLED', 'Billing is not available here.'],
  ['RATE_CARD_NOT_APPROVED', 'Nothing can be billed until approved prices are in place.'],
  ['PLAN_NOT_AVAILABLE', 'That plan is not available. Choose another one.'],
  ['SUBSCRIPTION_EXISTS', 'This organization already has a subscription.'],
  ['NO_SUBSCRIPTION', 'This organization has no subscription yet.'],
  [
    'QUOTE_CHANGED',
    'The price changed after you saw it, so nothing was bought. Check it and try again.',
  ],
  ['TOP_UP_NOT_ALLOWED', 'This plan does not allow buying extra usage.'],
  [
    'TAX_TREATMENT_MISSING',
    'Tax for this place has not been set up, so no invoice can be issued yet.',
  ],
  [
    'TAX_PROVIDER_UNAVAILABLE',
    'Tax could not be worked out just now, so nothing was charged. Try again in a moment.',
  ],
  [
    'INVOICE_NOT_PAYABLE',
    'This invoice cannot be paid as it stands. It may already be paid or closed.',
  ],
  ['PAYMENT_NOT_RESOLVABLE', 'Only a payment whose result is unknown can be settled here.'],
  ['PAYMENT_PROCESSOR_NOT_CONFIGURED', 'Payments are not set up here yet.'],
  [
    'TENANT_READ_ONLY',
    'This organization is read-only, so nothing can be changed. Billing and support still work.',
  ],
  [
    'TENANT_SUSPENDED',
    'This organization is suspended. Its data is kept, and billing, export and support still work.',
  ],
  ['LEGAL_HOLD_ACTIVE', 'This is under a legal hold, so it cannot be deleted.'],
  ['RETENTION_BASIS_REQUIRED', 'A retention period needs to say who approved it.'],
  ['OFFBOARDING_IN_PROGRESS', 'This organization is already being closed down.'],
  [
    'OFFBOARDING_NOT_CANCELLABLE',
    'Erasing the data has started, so closing down can no longer be cancelled.',
  ],
  [
    'OFFBOARDING_CONFIRMATION_MISMATCH',
    'That does not match this organization’s name. Type the name exactly as shown.',
  ],
  ['BREAK_GLASS_DISABLED', 'Support access to your content is turned off here.'],
  ['BREAK_GLASS_NOT_AUTHORIZABLE', 'This request can no longer be decided.'],
  [
    'OAUTH_STATE_INVALID',
    'This sign-in link is not valid or has already been used. Start connecting again from the connections page.',
  ],
  ['OAUTH_DENIED', 'Access was not granted, so nothing was connected.'],
  [
    'OAUTH_CONSENT_REQUIRED',
    'That account needs an administrator to agree first, so nothing was connected. Ask one of its administrators to connect it.',
  ],
  [
    'OAUTH_SCOPE_REFUSED',
    'The service would not grant the access you chose, so nothing was connected. Choose less access, or ask an administrator of that account to allow it.',
  ],
  [
    'OAUTH_CLIENT_REJECTED',
    'The service did not accept the app you connected through, so nothing was connected. If it is your own app, check its client ID, secret and redirect address.',
  ],
  [
    'OAUTH_PROVIDER_ERROR',
    'The service stopped the sign-in with an error, so nothing was connected. Start again.',
  ],
  [
    'OAUTH_IDENTITY_INVALID',
    'The service did not say which account was connected, so nothing was connected. Start again, signed in with a work account. If it was Microsoft 365, an administrator of that directory can remove the app’s consent under Enterprise applications in Microsoft Entra.',
  ],
  ['OAUTH_EXPIRED', 'This took longer than ten minutes, so nothing was connected. Start again.'],
  [
    'OAUTH_EXCHANGE_FAILED',
    'The provider did not finish connecting, so nothing was connected. Start again. If it was Microsoft 365, an administrator of that directory can remove the app’s consent under Enterprise applications in Microsoft Entra.',
  ],
  [
    'OAUTH_SCOPES_INSUFFICIENT',
    'Some of the access you chose was not granted, so nothing was connected. Start again and allow all of it. If it was Microsoft 365, an administrator of that directory can remove the app’s consent under Enterprise applications in Microsoft Entra.',
  ],
  [
    'OAUTH_CLIENT_NOT_CONFIGURED',
    'The app chosen to connect through is not set up on this deployment, so nothing was connected. Start again with your own app’s details, or ask whoever runs Ensemus to set up its app.',
  ],
  ['OAUTH_CAPABILITY_UNAVAILABLE', 'That kind of access cannot be connected yet.'],
  [
    'MEMBER_CAPABILITY_NOT_ALLOWED',
    'Your organization does not let members connect that kind of access, so nothing was connected. Ask an administrator to allow it.',
  ],
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
