// Owned by the invoicing slice (BILL-02). See docs/06-delivery/m8-slices.md.
import type { BillingActivityDeps } from './saas-deps';
import type { BillingCycleInput } from './saas-schemas';

export function createBillingActivities(_deps: BillingActivityDeps) {
  return {
    /** Moves periods on, drafts what is due, and runs collections. Counts and a code come back. */
    async runBillingSweep(
      _input: BillingCycleInput,
    ): Promise<{ closedPeriods: number; draftIds: readonly string[]; refusedCode: string | null }> {
      throw new Error('NOT_IMPLEMENTED');
    },
    /** For tax that needs no outside call, and everything else after it. Safe to repeat. */
    async issueDraftInvoice(
      _input: BillingCycleInput & { invoiceId: string },
    ): Promise<'issued' | 'already_issued' | 'needs_tax_port' | 'refused'> {
      throw new Error('NOT_IMPLEMENTED');
    },
    async runCollectionsStep(_input: BillingCycleInput): Promise<{ stepsTaken: number }> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type BillingActivities = ReturnType<typeof createBillingActivities>;
