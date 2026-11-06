// Owned by the invoicing slice (BILL-03). On the connector queue, because a tax provider is an outside call.
import type { PaymentConnectorDeps } from './saas-deps';
import type { BillingCycleInput } from './saas-schemas';

export function createTaxActivities(_deps: PaymentConnectorDeps) {
  return {
    /** Asks the port, then issues. No port configured leaves it a draft, with a code, and asks nobody. */
    async computeTaxAndIssue(
      _input: BillingCycleInput & { invoiceId: string },
    ): Promise<'issued' | 'already_issued' | 'refused'> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type TaxActivities = ReturnType<typeof createTaxActivities>;
