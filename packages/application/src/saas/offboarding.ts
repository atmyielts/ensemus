// Owned by the offboarding slice (LIFE-04): export offered, connections revoked, scheduled work ended, deletion
// verified and reported. The last step is an operator's, deliberately. See ADR-032 D7.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ErasureReport, OffboardingState, OffboardingStep } from '@ensemus/saas/offboarding';
import type { OffboardingPorts } from './ports';

export type OffboardingView = {
  id: string;
  state: OffboardingState;
  exportOfferedAt: Date | null;
  exportRef: string | null;
  transitionEndsAt: Date | null;
  activeHolds: number;
  unsettledActions: number;
  report: ErasureReport | null;
  version: number;
};

/** `offboarding.manage`, which only an owner has. Null when none is under way. */
export function getOffboarding(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<OffboardingView | null> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * `offboarding.manage`, and a person. `confirmName` has to be this organization's exact name, or nothing
 * happens. Moves the tenant to `offboarding` through `setTenantStandingInTx`, emits OFFBOARDING_REQUESTED,
 * and tells every owner.
 */
export function requestOffboarding(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { confirmName: string },
): Promise<{ offboardingId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** `offboarding.manage`. Only before `erasing`, which is the point of no return. Service comes back. */
export function cancelOffboarding(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { reasonCode: string; expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** The operator's command sets this from the contract. It must be set before anything can be erased. */
export function setTransitionEnd(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { offboardingId: string; transitionEndsAt: Date; operatorRef: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Service only. The one step the workflow asks for each time, each idempotent, each recording its own time:
 * tell the owners about their export and record any they have taken, revoke connections with M3's `revokeConnection`, end schedules by emitting
 * TENANT_SCHEDULES_ENDED, halt agents, and wait for unsettled external actions. It stops at
 * `await_operator_erasure`, or `blocked_by_hold`, and tells the owners. Pending M3 actions never just vanish.
 */
export function advanceOffboarding(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: OffboardingPorts,
  _input: { offboardingId: string; now: Date },
): Promise<{ next: OffboardingStep; wakeAtMs: number | null }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The operator's erase command, as the application role: moves to `erasing`, which the database refuses while
 * any hold is active, a step is unfinished or the transition is not over. It tombstones every artifact first,
 * so a restore cannot bring the bytes back (ADR-026). Answers the IDs of what it tombstoned.
 */
export function beginErasure(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { offboardingId: string; operatorRef: string },
): Promise<{ tombstoned: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * After the eraser role has finished. Writes the log and the report from what was counted, moves to `verified`
 * only if nothing is left over, then to `reported`, and marks the tenant `deleted`. Anything left over stops at
 * `erasing` with the list, so "verified" always means verified (LIFE-04).
 */
export function finishErasure(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    offboardingId: string;
    tables: readonly { tableRef: string; rowsRemoved: number; rowsLeft: number }[];
    blobsRemoved: number;
    operatorRef: string;
  },
): Promise<{ state: OffboardingState; report: ErasureReport | null }> {
  throw new Error('NOT_IMPLEMENTED');
}
