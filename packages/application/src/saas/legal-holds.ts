// Owned by the retention slice (LIFE-03). Held records survive deletion requests, and the hold is audited.
// The refusal itself is below this, in triggers in migration 0501. See ADR-032 D6.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { HoldScope } from '@ensemus/saas/lifecycle';

export type LegalHoldView = {
  id: string;
  matterRef: string;
  status: 'active' | 'released';
  scopes: readonly { type: HoldScope; id: string | null }[];
  placedByMembershipId: string;
  placedAt: Date;
  releasedAt: Date | null;
  releaseReasonCode: string | null;
  version: number;
};

/** `legal_hold.manage`. Even the existence of a hold can be sensitive, so a member gets the usual not found. */
export function listLegalHolds(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly LegalHoldView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * `legal_hold.manage`. Every scope is checked to be in this tenant, as `foreignReference` would answer.
 * Audited, with IDs and no matter text in the log. Emits LEGAL_HOLD_PLACED.
 */
export function placeLegalHold(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    matterRef: string;
    scopes: readonly { type: HoldScope; id: string | null }[];
  },
): Promise<{ holdId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** `legal_hold.manage`, and a reason code. Stays released. Audited. Wakes an offboarding it was blocking. */
export function releaseLegalHold(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { holdId: string; reasonCode: string; expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** What an application asks first, so a person hears why. The trigger decides whatever this says. */
export function isHeldInTx(
  _tx: Tx,
  _context: TenantContext,
  _target: { type: HoldScope; id: string | null },
): Promise<boolean> {
  throw new Error('NOT_IMPLEMENTED');
}
