// Offboarding (LIFE-04). Pure. Export offered, connections revoked, scheduled work ended, deletion verified and
// reported, with the last step an operator's (ADR-032 D7).
// The tables of values are fixed. The functions are owned by the offboarding slice. See m8-slices.md.

export const OFFBOARDING_STATES = [
  'requested',
  'export_offered',
  'in_transition',
  'winding_down',
  'ready_for_erasure',
  'erasing',
  'verified',
  'reported',
  'cancelled',
] as const;
export type OffboardingState = (typeof OFFBOARDING_STATES)[number];

/** Matches `lifecycle.check_offboarding_change` in migration 0501, and a test holds the two together. */
export const OFFBOARDING_TRANSITIONS: Readonly<
  Record<OffboardingState, readonly OffboardingState[]>
> = {
  requested: ['export_offered', 'cancelled'],
  export_offered: ['in_transition', 'cancelled'],
  in_transition: ['winding_down', 'cancelled'],
  winding_down: ['ready_for_erasure', 'cancelled'],
  ready_for_erasure: ['erasing', 'cancelled'],
  erasing: ['verified'],
  verified: ['reported'],
  reported: [],
  cancelled: [],
};

export type OffboardingStep =
  | { kind: 'offer_export' }
  | { kind: 'wait_for_transition'; until: Date | null }
  | { kind: 'revoke_connections' }
  | { kind: 'end_scheduled_work' }
  | { kind: 'settle_pending_actions' }
  /** Stops here. An operator runs the last step, with a role that cannot log in until they enable it. */
  | { kind: 'await_operator_erasure' }
  | { kind: 'blocked_by_hold' }
  | { kind: 'write_report' }
  | { kind: 'done' };

export type OffboardingFacts = {
  state: OffboardingState;
  exportOfferedAt: Date | null;
  transitionEndsAt: Date | null;
  connectionsRevokedAt: Date | null;
  workEndedAt: Date | null;
  actionsSettledAt: Date | null;
  activeHolds: number;
  /** External actions still `sending`, `reconciling` or `unknown`. A person settles these first. */
  unsettledActions: number;
};

/** What comes next. Pure, so a workflow's decisions can be tested without Temporal. */
export function nextOffboardingStep(facts: OffboardingFacts, now: Date): OffboardingStep {
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(facts.activeHolds) ||
    facts.activeHolds < 0 ||
    !Number.isSafeInteger(facts.unsettledActions) ||
    facts.unsettledActions < 0
  )
    throw new RangeError('INVALID_OFFBOARDING_FACTS');
  if (facts.state === 'cancelled' || facts.state === 'reported') return { kind: 'done' };
  if (facts.state === 'verified') return { kind: 'write_report' };
  if (facts.state === 'erasing')
    return facts.activeHolds ? { kind: 'blocked_by_hold' } : { kind: 'await_operator_erasure' };
  if (facts.state === 'requested' || !facts.exportOfferedAt) return { kind: 'offer_export' };
  if (!facts.transitionEndsAt || facts.transitionEndsAt > now)
    return { kind: 'wait_for_transition', until: facts.transitionEndsAt };
  if (!facts.connectionsRevokedAt) return { kind: 'revoke_connections' };
  if (!facts.workEndedAt) return { kind: 'end_scheduled_work' };
  if (!facts.actionsSettledAt || facts.unsettledActions) return { kind: 'settle_pending_actions' };
  if (facts.activeHolds) return { kind: 'blocked_by_hold' };
  return { kind: 'await_operator_erasure' };
}

export type ErasureOutcome = 'erased' | 'retained_by_rule' | 'left_over';

/** What stays after an erasure, stated plainly in the report (LIFE-04, 07-commercial/03 §5). */
export const RETAINED_RECORDS = [
  'invoices_and_payments',
  'audit_log',
  'tombstones_and_event_metadata',
  'usage_ledger',
  'erasure_log',
  'account_identities',
  'backups_until_expiry',
] as const;
export type RetainedRecord = (typeof RETAINED_RECORDS)[number];

/** Stored on the offboarding and given to the customer. Counts and codes, with no content. */
export type ErasureReport = {
  schemaVersion: 1;
  offboardingId: string;
  organizationId: string;
  erasedTables: number;
  rowsRemoved: number;
  /** Anything left behind, and why. An empty list here is what "verified" means. */
  leftOver: readonly { tableRef: string; rows: number; reasonCode: string }[];
  retained: readonly { what: RetainedRecord; reasonCode: string }[];
  blobsRemoved: number;
  backups: 'expire_on_schedule';
  startedAt: string;
  finishedAt: string;
};
