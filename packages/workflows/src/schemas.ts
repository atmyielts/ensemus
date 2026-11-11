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

/** Parses the IDs back out of a workflow ID. The dispatcher builds these, so the format is ours. */
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
