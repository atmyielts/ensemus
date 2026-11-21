import { randomUUID } from 'node:crypto';
import { storedWebhookHeaders } from '@ensemus/domain/webhook';
import {
  decideClick,
  decidePaddle,
  decidePayme,
  type CheckoutSessionView,
} from '@ensemus/saas/checkout';
import { describe, expect, it } from 'vitest';
import { MalformedWebhook } from '../../index';
import { verifyWebhookSignature } from '../../runtime/webhook-signature';
import { describeConnectorConformance } from '../../testing';
import {
  createFakeClick,
  createFakePaddle,
  createFakePayme,
  generatedSecret,
} from '../../testing/checkout-fakes';
import { createPaymentConnector } from '../index';
import {
  clickCheckoutUrl,
  clickMerchantAuth,
  createCheckoutConnector,
  createClickProcessor,
  createPaddleClient,
  createPaddleProcessor,
  createPaddleTaxPort,
  createPaymeProcessor,
  interpretPaddleNotification,
  paymeCheckoutUrl,
  readClickPaymentStatus,
} from './index';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const contextFor = (config: unknown) =>
  ({ organizationId: randomUUID(), connectionId: randomUUID(), config }) as never;

// The suite every connector passes, against each adapter as the charge path sees it and each checkout
// address as the webhook path sees it.
for (const make of [createPaddleProcessor, createPaymeProcessor, createClickProcessor])
  describeConnectorConformance(
    `${make().manifest.processor} payment adapter`,
    () => createPaymentConnector(make()),
    {
      config: {},
    },
  );
describeConnectorConformance('paddle checkout', () => createCheckoutConnector('paddle'), {
  config: {},
});
describeConnectorConformance('payme checkout', () => createCheckoutConnector('payme'), {
  config: {},
});
describeConnectorConformance('click checkout', () => createCheckoutConnector('click'), {
  config: { serviceId: '55' },
});

describe('the charge path can never reach a checkout provider', () => {
  it('answers not_sent on purpose, with no contact, for all three', async () => {
    for (const processor of [
      createPaddleProcessor(),
      createPaymeProcessor(),
      createClickProcessor(),
    ]) {
      let contacted = false;
      const context = {
        signal: new AbortController().signal,
        withCredential: async () => {
          contacted = true;
          throw new Error('no');
        },
        request: async () => {
          contacted = true;
          throw new Error('no');
        },
      };
      const result = await processor.charge(context as never, {
        paymentId: randomUUID(),
        attemptNo: 1,
        idempotencyKey: 'k',
        amountMicros: 1_000_000n,
        currency: 'USD',
        minorUnitExponent: 2,
        customerRef: 'c',
      });
      expect(result).toEqual({ outcome: 'not_sent', code: 'NO_PAYMENT_METHOD', retryable: false });
      expect(contacted).toBe(false);
      expect(processor.manifest.nativeIdempotency).toBe(true);
    }
  });
});

