import { z } from 'zod';

// ADR-024 D2: only identifiers, enums and counters cross Temporal. Strict objects reject any extra
// field, and these types leave no room for free text.
export const probeInputSchema = z.strictObject({ probeId: z.uuid() });
export type ProbeInput = z.infer<typeof probeInputSchema>;

export const probeResultSchema = z.strictObject({
  probeId: z.uuid(),
  outcome: z.enum(['completed']),
  steps: z.int().min(0),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

export type ProbeStep = 'started' | 'finished';

export const workInputSchema = z.strictObject({
  organizationId: z.uuid(),
  workUnitId: z.uuid(),
});
export type WorkInput = z.infer<typeof workInputSchema>;

/** What Activities receive: the workflow's input, and which run of it is asking. */
export type RunInput = WorkInput & { runId: string };

export const tenantInputSchema = z.strictObject({ organizationId: z.uuid() });
export type TenantInput = z.infer<typeof tenantInputSchema>;

export type WorkOutcome = 'completed' | 'verifying' | 'cancelled' | 'denied' | 'expired' | 'failed';
export type WorkResult = { workUnitId: string; outcome: WorkOutcome };

export type PreparedWork = {
  status: 'running' | 'stopped';
  needsReview: boolean;
};

export type ReviewRequest = { approvalId: string; expiresAtMs: number };
export type ReviewState = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export const workflowIdFor = (input: WorkInput) =>
  `work-${input.organizationId}-${input.workUnitId}`;
export const reminderScheduleIdFor = (organizationId: string) => `reminders-${organizationId}`;

// --- M3 (ADR-027). The same rule: IDs, enums and counters, with no recipient, cursor or provider text.

export const externalActionInputSchema = z.strictObject({
  organizationId: z.uuid(),
  externalActionId: z.uuid(),
});
export type ExternalActionInput = z.infer<typeof externalActionInputSchema>;
export const externalActionWorkflowIdFor = (input: ExternalActionInput) =>
  `external-action-${input.organizationId}-${input.externalActionId}`;

/** What the workflow ended on. `unknown` is honest: it stopped, and a person takes it from there. */
export type ExternalActionOutcome = 'sent' | 'failed' | 'unknown' | 'cancelled';
export type ExternalActionResult = { externalActionId: string; outcome: ExternalActionOutcome };

/** What one send Activity reports. It carries no payload and no provider text. */
export type SendStep =
  | { step: 'sent' | 'failed' | 'cancelled' | 'unknown' }
  /** Definitely not sent, and worth trying again after this long. */
  | { step: 'retry'; afterMs: number }
  /** An attempt could have sent, and only the provider can say. */
  | { step: 'reconcile' };
export type InterruptedStep = 'nothing_sent' | 'attempt_open' | 'settled';
export type ReconcileStepResult = 'sent' | 'failed' | 'retry' | 'unknown';

export const webhookDeliveryInputSchema = z.strictObject({
  organizationId: z.uuid(),
  deliveryId: z.uuid(),
});
export type WebhookDeliveryInput = z.infer<typeof webhookDeliveryInputSchema>;
export const webhookWorkflowIdFor = (input: WebhookDeliveryInput) =>
  `webhook-${input.organizationId}-${input.deliveryId}`;
export type WebhookDeliveryOutcome = 'applied' | 'duplicate' | 'rejected' | 'skipped';

export const connectorSyncInputSchema = z.strictObject({
  organizationId: z.uuid(),
  connectionId: z.uuid(),
});
export type ConnectorSyncInput = z.infer<typeof connectorSyncInputSchema>;
export const connectorSyncWorkflowIdFor = (input: ConnectorSyncInput) =>
  `connector-sync-${input.organizationId}-${input.connectionId}`;
/**
 * The same workflow, for a revoke. Its own ID, because a sync run already open could have read the row
 * before the revoke committed, and a start that finds it open would then stop the sealed secret never.
 */
export const connectorRevokeWorkflowIdFor = (input: ConnectorSyncInput) =>
  `connector-revoke-${input.organizationId}-${input.connectionId}`;
/** What the Activity did, from the connection's row: read its streams, or revoke its secret. */
export type ConnectorSyncOutcome = {
  outcome: 'synced' | 'revoked' | 'nothing_to_do' | 'failed';
  pages: number;
  resources: number;
};

// --- Workspace suites (ADR-038 D1). The exchange carries the consent attempt's IDs and nothing else: no
// code, verifier, state, client or token ever crosses Temporal. The Activity reads and unseals them itself.

export const oauthExchangeInputSchema = z.strictObject({
  organizationId: z.uuid(),
  authorizationId: z.uuid(),
});
export type OAuthExchangeInput = z.infer<typeof oauthExchangeInputSchema>;
/** One workflow per attempt, so a repeated event finds the first one and never sends a code twice. */
export const oauthExchangeWorkflowIdFor = (input: OAuthExchangeInput) =>
  `oauth-exchange-${input.organizationId}-${input.authorizationId}`;
/** The suite upkeep's schedule, one per tenant (ADR-038 D1, D4). */
export const suiteUpkeepScheduleIdFor = (organizationId: string) =>
  `suite-upkeep-${organizationId}`;
/** A run the web tier asked for by ending an attempt. One per attempt, so a repeated event finds it. */
export const suiteUpkeepWorkflowIdFor = (organizationId: string, authorizationId: string) =>
  `suite-upkeep-${organizationId}-${authorizationId}`;
/** Where the attempt ended. `already_settled` means another run, or the expiry, got there first. */
export type OAuthExchangeOutcome = {
  outcome: 'connected' | 'failed' | 'expired' | 'already_settled';
  connectionId: string | null;
};

// --- M6 (ADR-030). The same rule again: an archive's records, keys and names never come through here.

export const organizationExportInputSchema = z.strictObject({
  organizationId: z.uuid(),
  exportId: z.uuid(),
});
export type OrganizationExportInput = z.infer<typeof organizationExportInputSchema>;
export const organizationExportWorkflowIdFor = (input: OrganizationExportInput) =>
  `organization-export-${input.organizationId}-${input.exportId}`;
export type OrganizationExportResult = {
  exportId: string;
  outcome: 'ready' | 'failed';
  parts: number;
};
// --- M11B (ADR-034). The same rule: IDs, enums and counters, with no manifest, input, output or job text.

export const skillVerificationInputSchema = z.strictObject({
  organizationId: z.uuid(),
  skillVersionId: z.uuid(),
});
export type SkillVerificationInput = z.infer<typeof skillVerificationInputSchema>;
export const skillVerificationWorkflowIdFor = (input: SkillVerificationInput) =>
  `skill-verification-${input.organizationId}-${input.skillVersionId}`;
export type SkillVerificationOutcome = 'verified' | 'rejected';

/** What the check Activity found. Content stays in PostgreSQL, so fixtures go by their runs' IDs. */
export type SkillCheckStep =
  /** Refused or already finished, and the row says so. */
  | { step: 'finished'; outcome: SkillVerificationOutcome }
  /** No code to run. The contract test passed and the row is verified. */
  | { step: 'run_fixtures'; sandboxRunIds: readonly string[] };

export const sandboxRunInputSchema = z.strictObject({
  organizationId: z.uuid(),
  sandboxRunId: z.uuid(),
});
export type SandboxRunInput = z.infer<typeof sandboxRunInputSchema>;
export const sandboxRunWorkflowIdFor = (input: SandboxRunInput) =>
  `sandbox-run-${input.organizationId}-${input.sandboxRunId}`;

/** The enum a run ended on, exactly as its row says. No text from the job. */
export type SandboxRunOutcome =
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'memory_exceeded'
  | 'output_exceeded'
  | 'denied'
  | 'cancelled'
  | 'runner_unavailable';
export type SandboxRunResult = { sandboxRunId: string; outcome: SandboxRunOutcome };

/** What one execute Activity reports. */
export type SandboxExecuteStep =
  | { step: 'settled'; outcome: SandboxRunOutcome }
  /** At the tenant's ceiling. Worth waiting, and costs no attempt. */
  | { step: 'busy'; afterMs: number }
  /** The runner did not answer, the row is queued again, and nothing it did can have left. */
  | { step: 'retry'; afterMs: number };

export const marketplaceInstallInputSchema = z.strictObject({
  organizationId: z.uuid(),
  installationId: z.uuid(),
});
export type MarketplaceInstallInput = z.infer<typeof marketplaceInstallInputSchema>;
export const marketplaceInstallWorkflowIdFor = (input: MarketplaceInstallInput) =>
  `marketplace-install-${input.organizationId}-${input.installationId}`;
export type MarketplaceInstallOutcome = 'installed' | 'failed';
export type MarketplaceInstallStep =
  { step: 'failed' } | { step: 'verify'; skillVersionId: string };
// --- M11C (ADR-035 D3). The same rule again: which item, under which grant, and what became of it. No
// title, no body, no organization name and no token ever goes through here.

export const federationItemInputSchema = z.strictObject({
  organizationId: z.uuid(),
  itemId: z.uuid(),
});
export type FederationItemInput = z.infer<typeof federationItemInputSchema>;
export const federationDeliveryWorkflowIdFor = (input: FederationItemInput) =>
  `federation-delivery-${input.organizationId}-${input.itemId}`;
export const federationWithdrawalWorkflowIdFor = (input: FederationItemInput) =>
  `federation-withdrawal-${input.organizationId}-${input.itemId}`;
export type FederationDeliveryOutcome = 'delivered' | 'closed' | 'refused' | 'withdrawn';
export type FederationDeliveryResult = { itemId: string; outcome: FederationDeliveryOutcome };

const federationGrantInputSchema = z.strictObject({
  organizationId: z.uuid(),
  grantId: z.uuid(),
});
export const federationGrantAcceptedInputSchema = federationGrantInputSchema;
export type FederationGrantAcceptedInput = z.infer<typeof federationGrantAcceptedInputSchema>;
export const federationGrantAcceptedWorkflowIdFor = (input: FederationGrantAcceptedInput) =>
  `federation-grant-accepted-${input.grantId}`;

export const federationGrantEndedInputSchema = federationGrantInputSchema;
export type FederationGrantEndedInput = z.infer<typeof federationGrantEndedInputSchema>;
export const federationPurgeWorkflowIdFor = (input: FederationGrantEndedInput) =>
  `federation-purge-${input.grantId}`;

/** A whole grant's copies when it ended, or one item's when it was withdrawn. */
export type FederationPurgeInput = FederationGrantEndedInput | FederationItemInput;
/** How many copies one pass purged, and whether another pass is needed. */
export type FederationPurgePass = { purged: number; more: boolean };
export type FederationPurgeResult = { purged: number };

/** Parses the IDs back out of a workflow ID. The dispatcher builds these, so the format is ours. */
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// --- M11A (ADR-033). The same rule: IDs, enums and counters, with no note, title, field or model text.

export const meetingDerivationInputSchema = z.strictObject({
  organizationId: z.uuid(),
  derivationRunId: z.uuid(),
});
export type MeetingDerivationInput = z.infer<typeof meetingDerivationInputSchema>;
export const meetingDerivationWorkflowIdFor = (input: MeetingDerivationInput) =>
  `meeting-derivation-${input.organizationId}-${input.derivationRunId}`;
/** `dropped` means consent went while the model was thinking, and nothing of its answer was kept. */
export type MeetingDerivationOutcome = 'completed' | 'failed' | 'refused' | 'dropped';

export const meetingImportInputSchema = z.strictObject({
  organizationId: z.uuid(),
  importRequestId: z.uuid(),
});
export type MeetingImportInput = z.infer<typeof meetingImportInputSchema>;
export const meetingImportWorkflowIdFor = (input: MeetingImportInput) =>
  `meeting-import-${input.organizationId}-${input.importRequestId}`;
export type MeetingImportOutcome = 'completed' | 'failed' | 'refused';
