import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@ensemus/application';
import type { PaymentConnectorDeps } from './saas-deps';
import {
  createPaymentConnectorActivities,
  createPaymentPlatformActivities,
  type PaymentActivityOptions,
} from './payment-activities';
import {
  beginPaymentAttempt,
  beginPaymentReconcile,
  finishPaymentAttempt,
  finishPaymentReconcile,
  getPaymentExecution,
} from '@ensemus/application/saas/payments';
import {
  preflightPaymentExecution,
  bindPaymentExecution,
  readPaymentExecutionBinding,
  beginPaymentCustomerRegistration,
  finishPaymentCustomerRegistration,
} from '@ensemus/application/saas/payment-execution';
import {
  identifyPaymentExecution,
  runBoundCharge,
  runBoundCustomerRegistration,
  runBoundPaymentLookup,
  type VerifiedPaymentExecutionIdentity,
} from '@ensemus/connectors/payment';
import type { PaymentConnectionAuthority, PaymentProcessor } from '@ensemus/saas/payment';

vi.mock('@ensemus/application/saas/payments', () => ({
  beginPaymentAttempt: vi.fn(),
  beginPaymentReconcile: vi.fn(),
  finishPaymentAttempt: vi.fn(),
  finishPaymentReconcile: vi.fn(),
  getPaymentExecution: vi.fn(),
  failUnsentPayment: vi.fn(),
  inspectInterruptedPayment: vi.fn(),
  readPaymentOutcome: vi.fn(),
}));
vi.mock('@ensemus/application/saas/payment-execution', () => ({
  preflightPaymentExecution: vi.fn(),
  bindPaymentExecution: vi.fn(),
  readPaymentExecutionBinding: vi.fn(),
  beginPaymentCustomerRegistration: vi.fn(),
  finishPaymentCustomerRegistration: vi.fn(),
  qualifyPaymentWebhookExecution: vi.fn(),
}));
vi.mock('@ensemus/connectors/payment', async (original) => ({
  ...(await original<object>()),
  identifyPaymentExecution: vi.fn(),
  runBoundCharge: vi.fn(),
  runBoundCustomerRegistration: vi.fn(),
  runBoundPaymentLookup: vi.fn(),
}));
const input = { organizationId: randomUUID(), paymentId: randomUUID(), runId: randomUUID() };
const paymentInput = { organizationId: input.organizationId, paymentId: input.paymentId };
const authority: PaymentConnectionAuthority = {
  billingOrganizationId: randomUUID(),
  connectionId: randomUUID(),
  connectionVersion: '1',
  credentialSecretId: randomUUID(),
  processor: 'test_scripted',
  adapterVersion: '1.0.0',
  apiOrigin: 'https://generated.mcp.invalid',
  configSha256: 'a'.repeat(64),
  authoritySha256: 'b'.repeat(64),
};
const binding = {
  id: randomUUID(),
  authoritySha256: authority.authoritySha256,
  identitySha256: 'c'.repeat(64),
  accountNamespaceSha256: '8'.repeat(64),
  bindingSha256: 'd'.repeat(64),
  customerState: 'confirmed' as const,
  customerRefHash: 'e'.repeat(64),
};
// Explicit Activity-control test double only. Real opaque identity and actual local TLS are tested in
// connectors/payment/execution.test.ts; this suite does not qualify broker, SQL, native parsing or provider I/O.
const proof = {
  sha256: binding.identitySha256,
  accountNamespaceSha256: binding.accountNamespaceSha256,
} as unknown as VerifiedPaymentExecutionIdentity;
const processor = {
  manifest: {
    processor: 'test_scripted',
    version: '1.0.0',
    nativeIdempotency: true,
    lookup: 'authoritative',
  },
  identifyExecution: vi.fn(),
} as unknown as PaymentProcessor;
const execution = {
  processor: 'test_scripted',
  status: 'ready' as const,
  preflightCode: null,
  account: {
    id: randomUUID(),
    billingName: 'Generated',
    billingEmail: 'generated@example.invalid',
    processor: 'test_scripted',
    customerRef: 'generated-customer',
  },
};
const begun = {
  kind: 'attempt' as const,
  attemptId: randomUUID(),
  processor: 'test_scripted',
  charge: {
    paymentId: input.paymentId,
    attemptNo: 1,
    idempotencyKey: randomUUID(),
    amountMicros: 10n,
    currency: 'XTS',
    minorUnitExponent: 2,
    customerRef: 'generated-customer',
  },
};
const deps = (): PaymentConnectorDeps => ({
  database: new Proxy(
    {},
    {
      get: () => {
        throw new Error('TEST_UNEXPECTED_DATABASE_ACCESS');
      },
    },
  ) as PaymentConnectorDeps['database'],
  billingEnabled: true,
  paymentProcessor: 'test_scripted',
  billingOrganizationId: authority.billingOrganizationId,
  billingConnectionId: authority.connectionId,
  processors: { get: () => processor },
  registry: { get: () => undefined, manifests: () => [] },
  secrets: {
    withSecret: async () => {
      throw new Error('TEST_UNEXPECTED_CREDENTIAL_LEASE');
    },
    revoke: async () => {
      throw new Error('TEST_UNEXPECTED_CREDENTIAL_REVOCATION');
    },
  },
  network: {
    openRelay: async () => {
      throw new Error('TEST_UNEXPECTED_NETWORK');
    },
  },
  tax: null,
});
const options = (): PaymentActivityOptions => ({
  paymentApiOrigin: authority.apiOrigin,
  requestThroughGateway: vi.fn(),
  attestIdentity: vi.fn(async () => ({
    token: 'f'.repeat(64),
    expiresAt: new Date(Date.now() + 60000),
  })),
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPaymentExecution).mockResolvedValue(execution);
  vi.mocked(preflightPaymentExecution).mockResolvedValue(authority);
  vi.mocked(identifyPaymentExecution).mockResolvedValue(proof);
  vi.mocked(bindPaymentExecution).mockResolvedValue(binding);
  vi.mocked(readPaymentExecutionBinding).mockResolvedValue(binding);
  vi.mocked(beginPaymentCustomerRegistration).mockResolvedValue({
    action: 'confirmed',
    token: randomUUID(),
    requestKey: randomUUID(),
    customerRef: 'generated-customer',
  });
  vi.mocked(beginPaymentAttempt).mockResolvedValue(begun);
  vi.mocked(runBoundCharge).mockResolvedValue({
    outcome: 'succeeded',
    code: 'CHARGED',
    processorPaymentRef: 'generated-payment',
  });
  vi.mocked(finishPaymentAttempt).mockResolvedValue({ step: 'succeeded' });
  vi.mocked(beginPaymentReconcile).mockResolvedValue({
    attemptId: begun.attemptId,
    executionBindingId: binding.id,
    processor: 'test_scripted',
    idempotencyKey: begun.charge.idempotencyKey,
  });
  vi.mocked(runBoundPaymentLookup).mockResolvedValue({
    found: 'succeeded',
    processorPaymentRef: 'generated-payment',
  });
  vi.mocked(finishPaymentReconcile).mockResolvedValue('succeeded');
});
describe('payment Activity original-authority control', () => {
  it.each([false, undefined])(
    'billing disabled (%j) reaches no new database effect or transport',
    async (billingEnabled) => {
      const d = deps();
      delete d.billingEnabled;
      if (billingEnabled !== undefined) d.billingEnabled = billingEnabled;
      expect(await createPaymentConnectorActivities(d, options()).chargePaymentStep(input)).toEqual(
        { step: 'reconcile' },
      );
      expect(getPaymentExecution).not.toHaveBeenCalled();
      expect(beginPaymentAttempt).not.toHaveBeenCalled();
      expect(identifyPaymentExecution).not.toHaveBeenCalled();
    },
  );
  it('unconfigured dispatch remains pending without a fake unsuccessful financial effect', async () => {
    expect(await createPaymentConnectorActivities(deps()).chargePaymentStep(input)).toEqual({
      step: 'retry',
      afterMs: 300000,
    });
    expect(getPaymentExecution).not.toHaveBeenCalled();
    expect(beginPaymentAttempt).not.toHaveBeenCalled();
    expect(finishPaymentAttempt).not.toHaveBeenCalled();
  });
  it('qualifies and binds before the customer/attempt, then forwards the real known answer to settlement', async () => {
    expect(
      await createPaymentConnectorActivities(deps(), options()).chargePaymentStep(input),
    ).toEqual({ step: 'succeeded' });
    expect(beginPaymentAttempt).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      paymentId: input.paymentId,
      runId: input.runId,
      executionBindingId: binding.id,
    });
    expect(vi.mocked(bindPaymentExecution).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(beginPaymentAttempt).mock.invocationCallOrder[0]!,
    );
    expect(finishPaymentAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        attemptId: begun.attemptId,
        result: { outcome: 'succeeded', code: 'CHARGED', processorPaymentRef: 'generated-payment' },
      },
      undefined,
    );
  });
  it('missing native identity refuses before customer registration or attempt insertion', async () => {
    vi.mocked(identifyPaymentExecution).mockResolvedValue(null);
    expect(
      (await createPaymentConnectorActivities(deps(), options()).chargePaymentStep(input)).step,
    ).toBe('retry');
    expect(bindPaymentExecution).not.toHaveBeenCalled();
    expect(beginPaymentCustomerRegistration).not.toHaveBeenCalled();
    expect(beginPaymentAttempt).not.toHaveBeenCalled();
  });
  it('a claimed or unknown customer operation is never replayed or converted into a charge', async () => {
    vi.mocked(beginPaymentCustomerRegistration).mockResolvedValue({
      action: 'unknown',
      token: randomUUID(),
      requestKey: randomUUID(),
      customerRef: null,
    });
    expect(
      (await createPaymentConnectorActivities(deps(), options()).chargePaymentStep(input)).step,
    ).toBe('retry');
    expect(runBoundCustomerRegistration).not.toHaveBeenCalled();
    expect(beginPaymentAttempt).not.toHaveBeenCalled();
  });
  it('retains uncertain customer registration without resending or inventing a reference', async () => {
    const token = randomUUID();
    vi.mocked(beginPaymentCustomerRegistration).mockResolvedValue({
      action: 'send',
      token,
      requestKey: randomUUID(),
      customerRef: null,
    });
    vi.mocked(runBoundCustomerRegistration).mockResolvedValue(null);
    expect(
      (await createPaymentConnectorActivities(deps(), options()).chargePaymentStep(input)).step,
    ).toBe('retry');
    expect(finishPaymentCustomerRegistration).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { paymentId: input.paymentId, bindingId: binding.id, token, customerRef: null },
    );
    expect(beginPaymentAttempt).not.toHaveBeenCalled();
  });
  it('records a genuine customer ACK even when authority is revoked before the charge admission', async () => {
    vi.mocked(beginPaymentCustomerRegistration).mockResolvedValue({
      action: 'send',
      token: randomUUID(),
      requestKey: randomUUID(),
      customerRef: null,
    });
    vi.mocked(runBoundCustomerRegistration).mockResolvedValue('generated-confirmed-customer');
    vi.mocked(beginPaymentAttempt).mockRejectedValue(new AppError('PREREQUISITES_INCOMPLETE'));
    await expect(
      createPaymentConnectorActivities(deps(), options()).chargePaymentStep(input),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    expect(finishPaymentCustomerRegistration).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ customerRef: 'generated-confirmed-customer' }),
    );
    expect(runBoundCharge).not.toHaveBeenCalled();
  });
  it('billing-off allows an original-bound read-only reconciliation and preserves its known answer', async () => {
    vi.mocked(getPaymentExecution).mockResolvedValue({ ...execution, status: 'sending' });
    expect(
      await createPaymentConnectorActivities(
        { ...deps(), billingEnabled: false },
        options(),
      ).reconcilePaymentStep(paymentInput),
    ).toBe('succeeded');
    expect(runBoundPaymentLookup).toHaveBeenCalledOnce();
    expect(runBoundCharge).not.toHaveBeenCalled();
    expect(beginPaymentAttempt).not.toHaveBeenCalled();
  });
  it('changed original connection/credential authority refuses before identity I/O or reconciliation mutation', async () => {
    vi.mocked(getPaymentExecution).mockResolvedValue({ ...execution, status: 'sending' });
    vi.mocked(preflightPaymentExecution).mockResolvedValue({
      ...authority,
      authoritySha256: '9'.repeat(64),
    });
    expect(
      await createPaymentConnectorActivities(deps(), options()).reconcilePaymentStep(paymentInput),
    ).toBe('retry');
    expect(identifyPaymentExecution).not.toHaveBeenCalled();
    expect(beginPaymentReconcile).not.toHaveBeenCalled();
    expect(finishPaymentReconcile).not.toHaveBeenCalled();
  });
  it('legacy unbound reconciliation remains pending and never uses a current replacement configuration', async () => {
    vi.mocked(getPaymentExecution).mockResolvedValue({ ...execution, status: 'sending' });
    vi.mocked(readPaymentExecutionBinding).mockResolvedValue(null);
    expect(
      await createPaymentConnectorActivities(deps(), options()).reconcilePaymentStep(paymentInput),
    ).toBe('retry');
    expect(preflightPaymentExecution).not.toHaveBeenCalled();
    expect(beginPaymentReconcile).not.toHaveBeenCalled();
    expect(finishPaymentReconcile).not.toHaveBeenCalled();
  });
  it('a lost platform callback cannot manufacture a reconciliation result for an original attempt', async () => {
    vi.mocked(getPaymentExecution).mockResolvedValue({ ...execution, status: 'sending' });
    expect(
      await createPaymentPlatformActivities({
        database: deps().database,
      }).concludePaymentWithoutAnswerStep(paymentInput),
    ).toBe('retry');
    expect(beginPaymentReconcile).not.toHaveBeenCalled();
    expect(finishPaymentReconcile).not.toHaveBeenCalled();
  });
});