describe('Paddle against a local Paddle', () => {
  const apiKey = `pdl_sdbx_apikey_${randomUUID().replaceAll('-', '')}`;
  const secret = generatedSecret();
  const fake = createFakePaddle({ apiKey, taxFor: (subtotal) => subtotal / 10n });
  const client = createPaddleClient({
    environment: 'sandbox',
    http: fake.http,
    withApiKey: (use) => use(Buffer.from(apiKey)),
    taxCategory: 'standard',
  });

  it('opens one checkout with our reference, and reads it back authoritatively', async () => {
    const orderRef = randomUUID();
    const customer = await client.customerFor({ email: 'billing@example.test', name: 'Example' });
    expect(await client.customerFor({ email: 'billing@example.test', name: 'Example' })).toBe(
      customer,
    );
    const address = await client.addressFor(customer, {
      countryCode: 'DE',
      postalCode: '10115',
      region: '',
    });
    const opened = await client.createTransaction({
      customerId: customer,
      addressId: address,
      currency: 'USD',
      amountMinor: 10_000n,
      description: 'Invoice 7',
      orderRef,
    });
    expect(new URL(opened.checkoutUrl).searchParams.get('_ptxn')).toBe(opened.transactionId);
    expect(fake.transactions.get(opened.transactionId)?.custom_data).toEqual({
      ensemus_order: orderRef,
    });
    expect(await client.transaction(opened.transactionId)).toEqual({
      status: 'open',
      transactionId: opened.transactionId,
    });

    const delivered = fake.pay(opened.transactionId, secret, NOW_S);
    const verdict = verifyWebhookSignature(secret, {
      scheme: 'paddle_signature_v1',
      body: delivered.body,
      headers: storedWebhookHeaders('paddle_signature_v1', delivered.headers),
      nowMs: NOW_MS,
      toleranceSeconds: 300,
    });
    expect(verdict.ok).toBe(true);
    const fact = interpretPaddleNotification(delivered.body)!;
    expect(fact).toMatchObject({
      kind: 'paid',
      orderRef,
      currency: 'USD',
      grandTotalMinor: '11000',
      taxMinor: '1000',
    });
    const session: CheckoutSessionView = {
      id: orderRef,
      processor: 'paddle',
      state: 'open',
      amountMinor: 11_000n,
      currency: 'USD',
      providerTxnRef: opened.transactionId,
      clickPrepareId: null,
      providerTimeMs: null,
      createdMs: null,
      performedMs: null,
      cancelledMs: null,
      cancelReason: null,
      invoiceOpen: true,
    };
    expect(decidePaddle(fact, session, 1n).outcome).toBe('apply');
    expect(await client.transaction(opened.transactionId)).toMatchObject({
      status: 'paid',
      grandTotalMinor: '11000',
    });
  });

  it('refuses a bad, stale, missing or rotated-away signature', () => {
    const delivered = fake.pay([...fake.transactions.keys()][0]!, secret, NOW_S);
    const verify = (headers: Record<string, string>, nowMs = NOW_MS, key = secret) =>
      verifyWebhookSignature(key, {
        scheme: 'paddle_signature_v1',
        body: delivered.body,
        headers,
        nowMs,
        toleranceSeconds: 300,
      });
    expect(verify({}).ok).toBe(false);
    expect(verify(delivered.headers, NOW_MS + 3_600_000)).toMatchObject({
      ok: false,
      code: 'TIMESTAMP_OUTSIDE_WINDOW',
    });
    expect(verify(delivered.headers, NOW_MS, generatedSecret())).toMatchObject({
      ok: false,
      code: 'BAD_SIGNATURE',
    });
    expect(
      verify({
        'paddle-signature': `${delivered.headers['paddle-signature']};h1=${'0'.repeat(64)}`,
      }).ok,
    ).toBe(true);
    expect(verify({ 'paddle-signature': `ts=${NOW_S};h1=zz` }).ok).toBe(false);
  });

  it('carries no Paddle text or key in its errors, and refuses a key for the other environment', async () => {
    fake.failNext(500);
    await expect(client.transaction('txn_0abc')).rejects.toMatchObject({
      code: 'PADDLE_UNAVAILABLE',
    });
    const live = createPaddleClient({
      environment: 'live',
      http: fake.http,
      withApiKey: (use) => use(Buffer.from(apiKey)),
      taxCategory: 'standard',
    });
    await expect(live.transaction('txn_0abc')).rejects.toMatchObject({
      code: 'PADDLE_NOT_CONFIGURED',
    });
    await expect(client.transaction('txn_0abc')).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining(apiKey),
    );
  });

  it("gives invoices Paddle's tax, and none for a currency Paddle is not used for", async () => {
    const port = createPaddleTaxPort(client);
    const signal = new AbortController().signal;
    const input = {
      idempotencyKey: 'invoice-1',
      currency: 'USD',
      countryCode: 'DE',
      regionCode: '',
      postalCode: '10115',
      taxId: null,
      lines: [{ kind: 'platform_fee', amountMicros: 100_000_000n }],
    };
    await expect(port.compute(input, signal)).resolves.toMatchObject({
      taxMicros: 10_000_000n,
      currency: 'USD',
    });
    await expect(port.compute({ ...input, currency: 'UZS' }, signal)).rejects.toMatchObject({
      code: 'TAX_PROVIDER_NOT_CONFIGURED',
    });
    await expect(
      port.compute({ ...input, lines: [{ kind: 'usage', amountMicros: 1n }] }, signal),
    ).rejects.toMatchObject({ code: 'TAX_ADDRESS_REJECTED' });
  });

  it('reads only the notifications it settles on, and refuses malformed ones', () => {
    expect(
      interpretPaddleNotification(
        new TextEncoder().encode(
          JSON.stringify({
            event_id: 'evt_1',
            event_type: 'customer.updated',
            occurred_at: new Date().toISOString(),
            data: {},
          }),
        ),
      ),
    ).toBeNull();
    expect(() =>
      interpretPaddleNotification(
        new TextEncoder().encode('{"event_type":"transaction.completed"}'),
      ),
    ).toThrow(MalformedWebhook);
  });
});

