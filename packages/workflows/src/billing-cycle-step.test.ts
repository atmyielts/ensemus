import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { runBillingCycle } from './billing-cycle-step';
import type { BillingActivities } from './billing-activities';
import type { CreditActivities } from './credit-activities';
import type { TaxActivities } from './tax-activities';

describe('billing cycle orders deterministic ID-only steps', () => {
  const input = { organizationId: randomUUID() };
  const invoiceId = randomUUID();
  const setup = () => {
    const sequence: string[] = [];
    const platform: BillingActivities & CreditActivities = {
      consumeUsagePage: vi.fn(async () => {
        sequence.push('usage');
        return { entries: 1, exhausted: false, more: false };
      }),
      runBillingSweep: vi.fn(async () => {
        sequence.push('sweep');
        return { closedPeriods: 1, draftIds: [invoiceId], refusedCode: null };
      }),
      issueDraftInvoice: vi.fn(async () => {
        sequence.push('issue');
        return 'issued' as const;
      }),
      runCollectionsStep: vi.fn(async () => {
        sequence.push('collections');
        return { stepsTaken: 1 };
      }),
    };
    const connector: TaxActivities = {
      computeTaxAndIssue: vi.fn(async () => {
        sequence.push('tax');
        return 'issued' as const;
      }),
    };
    return { sequence, platform, connector };
  };
  it('drains usage before drafting, issuing and collections', async () => {
    const x = setup();
    vi.mocked(x.platform.consumeUsagePage).mockResolvedValueOnce({
      entries: 1,
      exhausted: false,
      more: true,
    });
    expect(await runBillingCycle(input, x.platform, x.connector)).toEqual({
      closedPeriods: 1,
      issued: 1,
      stepsTaken: 1,
      refusedCode: null,
    });
    expect(x.sequence).toEqual(['usage', 'sweep', 'issue', 'collections']);
  });
  it('only the connector tax activity handles a provider computation', async () => {
    const x = setup();
    vi.mocked(x.platform.issueDraftInvoice).mockResolvedValue('needs_tax_port');
    await runBillingCycle(input, x.platform, x.connector);
    expect(x.sequence).toEqual(['usage', 'sweep', 'tax', 'collections']);
    expect(x.connector.computeTaxAndIssue).toHaveBeenCalledWith({ ...input, invoiceId });
  });
  it('a refused sweep never starts issuance or collection', async () => {
    const x = setup();
    vi.mocked(x.platform.runBillingSweep).mockResolvedValue({
      closedPeriods: 0,
      draftIds: [],
      refusedCode: 'USAGE_UNAVAILABLE',
    });
    expect((await runBillingCycle(input, x.platform, x.connector)).refusedCode).toBe(
      'USAGE_UNAVAILABLE',
    );
    expect(x.platform.issueDraftInvoice).not.toHaveBeenCalled();
    expect(x.platform.runCollectionsStep).not.toHaveBeenCalled();
  });
  it('tax refusal leaves the invoice unissued and starts no collection step', async () => {
    const x = setup();
    vi.mocked(x.platform.issueDraftInvoice).mockResolvedValue('needs_tax_port');
    vi.mocked(x.connector.computeTaxAndIssue).mockResolvedValue('refused');
    expect(await runBillingCycle(input, x.platform, x.connector)).toMatchObject({
      issued: 0,
      refusedCode: 'INVOICE_ISSUANCE_REFUSED',
    });
    expect(x.platform.runCollectionsStep).not.toHaveBeenCalled();
  });
  it('already-issued retries count no duplicate issuance', async () => {
    const x = setup();
    vi.mocked(x.platform.issueDraftInvoice).mockResolvedValue('already_issued');
    expect((await runBillingCycle(input, x.platform, x.connector)).issued).toBe(0);
    expect(x.connector.computeTaxAndIssue).not.toHaveBeenCalled();
  });
});
