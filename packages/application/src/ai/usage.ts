// Owned by the usage slice (MODEL-04). See docs/06-delivery/m4-slices.md and ADR-028 FD-6, FD-12. Only
// agent-worker uses this: its role alone can write these tables. Every stub refuses.
import type { AppDatabase } from '@ensemus/database';
import type { UsageLedger } from './ports';

export function createUsageLedger(_database: AppDatabase): UsageLedger {
  throw new Error('NOT_IMPLEMENTED');
}

/** Cost of a call from its usage and rate card, rounded up, so a budget over-counts and never under. */
export function costMicros(
  _usage: { inputTokens: number; outputTokens: number },
  _rate: { inputMicrosPerMtok: number; outputMicrosPerMtok: number },
): number {
  throw new Error('NOT_IMPLEMENTED');
}
