// Runtime contracts for Pulse, the outcome composer and onboarding (ADR-031 D4, D5).
import { z } from 'zod';

export const setPulseSignalStateSchema = z
  .strictObject({
    state: z.enum(['open', 'dismissed', 'snoozed']),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((body) => (body.state === 'snoozed') === (body.until !== undefined), {
    path: ['until'],
  });
export type SetPulseSignalStateBody = z.infer<typeof setPulseSignalStateSchema>;

export const composeOutcomeSchema = z.strictObject({
  objective: z.string().trim().min(3).max(2000),
  /** Today where the person is, because "by Friday" means their Friday. */
  today: z.iso.date(),
});
export type ComposeOutcomeBody = z.infer<typeof composeOutcomeSchema>;

export const outcomePreviewSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(2000),
  dueAt: z.iso.date().nullable(),
  ownerMembershipId: z.uuid(),
  successCriteria: z
    .array(
      z.strictObject({
        kind: z.enum(['artifact_named', 'reviewer_approved', 'none']),
        label: z.string().trim().min(1).max(200),
      }),
    )
    .max(20),
  dependencyWorkUnitIds: z.array(z.uuid()).max(20),
  suggestedProcessKey: z.string().max(64).nullable(),
  classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  dataAccess: z.strictObject({
    usesAgent: z.boolean(),
    reachesExternalService: z.boolean(),
    reasonCodes: z.array(z.string().max(64)).max(20),
  }),
  uncertainties: z
    .array(z.enum(['due_date_unclear', 'owner_assumed', 'no_success_criteria']))
    .max(3),
});
export type OutcomePreviewBody = z.infer<typeof outcomePreviewSchema>;

export const authorizeOutcomeSchema = z.strictObject({
  /** The hash of what the person was reading. It has to match what is stored now. */
  preview_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AuthorizeOutcomeBody = z.infer<typeof authorizeOutcomeSchema>;

export const decideOnboardingStepSchema = z.strictObject({
  decision: z.enum(['acknowledged', 'skipped']),
});
export type DecideOnboardingStepBody = z.infer<typeof decideOnboardingStepSchema>;
