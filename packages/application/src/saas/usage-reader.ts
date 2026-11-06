// Owned by the credits slice (BILL-04). The real UsageLedgerPort, in raw SQL over M4's `platform.usage_ledger`
// as landed on m4-foundation: `id`, `meter`, `quantity`, `unit`, `cost_micros`, `status`, `billable`, `created_at`,
// and meters such as `model_input_tokens`. Raw, so this compiles without M4's Drizzle table, and the close slice
// wires it into workers/workflow/src/saas-ports.ts after M4 merges. Reads only, as `ensemus_app`.
import type { UsageLedgerPort } from './ports';

/** The cursor is `(created_at, id)`, opaque to callers, so entries written in one millisecond are not lost. */
export function createUsageLedgerReader(): UsageLedgerPort {
  return {
    listSince() {
      throw new Error('NOT_IMPLEMENTED');
    },
    sumForPeriod() {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
