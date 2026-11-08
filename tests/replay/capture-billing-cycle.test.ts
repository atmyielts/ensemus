import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { capturing, withCaptureWorkers } from './capture-support';
describe.skipIf(!capturing)('capture billing cycle paths', () => {
  it('records prepaid, provider tax and refusal histories containing IDs and outcomes only', async () => {
    let variant = 'prepaid';
    const invoiceId = randomUUID();
    const activities = {
      consumeUsagePage: async () => ({ entries: 1, exhausted: false, more: false }),
      runBillingSweep: async () => ({
        closedPeriods: variant === 'usage-refused' ? 0 : 1,
        draftIds: variant === 'usage-refused' ? [] : [invoiceId],
        refusedCode: variant === 'usage-refused' ? 'USAGE_UNAVAILABLE' : null,
      }),
      issueDraftInvoice: async () => (variant === 'prepaid' ? 'issued' : 'needs_tax_port'),
      computeTaxAndIssue: async () => (variant === 'tax-refused' ? 'refused' : 'issued'),
      runCollectionsStep: async () => ({ stepsTaken: 0 }),
    };
    await withCaptureWorkers(
      { activities, queues: ['ensemus-platform', 'ensemus-connectors'] },
      async (run) => {
        for (const path of ['prepaid', 'tax-port', 'usage-refused', 'tax-refused']) {
          variant = path;
          await run.record(`billing-cycle-${path}`, {
            workflowType: 'billingCycleWorkflow',
            args: [{ organizationId: randomUUID() }],
          });
        }
      },
    );
  }, 120000);
});
