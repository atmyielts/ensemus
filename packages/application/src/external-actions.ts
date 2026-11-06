// Owned by the intents slice (WORK-08). See docs/06-delivery/m3-slices.md and ADR-027 D1 and D2.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { AttemptResult, ReconcileResult } from '@ensemus/domain/external-action';
import type { PreparedAttempt } from './integration-ports';

export type ProposeExternalActionInput = {
  workUnitId: string;
  connectionId: string;
  toolName: string;
  toolVersion: string;
  /** Checked against the tool's schema here, and frozen once written. */
  payload: unknown;
  /** Who is asked. Never the person proposing it. */
  approverMembershipId: string;
  expiresAt?: Date;
  supersedesId?: string;
  retryOfId?: string;
};

export type ProposedExternalAction = {
  externalActionId: string;
  approvalId: string;
  requestHash: string;
};

/**
 * Writes the intent and its approval in the caller's transaction, with the same hash on both, and emits
 * external_action.proposed. Refuses restricted work and a connection that is not active.
 */
export function proposeExternalActionInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: ProposeExternalActionInput,
): Promise<ProposedExternalAction> {
  throw new Error('NOT_IMPLEMENTED');
}

export function proposeExternalAction(
  _database: AppDatabase,
  _context: TenantContext,
  _input: ProposeExternalActionInput,
): Promise<ProposedExternalAction> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * QA-007. Changing an intent means a new one: this closes the old intent as SUPERSEDED, cancels its
 * approval even if it was approved, and proposes the new payload for a new decision. Refused once any
 * attempt exists, with EXTERNAL_ACTION_NOT_EDITABLE.
 */
export function reviseExternalAction(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    externalActionId: string;
    expectedVersion: number;
    payload: unknown;
    approverMembershipId: string;
  },
): Promise<ProposedExternalAction> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Asks again for an action that ended `failed`, as a new intent pointing back at it. It needs its own
 * approval, even if a person just said the old one was not sent.
 */
export function retryExternalAction(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { externalActionId: string; approverMembershipId: string },
): Promise<ProposedExternalAction> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Called, in the same transaction, from every path that closes an approval. An approved intent goes to
 * ready and emits external_action.ready. Anything else cancels it. Does nothing for other approvals.
 */
export function onApprovalClosedInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: { approvalId: string; outcome: 'approved' | 'denied' | 'expired' | 'cancelled' },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export type BeginAttemptResult =
  | { kind: 'send'; attempt: PreparedAttempt }
  /** It is past this point, or the recheck stopped it. The status says where it ended up. */
  | { kind: 'stop'; status: 'sent' | 'failed' | 'cancelled' | 'unknown' }
  /** An attempt already exists that could have sent. This call must not contact the provider. */
  | { kind: 'reconcile'; attemptId: string };

/**
 * ADR-027 D2. Locks the intent, runs checkBeforeSend, then writes the attempt and moves to sending, and
 * commits all of that before returning. Whatever happens afterwards, the record exists first.
 */
export function beginAttempt(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { externalActionId: string; runId: string },
): Promise<BeginAttemptResult> {
  throw new Error('NOT_IMPLEMENTED');
}

export type AttemptStep = 'sent' | 'failed' | 'retry' | 'reconcile';

/** Records what the attempt ended with, its receipt, and the move this leads to. Safe to repeat. */
export function finishAttempt(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { attemptId: string; result: AttemptResult },
): Promise<AttemptStep> {
  throw new Error('NOT_IMPLEMENTED');
}

export type InterruptedState =
  /** No attempt could have sent, so another try is safe. */
  | 'nothing_sent'
  /** An attempt has no outcome. It may have sent, so the only safe step is to reconcile. */
  | 'attempt_open'
  /** It already ended, and the Activity's answer was what got lost. */
  | 'settled';

/** What to do after a send Activity failed or timed out. Reads PostgreSQL and contacts nobody. */
export function inspectInterrupted(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { externalActionId: string },
): Promise<InterruptedState> {
  throw new Error('NOT_IMPLEMENTED');
}

export type ReconcilePreparation =
  | { kind: 'reconcile'; attempt: PreparedAttempt }
  | { kind: 'settled'; status: 'sent' | 'failed' | 'cancelled' | 'unknown' };

/** Moves to reconciling and marks an open attempt indeterminate before asking the provider. */
export function beginReconcile(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { externalActionId: string; code: 'WORKER_INTERRUPTED' | 'TIMEOUT_AFTER_COMMIT' },
): Promise<ReconcilePreparation> {
  throw new Error('NOT_IMPLEMENTED');
}

export type ReconcileStep = 'sent' | 'failed' | 'retry' | 'unknown';

/**
 * Records the provider's answer. `cannot_answer` goes to unknown, tells the accountable owner and the
 * requester, and stops. Nothing in this file resends from there.
 */
export function finishReconcile(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    attemptId: string;
    result: ReconcileResult;
    lookup: 'none' | 'best_effort' | 'authoritative';
  },
): Promise<ReconcileStep> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Ends an intent that has used all its tries, or whose connector never picked it up. */
export function failUnsent(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { externalActionId: string; code: 'ATTEMPTS_EXHAUSTED' | 'CONNECTOR_UNAVAILABLE' },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The `external_receipt` evidence for a Work Unit: sent actions with a receipt from the provider, from
 * reconciliation, or from a person who was shown it was unknown (ADR-027 D6). work.ts counts these.
 */
export function countVerifiedReceipts(_tx: Tx, _workUnitId: string): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}
