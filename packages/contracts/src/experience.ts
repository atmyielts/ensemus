// Runtime contracts for Pulse, the outcome composer and onboarding (ADR-031 D4, D5).
import { z } from 'zod';

export const pulseQuerySchema = z.strictObject({
  include_dismissed: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const companyPulseSchema = z.strictObject({
  generated_at: z.iso.datetime({ offset: true }),
  signals: z.array(
    z.strictObject({
      key: z.string().max(128),
      kind: z.enum([
        'work_overdue',
        'work_due_soon',
        'work_blocked_by_prerequisite',
        'work_owner_disabled',
        'approval_waiting_past_expiry_window',
        'external_action_unknown',
        'external_action_failed',
        'process_run_failed',
        'agent_run_stopped',
      ]),
      severity: z.enum(['attention', 'watch']),
      scope: z.strictObject({ project_id: z.uuid().nullable(), client_id: z.uuid().nullable() }),
      work: z.strictObject({ id: z.uuid(), title: z.string() }),
      evidence: z
        .array(
          z.strictObject({
            kind: z.enum(['work_unit', 'approval', 'external_action', 'process_run', 'agent_run']),
            id: z.uuid(),
            reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
            observed_at: z.iso.datetime({ offset: true }),
          }),
        )
        .min(1),
      since: z.iso.datetime({ offset: true }),
      personal_state: z.enum(['open', 'snoozed', 'dismissed']),
      snoozed_until: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
  summary: z.strictObject({
    open_work: z.int().nonnegative(),
    overdue: z.int().nonnegative(),
    waiting_on_approval: z.int().nonnegative(),
    needs_decision: z.int().nonnegative(),
  }),
  partial: z.array(z.enum(['work', 'approvals', 'external_actions', 'agent_runs', 'process_runs'])),
});
export type CompanyPulseBody = z.infer<typeof companyPulseSchema>;

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
