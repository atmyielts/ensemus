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

export const tenantInputSchema = z.strictObject({ organizationId: z.uuid() });
export type TenantInput = z.infer<typeof tenantInputSchema>;

export type WorkOutcome = 'completed' | 'cancelled' | 'denied' | 'expired' | 'failed';
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

/** Parses the IDs back out of a workflow ID. The dispatcher builds these, so the format is ours. */
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
