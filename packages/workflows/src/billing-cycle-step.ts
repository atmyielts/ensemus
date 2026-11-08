import type { BillingActivities } from './billing-activities';
import type { CreditActivities } from './credit-activities';
import type { TaxActivities } from './tax-activities';
import type { BillingCycleInput, BillingCycleResult } from './saas-schemas';

/** Deterministic ordering, shared with the workflow's focused tests. Only IDs and outcomes travel. */
export async function runBillingCycle(
  input: BillingCycleInput,
  platform: BillingActivities & CreditActivities,
  connector: TaxActivities,
): Promise<BillingCycleResult> {
  for (;;) {
    const page = await platform.consumeUsagePage(input);
    if (!page.more) break;
  }
  const sweep = await platform.runBillingSweep(input);
  const result: BillingCycleResult = {
    closedPeriods: sweep.closedPeriods,
    issued: 0,
    stepsTaken: 0,
    refusedCode: sweep.refusedCode,
  };
  if (result.refusedCode) return result;
  for (const invoiceId of sweep.draftIds) {
    const question = { ...input, invoiceId };
    const local = await platform.issueDraftInvoice(question);
    const outcome =
      local === 'needs_tax_port' ? await connector.computeTaxAndIssue(question) : local;
    if (outcome === 'issued') result.issued += 1;
    if (outcome === 'refused') {
      result.refusedCode = 'INVOICE_ISSUANCE_REFUSED';
      return result;
    }
  }
  result.stepsTaken = (await platform.runCollectionsStep(input)).stepsTaken;
  return result;
}
