// Owned by the credits slice (BILL-04, BILL-05). See docs/06-delivery/m8-slices.md and ADR-032 D2, D9.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { UsageLedgerPort } from './ports';

export type CreditSummary = {
  /** Null for BYOM, whose provider bills its customer, so Ensemus shows no balance at all. */
  balanceMicrocredits: bigint | null;
  includedMicrocredits: bigint | null;
  overagePolicy: 'pause' | 'explicit_top_up' | null;
  recent: readonly { kind: string; amountMicrocredits: bigint; occurredAt: Date }[];
};

/** `billing.view`. */
export function getCreditSummary(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<CreditSummary> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Service only, once per period, by key. A plan with no allowance allocates nothing. */
export function allocatePeriodCreditsInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: { billingPeriodId: string; includedMicrocredits: bigint; rateCardId: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Service only. Reads new ledger entries through the port and writes one consumption row per billable entry,
 * keyed by the entry's own ID, so it can run any number of times. Priced by the period's card, and refuses
 * without one. A non-billable entry is skipped, so BYOM is never charged (QA-027). Emits CREDITS_LOW and
 * CREDITS_EXHAUSTED once each, on crossing.
 */
export function consumeUsage(
  _database: AppDatabase,
  _context: TenantContext,
  _usage: UsageLedgerPort,
  _input: { limit: number },
): Promise<{ entries: number; microcredits: bigint; exhausted: boolean; more: boolean }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** What the entitlement check asks when a Cloud model call is about to start. */
export function loadCreditBalanceInTx(_tx: Tx, _context: TenantContext): Promise<bigint> {
  throw new Error('NOT_IMPLEMENTED');
}
