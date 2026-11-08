// Generated local TLS processor + real app/secrets SQL admission. Nothing here is a shipped provider.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { interactiveSessionOf, type AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import type { openSecretsDatabase } from '@ensemus/database/secrets';
import { createConnection, createWebhookEndpoint } from '@ensemus/application';
import { requestInvoicePayment, requestInvoicePaymentOnce, beginPaymentAttempt } from '@ensemus/application/saas/payments';
import {
  preflightPaymentExecution,
  bindPaymentExecution,
  beginPaymentCustomerRegistration,
  finishPaymentCustomerRegistration,
  assertPaymentTransport,
  type PaymentExecutionBinding,
} from '@ensemus/application/saas/payment-execution';
import {
  createPaymentConnector,
  createPaymentHttpGateway,
  identifyPaymentExecution,
  runBoundCustomerRegistration,
  SECRET_PURPOSE_PAYMENT_PROCESSOR,
  type VerifiedPaymentExecutionIdentity,
} from '@ensemus/connectors/payment';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { storeSecret } from '@ensemus/secrets/seal';
import { SECRET_PURPOSE_WEBHOOK_SIGNING } from '@ensemus/domain/connector';
import {
  paymentExecutionIdentity,
  type PaymentConnectionAuthority,
  type PaymentEventFact,
  type PaymentExecutionIdentity,
  type PaymentGatewayBinding,
  type PaymentProcessor,
  type ProcessorCallContext,
} from '@ensemus/saas/payment';
import { createPaymentIdentityAttester } from '../../workers/workflow/src/payment-identity';
import { createPaymentWebhookAttester } from '../../workers/workflow/src/payment-webhook-attester';
import { paymentFixture, paymentTenant } from '../integration/saas-payment-fixture';
import { fakeJson, fakeProvider } from './fake-provider';
import { proveSecondFactor } from './product';
import { secret } from './stack';

