// Owned by the credits slice (BILL-05). See docs/06-delivery/m8-slices.md.
import type { BillingActivityDeps } from './saas-deps';
import type { BillingCycleInput } from './saas-schemas';
import { billingCycleInputSchema } from './saas-schemas';
import { consumeUsage } from '@ensemus/application/saas/credits';
import { createServiceContext } from '@ensemus/database/service';

export function createCreditActivities(deps: BillingActivityDeps) {
  return {
    /** One bounded page of usage. Keyed by ledger entry, so a retry writes nothing new. */
    async consumeUsagePage(
      input: BillingCycleInput,
    ): Promise<{ entries: number; exhausted: boolean; more: boolean }> {
      const value = billingCycleInputSchema.parse(input);
      const result = await consumeUsage(
        deps.database,
        createServiceContext(value.organizationId),
        deps.usage,
        { limit: 100 },
      );
      return { entries: result.entries, exhausted: result.exhausted, more: result.more };
    },
  };
}
export type CreditActivities = ReturnType<typeof createCreditActivities>;
