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
/** What the Activity did, from the connection's row: read its streams, or revoke its secret. */
export type ConnectorSyncOutcome = {
  outcome: 'synced' | 'revoked' | 'nothing_to_do' | 'failed';
  pages: number;
  resources: number;
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
  | { step: 'failed' }
  | { step: 'verify'; skillVersionId: string };

/** Parses the IDs back out of a workflow ID. The dispatcher builds these, so the format is ours. */
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