export async function nativePaymentFixture(
  database: AppDatabase,
  auth: pg.Client,
  secretsDb: ReturnType<typeof openSecretsDatabase>,
  options: { operator?: Awaited<ReturnType<typeof paymentTenant>>; requestKey?: string; lookup?: 'none' | 'authoritative' } = {},
) {
  const who = await paymentFixture(database, auth, { legacyCustomer: false });
  const operator = options.operator ?? await paymentTenant(database, auth);
  for (const owner of [who.owner, operator])
    await proveSecondFactor({
      userId: owner.userId,
      sessionId: interactiveSessionOf(owner)!.sessionId,
    });
  const operatorContext = createServiceContext(operator.organizationId);
  const generatedCredential = randomBytes(32).toString('hex'),
    signingKey = randomBytes(32).toString('hex');
  const credential = await storeSecret(database, operator, {
    publicKeyPem: secret('sealing_public_key.pem'),
    purpose: SECRET_PURPOSE_PAYMENT_PROCESSOR,
    plaintext: generatedCredential,
  });
  const signing = await storeSecret(database, operator, {
    publicKeyPem: secret('sealing_public_key.pem'),
    purpose: SECRET_PURPOSE_WEBHOOK_SIGNING,
    plaintext: signingKey,
  });
  const apiOrigin = 'https://generated.mcp.invalid';
  let identity: PaymentExecutionIdentity = {
    version: 'ensemus.payment-execution/v1',
    processor: 'test_scripted',
    adapterVersion: '1.0.0',
    environment: 'generated_test',
    merchantAccountSha256: createHash('sha256').update(randomUUID()).digest('hex'),
    apiOrigins: [apiOrigin],
  };
  const customerRef = `generated-customer:${randomUUID()}`,
    processorPaymentRef = `generated-payment:${randomUUID()}`;
  // This fictional wire contract is explicit test behavior, not a real processor's compatibility claim.
  type ChargeMode = 'success' | 'not_sent' | 'drop_before_accept' | 'drop_after_accept';
  let nextCharge: ChargeMode = 'success';
  const charges = new Map<string, string>();
  const server = await fakeProvider((request, socket) => {
    const authorized = request.headers.authorization === `Bearer ${generatedCredential}`;
    if (!authorized) return fakeJson(socket, 403, { code: 'REFUSED' });
    if (request.method === 'GET' && request.path === '/identity')
      return fakeJson(socket, 200, identity);
    if (request.method === 'POST' && request.path === '/customer')
      return fakeJson(socket, 200, { customerRef });
    if (request.method === 'POST' && request.path === '/charge') {
      const value = JSON.parse(request.body.toString('utf8')) as { idempotencyKey: string };
      if (typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length > 256)
        return fakeJson(socket, 400, { code: 'INVALID' });
      if (charges.has(value.idempotencyKey))
        return fakeJson(socket, 200, { processorPaymentRef: charges.get(value.idempotencyKey) });
      const mode = nextCharge;
      nextCharge = 'success';
      if (mode === 'not_sent') return fakeJson(socket, 429, { code: 'NOT_ACCEPTED' });
      if (mode === 'drop_before_accept') return socket.destroy();
      charges.set(value.idempotencyKey, charges.get(value.idempotencyKey) ?? processorPaymentRef);
      if (mode === 'drop_after_accept') return socket.destroy();
      return fakeJson(socket, 200, { processorPaymentRef: charges.get(value.idempotencyKey) });
    }
    if (request.method === 'GET' && request.path.startsWith('/lookup?key=')) {
      const key = new URL(request.path, apiOrigin).searchParams.get('key') ?? '';
      const found = charges.get(key);
      return found
        ? fakeJson(socket, 200, { processorPaymentRef: found })
        : fakeJson(socket, 404, { code: 'AUTHORITATIVE_ABSENCE' });
    }
    return fakeJson(socket, 404, { code: 'UNKNOWN_ROUTE' });
  });
  try {
    const request = (context: ProcessorCallContext, method: 'GET' | 'POST', path: string, body?: unknown) =>
      context.withCredential((bytes) =>
        context.request({
          method,
          path,
          headers: { authorization: `Bearer ${bytes.toString('utf8')}` },
          ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)) }),
          timeoutMs: 5000,
        }),
      );
    const processor: PaymentProcessor = {
      manifest: {
        processor: 'test_scripted',
        version: '1.0.0',
        nativeIdempotency: true,
        lookup: options.lookup ?? 'authoritative',
        webhookScheme: 'ensemus_hmac_sha256_v1',
      },
      async identifyExecution(context) {
        const response = await request(context, 'GET', '/identity');
        if (response.status !== 200) return null;
        return (
          paymentExecutionIdentity(
            JSON.parse(Buffer.from(response.body).toString('utf8')),
            processor.manifest,
          )?.identity ?? null
        );
      },
      async createCustomer(context) {
        const response = await request(context, 'POST', '/customer');
        if (response.status !== 200) throw new Error('TEST_PROVIDER_REFUSED');
        return JSON.parse(Buffer.from(response.body).toString('utf8')) as { customerRef: string };
      },
      async charge(context, input) {
        const response = await request(context, 'POST', '/charge', {
          ...input, amountMicros: input.amountMicros.toString(),
        });
        if (response.status === 429) return { outcome: 'not_sent', code: 'RATE_LIMITED', retryable: true };
        if (response.status !== 200) return { outcome: 'indeterminate', code: 'PROCESSOR_ERROR' };
        const value = JSON.parse(Buffer.from(response.body).toString('utf8')) as {
          processorPaymentRef: string;
        };
        return {
          outcome: 'succeeded',
          code: 'CHARGED',
          processorPaymentRef: value.processorPaymentRef,
        };
      },
      async lookup(context, key) {
        const response = await request(context, 'GET', `/lookup?key=${encodeURIComponent(key)}`);
        if (response.status === 404) return { found: 'not_found' };
        if (response.status !== 200) return { found: 'cannot_answer' };
        const value = JSON.parse(Buffer.from(response.body).toString('utf8')) as {
          processorPaymentRef: string;
        };
        return { found: 'succeeded', processorPaymentRef: value.processorPaymentRef };
      },
      interpretWebhook: () => null,
      interpretExecutionWebhook(_id, body) {
        const value = JSON.parse(Buffer.from(body).toString('utf8')) as {
          event: PaymentEventFact;
          identity: PaymentExecutionIdentity;
        };
        return value;
      },
    };
    const connector = createPaymentConnector(processor);
    const connection = await createConnection(database, operator, {
      connectorType: connector.manifest.type,
      displayName: 'Generated local native processor',
      config: {},
      credentialSecretId: credential.secretRef,
      manifests: [
        { type: connector.manifest.type, credential: { required: true }, configFields: {} },
      ],
    });
    const endpoint = await createWebhookEndpoint(database, operator, {
      connectionId: connection.id,
      signingSecretId: signing.secretRef,
      signatureScheme: 'ensemus_hmac_sha256_v1',
    });
    const paymentInput = { invoiceId: who.invoice.id, processor: 'test_scripted' };
    const payment = options.requestKey
      ? await requestInvoicePaymentOnce(database, who.owner, { ...paymentInput, requestKey: options.requestKey })
      : await requestInvoicePayment(database, who.owner, paymentInput);
    if ('kind' in payment && payment.kind === 'conflict') throw new Error('TEST_PAYMENT_REQUEST_CONFLICT');
    const broker = new SecretBroker(
      secretsDb.db,
      new FileKeyProvider([secret('sealing_private_key.pem')]),
    );
    const attest = createPaymentIdentityAttester(secretsDb.db);
    const gateway = createPaymentHttpGateway({
      network: server.network,
      apiOrigin,
      processor: 'test_scripted',
      adapterVersion: processor.manifest.version,
      testCa: server.ca,
      assertAuthority: (binding) =>
        assertPaymentTransport(database, createServiceContext(binding.organizationId), binding),
    });
    let authority: PaymentConnectionAuthority,
      proof: VerifiedPaymentExecutionIdentity,
      binding: PaymentExecutionBinding;
    const call = (
      phase: PaymentGatewayBinding['phase'],
      ids: { attemptId?: string; customerToken?: string } = {},
    ): ProcessorCallContext => ({
      signal: AbortSignal.timeout(10000),
      withCredential: (use) =>
        broker.withSecret(
          {
            organizationId: operator.organizationId,
            secretId: authority.credentialSecretId,
            purpose: SECRET_PURPOSE_PAYMENT_PROCESSOR,
          },
          use,
        ),
      async request(this: ProcessorCallContext, value) {
        return gateway(
          {
            organizationId: who.owner.organizationId,
            paymentId: payment.paymentId,
            authority,
            phase,
            ...(phase === 'identity' ? {} : { executionBinding: binding, identityProof: proof }),
            ...ids,
          },
          value,
          this.signal,
        );
      },
    });
    async function refresh() {
      authority = await preflightPaymentExecution(database, who.service, {
        paymentId: payment.paymentId,
        billingOrganizationId: operator.organizationId,
        connectionId: connection.id,
        processor: 'test_scripted',
        adapterVersion: processor.manifest.version,
        apiOrigin,
      });
      const observed = await identifyPaymentExecution(
        processor,
        call('identity'),
        authority.authoritySha256,
      );
      if (!observed) throw new Error('TEST_EXPECTED_ACTUAL_NATIVE_IDENTITY');
      proof = observed;
      return attest({
        organizationId: who.owner.organizationId,
        paymentId: payment.paymentId,
        authority,
        proof,
      });
    }
    async function qualify() {
      const token = await refresh();
      binding = await bindPaymentExecution(database, who.service, {
        paymentId: payment.paymentId,
        token: token.token,
      });
      return { token, binding, authority, proof };
    }
    async function register() {
      const begun = await beginPaymentCustomerRegistration(database, who.service, {
        paymentId: payment.paymentId,
        bindingId: binding.id,
      });
      if (begun.action === 'send' && begun.token) {
        const answer = await runBoundCustomerRegistration(
          processor,
          call('customer', { customerToken: begun.token }),
          {
            idempotencyKey: begun.requestKey,
            billingEmail: 'billing@example.invalid',
            billingName: 'Generated',
          },
          authority.authoritySha256,
        );
        await finishPaymentCustomerRegistration(database, who.service, {
          paymentId: payment.paymentId,
          bindingId: binding.id,
          token: begun.token,
          customerRef: answer,
        });
        return answer;
      }
      return begun.action === 'confirmed' ? begun.customerRef : null;
    }
    return {
      who,
      operator,
      operatorContext,
      processor,
      connector,
      credential,
      signing,
      signingKey,
      connection,
      endpoint,
      payment,
      charges,
      nextCharge: (mode: ChargeMode) => { nextCharge = mode; },
      server,
      broker,
      attest,
      refresh,
      qualify,
      register,
      call,
      attestWebhook: createPaymentWebhookAttester(secretsDb.db),
      get currentIdentity() {
        return identity;
      },
      changeMerchant: () => {
        identity = {
          ...identity,
          merchantAccountSha256: createHash('sha256').update(randomUUID()).digest('hex'),
        };
      },
      beginAttempt: () =>
        beginPaymentAttempt(database, who.service, {
          paymentId: payment.paymentId,
          runId: randomUUID(),
          executionBindingId: binding.id,
        }),
      close: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}
