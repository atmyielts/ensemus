// Owned by the credits slice (BILL-05). See docs/06-delivery/m8-slices.md.
import type { BillingActivityDeps } from './saas-deps';
import type { BillingCycleInput } from './saas-schemas';

export function createCreditActivities(_deps: BillingActivityDeps) {
  return {
    /** One bounded page of usage. Keyed by ledger entry, so a retry writes nothing new. */
    async consumeUsagePage(
      _input: BillingCycleInput,
    ): Promise<{ entries: number; exhausted: boolean; more: boolean }> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type CreditActivities = ReturnType<typeof createCreditActivities>;