describe('Payme against a local Payme', () => {
  const key = generatedSecret();
  const payme = createFakePayme(key);
  const connector = createCheckoutConnector('payme');

  const deliver = (method: string, params: Record<string, unknown>, merchantKey = key) => {
    const request = payme.call(method, params);
    const verdict = verifyWebhookSignature(merchantKey, {
      scheme: 'payme_basic_v1',
      body: request.body,
      headers: storedWebhookHeaders('payme_basic_v1', { authorization: request.authorization }),
      nowMs: NOW_MS,
      toleranceSeconds: 300,
    });
    if (!verdict.ok) return { verdict, call: null };
    const [effect] = connector.webhooks!.interpret(contextFor({}), {
      providerEventId: verdict.providerEventId,
      body: request.body,
      signedAtSeconds: verdict.signedAtSeconds,
    });
    return { verdict, call: effect?.kind === 'checkout_callback' ? effect.callback : null };
  };

  it('never stores the credential, and refuses another key', () => {
    const request = payme.call('CheckTransaction', { id: 'x' });
    const stored = storedWebhookHeaders('payme_basic_v1', {
      authorization: request.authorization,
      'x-ensemus-authorization-sha256': 'f'.repeat(64),
    });
    expect(JSON.stringify(stored)).not.toContain(request.authorization.slice(6));
    expect(stored['x-ensemus-authorization-sha256']).not.toBe('f'.repeat(64));
    expect(deliver('CheckTransaction', { id: 'x' }, generatedSecret()).verdict).toMatchObject({
      ok: false,
    });
    const missing = verifyWebhookSignature(key, {
      scheme: 'payme_basic_v1',
      body: request.body,
      headers: {},
      nowMs: NOW_MS,
      toleranceSeconds: 300,
    });
    expect(missing).toMatchObject({ ok: false, code: 'SIGNATURE_MISSING' });
  });

  it('runs a whole payment: check, create, perform, and reconcile by CheckTransaction', () => {
    const orderRef = randomUUID();
    let session: CheckoutSessionView = {
      id: orderRef,
      processor: 'payme',
      state: 'open',
      amountMinor: 500_000n,
      currency: 'UZS',
      providerTxnRef: null,
      clickPrepareId: null,
      providerTimeMs: null,
      createdMs: null,
      performedMs: null,
      cancelledMs: null,
      cancelReason: null,
      invoiceOpen: true,
    };
    const now = BigInt(NOW_MS);
    const check = deliver('CheckPerformTransaction', {
      amount: 500000,
      account: { order_id: orderRef },
    });
    expect(JSON.parse(decidePayme(check.call as never, session, now).reply).result).toEqual({
      allow: true,
    });
    const txn = payme.txnId();
    const created = decidePayme(
      deliver('CreateTransaction', {
        id: txn,
        time: NOW_MS,
        amount: 500000,
        account: { order_id: orderRef },
      }).call as never,
      session,
      now,
    );
    expect(created.change?.to).toBe('reserved');
    session = {
      ...session,
      state: 'reserved',
      providerTxnRef: txn,
      createdMs: now,
      providerTimeMs: now,
    };
    const performed = decidePayme(
      deliver('PerformTransaction', { id: txn }).call as never,
      session,
      now + 1n,
    );
    expect(performed.change?.to).toBe('paid');
    session = { ...session, state: 'paid', performedMs: now + 1n };
    expect(
      JSON.parse(
        decidePayme(deliver('CheckTransaction', { id: txn }).call as never, session, now + 2n)
          .reply,
      ).result.state,
    ).toBe(2);
  });

  it('answers a method it does not offer, and refuses what is not JSON-RPC at all', () => {
    expect(deliver('ChangePassword', { password: 'x' }).call).toMatchObject({
      method: 'unsupported',
    });
    expect(() =>
      connector.webhooks!.interpret(contextFor({}), {
        providerEventId: 'payme:x',
        body: new TextEncoder().encode('{"params":{}}'),
        signedAtSeconds: 1,
      }),
    ).toThrow(MalformedWebhook);
  });

  it('builds the checkout link Payme documents', () => {
    const orderRef = randomUUID();
    const url = paymeCheckoutUrl({
      environment: 'sandbox',
      merchantId: 'a1b2c3',
      orderRef,
      amountTiyin: 500_000n,
      returnUrl: 'https://app.example.test/back',
      language: 'ru',
    });
    expect(url.startsWith('https://test.paycom.uz/')).toBe(true);
    expect(Buffer.from(url.split('/').at(-1)!, 'base64').toString()).toBe(
      `m=a1b2c3;ac.order_id=${orderRef};a=500000;c=https://app.example.test/back;l=ru`,
    );
    expect(() =>
      paymeCheckoutUrl({
        environment: 'live',
        merchantId: 'a1b2c3',
        orderRef,
        amountTiyin: 1n,
        returnUrl: 'https://x.test/a;m=evil',
        language: 'ru',
      }),
    ).toThrow();
  });
});

