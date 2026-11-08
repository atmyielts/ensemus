import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PaymentConnectionAuthority,
  PaymentExecutionIdentity,
  PaymentGatewayBinding,
  PaymentProcessor,
  ProcessorCallContext,
  ChargeRequest,
} from '@ensemus/saas/payment';
import { fakeProvider } from '../../../../tests/helpers/fake-provider';
import { createPaymentHttpGateway } from './gateway';
import {
  identifyPaymentExecution,
  runBoundCharge,
  runBoundCustomerRegistration,
  runBoundPaymentLookup,
} from './runtime';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const origin = 'https://generated.mcp.invalid';
const authority: PaymentConnectionAuthority = {
  billingOrganizationId: randomUUID(),
  connectionId: randomUUID(),
  connectionVersion: '1',
  credentialSecretId: randomUUID(),
  processor: 'test_scripted',
  adapterVersion: '1.0.0',
  apiOrigin: origin,
  configSha256: sha('generated-config'),
  authoritySha256: sha('generated-authority'),
};
const identity: PaymentExecutionIdentity = {
  version: 'ensemus.payment-execution/v1',
  processor: 'test_scripted',
  adapterVersion: '1.0.0',
  environment: 'generated_test',
  merchantAccountSha256: sha('generated-merchant'),
  apiOrigins: [origin],
};
const charge: ChargeRequest = {
  paymentId: randomUUID(),
  attemptNo: 1,
  idempotencyKey: randomUUID(),
  amountMicros: 100n,
  currency: 'XTS',
  minorUnitExponent: 2,
  customerRef: 'generated-customer',
};
const base = { organizationId: randomUUID(), paymentId: charge.paymentId, authority };
const input = (method: 'GET' | 'POST', path: string) => ({
  method,
  path,
  headers: { authorization: 'Bearer generated-test-only' },
  timeoutMs: 2000,
});
const processor: PaymentProcessor = {
  manifest: {
    processor: 'test_scripted',
    version: '1.0.0',
    lookup: 'authoritative',
    nativeIdempotency: true,
    webhookScheme: 'ensemus_hmac_sha256_v1',
  },
  identifyExecution: (context) =>
    context.withCredential(async () => {
      const answer = await context.request(input('GET', '/identity'));
      return JSON.parse(Buffer.from(answer.body).toString('utf8')) as PaymentExecutionIdentity;
    }),
  async createCustomer(context) {
    await context.request(input('POST', '/customer'));
    return { customerRef: 'generated-customer' };
  },
  async charge(context) {
    await context.request(input('POST', '/charge'));
    return { outcome: 'succeeded', code: 'CHARGED', processorPaymentRef: 'generated-payment' };
  },
  async lookup(context) {
    await context.request(input('GET', '/lookup'));
    return { found: 'not_found' };
  },
  interpretWebhook: () => null,
};
const credential = async <T>(use: (bytes: Buffer) => Promise<T>) => {
  const bytes = Buffer.from('generated-local-secret');
  try {
    return await use(bytes);
  } finally {
    bytes.fill(0);
  }
};
const noNetwork: ProcessorCallContext = {
  withCredential: credential,
  signal: new AbortController().signal,
  request: async () => {
    throw new Error('TEST_TRANSPORT_MUST_NOT_BE_REACHED');
  },
};
async function fixture() {
  const server = await fakeProvider((_request, socket) => {
    const body = Buffer.from(JSON.stringify(identity));
    socket.end(
      Buffer.concat([
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`),
        body,
      ]),
    );
  });
  // Explicit SQL-admission double. These tests qualify real local TLS/native parsing only, not DB authority.
  const admission = vi.fn(async (_binding: PaymentGatewayBinding) => undefined);
  const gateway = createPaymentHttpGateway({
    network: server.network,
    apiOrigin: origin,
    processor: 'test_scripted',
    adapterVersion: '1.0.0',
    assertAuthority: admission,
    testCa: server.ca,
  });
  const call = (binding: PaymentGatewayBinding): ProcessorCallContext => ({
    withCredential: credential,
    signal: new AbortController().signal,
    request: (value) => gateway(binding, value, new AbortController().signal),
  });
  const proof = await identifyPaymentExecution(
    processor,
    call({ ...base, phase: 'identity' }),
    authority.authoritySha256,
  );
  if (!proof) {
    await server.close();
    throw new Error('TEST_NATIVE_IDENTITY_MISSING');
  }
  const binding = {
    id: randomUUID(),
    identitySha256: proof.sha256,
    accountNamespaceSha256: proof.accountNamespaceSha256,
    bindingSha256: sha('generated-binding'),
  };
  return {
    server,
    admission,
    proof,
    binding,
    call,
    native: (phase: 'customer' | 'charge' | 'lookup') =>
      call({
        ...base,
        phase,
        identityProof: proof,
        executionBinding: binding,
        attemptId: randomUUID(),
        customerToken: randomUUID(),
      }),
  };
}
afterEach(() => vi.restoreAllMocks());
describe('native payment execution identity and single gateway exchange', () => {
  it('requires an authenticated local TLS identity response, then accepts exactly one real customer/charge/lookup exchange', async () => {
    const f = await fixture();
    try {
      expect(f.proof.identity).toEqual(identity);
      expect(
        await runBoundCustomerRegistration(
          processor,
          f.native('customer'),
          {
            idempotencyKey: randomUUID(),
            billingEmail: 'generated@example.invalid',
            billingName: 'Generated',
          },
          authority.authoritySha256,
        ),
      ).toBe('generated-customer');
      expect(
        await runBoundCharge(processor, f.native('charge'), charge, authority.authoritySha256),
      ).toMatchObject({ outcome: 'succeeded', processorPaymentRef: 'generated-payment' });
      expect(
        await runBoundPaymentLookup(
          processor,
          f.native('lookup'),
          charge.idempotencyKey,
          authority.authoritySha256,
        ),
      ).toEqual({ found: 'not_found' });
      expect(f.server.requests.map((request) => request.path)).toEqual([
        '/identity',
        '/customer',
        '/charge',
        '/lookup',
      ]);
      expect(f.admission).toHaveBeenCalledTimes(4);
    } finally {
      await f.server.close();
    }
  });
  it('refuses a static identity declaration and a fake successful HTTP object without the actual gateway receipt', async () => {
    expect(
      await identifyPaymentExecution(
        { ...processor, identifyExecution: async () => identity },
        noNetwork,
        authority.authoritySha256,
      ),
    ).toBeNull();
    const fake = {
      ...noNetwork,
      request: async () => ({
        status: 200,
        body: Buffer.from(JSON.stringify(identity)),
        transportReceipt: { origin, authoritySha256: authority.authoritySha256 },
      }),
    };
    expect(await identifyPaymentExecution(processor, fake, authority.authoritySha256)).toBeNull();
  });
  it('never treats an adapter declaration without transport as registration, successful charge, not-sent or authoritative absence', async () => {
    const declared: PaymentProcessor = {
      ...processor,
      createCustomer: async () => ({ customerRef: 'invented' }),
      charge: async () => ({
        outcome: 'not_sent',
        code: 'PROCESSOR_NOT_CONFIGURED',
        retryable: true,
      }),
      lookup: async () => ({ found: 'not_found' }),
    };
    expect(
      await runBoundCustomerRegistration(
        declared,
        noNetwork,
        {
          idempotencyKey: randomUUID(),
          billingEmail: 'generated@example.invalid',
          billingName: 'Generated',
        },
        authority.authoritySha256,
      ),
    ).toBeNull();
    expect(await runBoundCharge(declared, noNetwork, charge, authority.authoritySha256)).toEqual({
      outcome: 'indeterminate',
      code: 'PROCESSOR_ERROR',
    });
    expect(
      await runBoundPaymentLookup(
        declared,
        noNetwork,
        charge.idempotencyKey,
        authority.authoritySha256,
      ),
    ).toEqual({ found: 'cannot_answer' });
  });
  it('refuses a changed credential authority or merchant fingerprint before any POST', async () => {
    const f = await fixture();
    try {
      for (const changed of [
        {
          ...base,
          authority: { ...authority, authoritySha256: sha('replacement') },
          executionBinding: f.binding,
        },
        { ...base, executionBinding: { ...f.binding, identitySha256: sha('different-merchant') } },
      ])
        await expect(
          f
            .call({ ...changed, phase: 'charge', identityProof: f.proof })
            .request(input('POST', '/charge')),
        ).rejects.toThrow('PAYMENT_NATIVE_IDENTITY_REQUIRED');
      expect(f.server.requests).toHaveLength(1);
    } finally {
      await f.server.close();
    }
  });
  it('rechecks real SQL admission immediately before transport and never resends after an admission failure', async () => {
    const f = await fixture();
    try {
      f.admission.mockRejectedValue(new Error('TEST_ORIGINAL_CREDENTIAL_REVOKED'));
      expect(
        await runBoundCharge(processor, f.native('charge'), charge, authority.authoritySha256),
      ).toEqual({ outcome: 'indeterminate', code: 'PROCESSOR_ERROR' });
      expect(f.server.requests).toHaveLength(1);
      expect(f.admission).toHaveBeenCalledTimes(2);
    } finally {
      await f.server.close();
    }
  });
  it('rejects expired proofs before SQL or network', async () => {
    const f = await fixture();
    try {
      vi.spyOn(Date, 'now').mockReturnValue(f.proof.verifiedAtEpochMs + 60_001);
      await expect(f.native('charge').request(input('POST', '/charge'))).rejects.toThrow(
        'PAYMENT_NATIVE_IDENTITY_REQUIRED',
      );
      expect(f.admission).toHaveBeenCalledTimes(1);
      expect(f.server.requests).toHaveLength(1);
    } finally {
      await f.server.close();
    }
  });
  it('refuses a second side-effect request even if the native adapter tries to make one', async () => {
    const f = await fixture();
    try {
      const twice: PaymentProcessor = {
        ...processor,
        async charge(context) {
          await context.request(input('POST', '/charge'));
          await context.request(input('POST', '/charge'));
          return {
            outcome: 'succeeded',
            code: 'CHARGED',
            processorPaymentRef: 'generated-payment',
          };
        },
      };
      expect(
        await runBoundCharge(twice, f.native('charge'), charge, authority.authoritySha256),
      ).toEqual({ outcome: 'indeterminate', code: 'PROCESSOR_ERROR' });
      expect(f.server.requests.map((request) => request.path)).toEqual(['/identity', '/charge']);
    } finally {
      await f.server.close();
    }
  });
});
