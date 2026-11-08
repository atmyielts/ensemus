import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '@ensemus/application';
import {
  issueInvoice,
  loadTaxQuestion,
  type TaxQuestion,
} from '@ensemus/application/saas/invoices';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { PaymentConnectorDeps } from './saas-deps';
import { createTaxActivities } from './tax-activities';
vi.mock('@ensemus/application/saas/invoices', () => ({
  issueInvoice: vi.fn(),
  loadTaxQuestion: vi.fn(),
}));
const input = { organizationId: randomUUID(), invoiceId: randomUUID() };
const question: TaxQuestion = {
  invoiceId: input.invoiceId,
  treatmentId: randomUUID(),
  treatment: 'provider_computed',
  questionHash: createHash('sha256').update(randomUUID()).digest('hex'),
  input: {
    idempotencyKey: randomUUID(),
    currency: 'XTS',
    countryCode: 'XX',
    regionCode: '',
    postalCode: null,
    taxId: null,
    lines: [{ kind: 'platform_fee', amountMicros: 9007199254740993n }],
  },
};
const deps = (tax: PaymentConnectorDeps['tax']) =>
  ({ database: {}, tax, billingEnabled: true }) as unknown as PaymentConnectorDeps;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadTaxQuestion).mockResolvedValue(question);
  vi.mocked(issueInvoice).mockResolvedValue('issued');
});
describe('tax stays inside a connector activity', () => {
  it('disabled billing reaches neither database nor tax transport, including replayed invoice IDs', async () => {
    const compute = vi.fn();
    await expect(
      createTaxActivities({
        ...deps({ provider: 'test', compute }),
        billingEnabled: false,
      }).computeTaxAndIssue(input),
    ).rejects.toMatchObject({ code: 'BILLING_NOT_ENABLED' });
    expect(loadTaxQuestion).not.toHaveBeenCalled();
    expect(compute).not.toHaveBeenCalled();
    expect(issueInvoice).not.toHaveBeenCalled();
  });
  it('missing provider leaves a draft and never attempts issuance', async () => {
    expect(await createTaxActivities(deps(null)).computeTaxAndIssue(input)).toBe('refused');
    expect(issueInvoice).not.toHaveBeenCalled();
  });
  it('tax failures and another currency never issue or charge anything', async () => {
    const compute = vi.fn().mockRejectedValue(new Error('TEST_PRIVATE_PROVIDER_CANARY'));
    expect(
      await createTaxActivities(deps({ provider: 'test', compute })).computeTaxAndIssue(input),
    ).toBe('refused');
    compute.mockResolvedValue({ taxMicros: 1n, currency: 'XXX', providerRef: 'test' });
    expect(
      await createTaxActivities(deps({ provider: 'test', compute })).computeTaxAndIssue(input),
    ).toBe('refused');
    expect(issueInvoice).not.toHaveBeenCalled();
  });
  it('the exact tax and address-bound hash are passed locally, while only an outcome returns', async () => {
    const taxMicros = 9007199254740995n;
    const compute = vi
      .fn()
      .mockResolvedValue({ taxMicros, currency: 'XTS', providerRef: 'test-reference' });
    expect(
      await createTaxActivities(deps({ provider: 'test', compute })).computeTaxAndIssue(input),
    ).toBe('issued');
    expect(issueInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: input.organizationId, actorType: 'service' }),
      {
        invoiceId: input.invoiceId,
        tax: { taxMicros, providerRef: 'test-reference', questionHash: question.questionHash },
      },
    );
    expect(compute).toHaveBeenCalledWith(question.input, expect.any(AbortSignal));
  });
  it('explicit not-collected guidance computes zero locally and contacts no provider', async () => {
    vi.mocked(loadTaxQuestion).mockResolvedValue({ ...question, treatment: 'not_collected' });
    const compute = vi.fn();
    expect(
      await createTaxActivities(deps({ provider: 'test', compute })).computeTaxAndIssue(input),
    ).toBe('issued');
    expect(compute).not.toHaveBeenCalled();
    expect(issueInvoice).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      invoiceId: input.invoiceId,
      tax: { taxMicros: 0n, providerRef: null },
    });
  });
  it('an edited account refuses a stale tax answer and a repeated already-issued invoice contacts nobody', async () => {
    const compute = vi
      .fn()
      .mockResolvedValue({ taxMicros: 1n, currency: 'XTS', providerRef: 'test' });
    vi.mocked(issueInvoice).mockRejectedValue(new AppError('TAX_PROVIDER_UNAVAILABLE'));
    expect(
      await createTaxActivities(deps({ provider: 'test', compute })).computeTaxAndIssue(input),
    ).toBe('refused');
    compute.mockClear();
    vi.mocked(loadTaxQuestion).mockResolvedValue(null);
    expect(
      await createTaxActivities(deps({ provider: 'test', compute })).computeTaxAndIssue(input),
    ).toBe('already_issued');
    expect(compute).not.toHaveBeenCalled();
  });
  it('extra money or address fields are rejected from Temporal activity input', async () => {
    const bad = { ...input, amount: 'TEST_CANARY' };
    await expect(createTaxActivities(deps(null)).computeTaxAndIssue(bad)).rejects.toThrow();
    expect(loadTaxQuestion).not.toHaveBeenCalled();
  });
});