describe('Click against a local Click', () => {
  const secretKey = generatedSecret();
  const click = createFakeClick({ secretKey, serviceId: '55' });
  const connector = createCheckoutConnector('click');

  const deliver = (request: { body: Uint8Array }, key = secretKey, serviceId = '55') => {
    const verdict = verifyWebhookSignature(key, {
      scheme: 'click_md5_v1',
      body: request.body,
      headers: {},
      nowMs: NOW_MS,
      toleranceSeconds: 300,
    });
    if (!verdict.ok) return { verdict, call: null };
    const [effect] = connector.webhooks!.interpret(contextFor({ serviceId }), {
      providerEventId: verdict.providerEventId,
      body: request.body,
      signedAtSeconds: verdict.signedAtSeconds,
    });
    return { verdict, call: effect?.kind === 'checkout_callback' ? effect.callback : null };
  };

  it('runs Prepare then Complete with the prepare id in the Complete signature', () => {
    const orderRef = randomUUID();
    let session: CheckoutSessionView = {
      id: orderRef,
      processor: 'click',
      state: 'open',
      amountMinor: 123_450n,
      currency: 'UZS',
      providerTxnRef: null,
      clickPrepareId: 77n,
      providerTimeMs: null,
      createdMs: null,
      performedMs: null,
      cancelledMs: null,
      cancelReason: null,
      invoiceOpen: true,
    };
    const prepare = click.request({ action: 0, orderRef, amount: '1234.5' });
    const prepared = decideClick(deliver(prepare).call as never, session, 1n);
    expect(JSON.parse(prepared.reply)).toMatchObject({ error: 0, merchant_prepare_id: 77 });
    session = { ...session, state: 'reserved', providerTxnRef: prepare.clickTransId };
    const complete = click.request({
      action: 1,
      clickTransId: prepare.clickTransId,
      orderRef,
      amount: '1234.5',
      merchantPrepareId: '77',
    });
    expect(decideClick(deliver(complete).call as never, session, 2n).change?.to).toBe('paid');
  });

  it('refuses a bad signature, a changed field and another service', () => {
    const orderRef = randomUUID();
    const request = click.request({ action: 0, orderRef, amount: '10' });
    expect(deliver(request, generatedSecret()).verdict).toMatchObject({
      ok: false,
      code: 'BAD_SIGNATURE',
    });
    const tampered = new TextEncoder().encode(
      Buffer.from(request.body).toString().replace('amount=10', 'amount=1'),
    );
    expect(deliver({ body: tampered }).verdict).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    expect(() => deliver(request, secretKey, '56')).toThrow(MalformedWebhook);
  });

  it('builds the payment link and the Merchant API credential Click documents', () => {
    const orderRef = randomUUID();
    const url = new URL(
      clickCheckoutUrl({
        serviceId: '55',
        merchantId: '66',
        orderRef,
        amountTiyin: 123_405n,
        returnUrl: 'https://a.test/r',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://my.click.uz/services/pay');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      service_id: '55',
      merchant_id: '66',
      amount: '1234.05',
      transaction_param: orderRef,
      return_url: 'https://a.test/r',
    });
    const auth = clickMerchantAuth('77', Buffer.from('k'), 1_700_000_000).split(':');
    expect(auth[0]).toBe('77');
    expect(auth[1]).toMatch(/^[0-9a-f]{40}$/);
    expect(auth[2]).toBe('1700000000');
    const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(
      readClickPaymentStatus(200, body({ error_code: 0, payment_id: 9, payment_status: 2 }), '9'),
    ).toBe('paid');
    expect(
      readClickPaymentStatus(200, body({ error_code: 0, payment_id: 9, payment_status: 7 }), '9'),
    ).toBe('cannot_answer');
    expect(
      readClickPaymentStatus(200, body({ error_code: 0, payment_id: 8, payment_status: 2 }), '9'),
    ).toBe('cannot_answer');
  });
});
