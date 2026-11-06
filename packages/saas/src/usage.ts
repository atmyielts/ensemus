// What billing needs from M4's usage ledger, and nothing more (ADR-032 D9). Plain shapes, so this package
// stays pure. The port itself, which takes a transaction, is in @ensemus/application/saas/ports.
import type { Micros } from './money';

/** One ledger entry, in the shape billing reads it. M4's `platform.usage_ledger` row maps onto this. */
export type UsageEntry = {
  /** The ledger's own ID, which keys the credit consumption, so counting one twice writes one row. */
  id: string;
  meter: string;
  unit: string;
  quantity: bigint;
  costMicros: Micros | null;
  /** Estimated entries count, because a lost answer may have been billed (M4 FD-12). */
  status: 'estimated' | 'final' | 'correction';
  /** False for BYOM. Billing refuses to price an entry that is not billable (QA-027). */
  billable: boolean;
  occurredAt: Date;
};

export type UsagePage = { entries: readonly UsageEntry[]; nextCursor: string | null };

export type UsageTotal = { meter: string; unit: string; quantity: bigint };
