// Local stand-ins for Paddle, Payme and Click, built from their published wire formats, so the adapters can
// be held to their contracts with no network. Generated keys and IDs only; nothing here is a real account.
// Test doubles: lint keeps this directory out of every shipped entry point.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PaddleHttp } from '../payment/providers/paddle';
import { signPaddleNotification } from '../payment/providers/paddle';
import { paymeAuthorizationFor } from '../payment/providers/payme';
import { signClickRequest } from '../payment/providers/click';

const id = (prefix: string) => `${prefix}_${randomBytes(13).toString('hex')}`;

type FakeTransaction = {
  id: string;
  status: 'ready' | 'completed' | 'canceled';
  customer_id: string;
  address_id: string;
  currency_code: string;
  custom_data: Record<string, unknown>;
  subtotal: bigint;
  tax: bigint;
};

/**
 * A Paddle that keeps customers, addresses and transactions in memory, adds a scripted tax to anything
 * priced, and can sign a notification the way Paddle does. `failNext` scripts an outage.
 */
export function createFakePaddle(options: {
  apiKey: string;
  taxFor: (subtotal: bigint) => bigint;
}) {
  const customers = new Map<string, { id: string; email: string }>();
  const transactions = new Map<string, FakeTransaction>();
  const requests: { method: string; path: string }[] = [];
  let failNext: number | null = null;
  const json = (status: number, value: unknown) => ({
    status,
    body: new TextEncoder().encode(JSON.stringify(value)),
  });
  const view = (txn: FakeTransaction) => ({
    id: txn.id,
    status: txn.status,
    customer_id: txn.customer_id,
    currency_code: txn.currency_code,
    custom_data: txn.custom_data,
    details: {
      totals: {
        subtotal: txn.subtotal.toString(),
        tax: txn.tax.toString(),
        total: (txn.subtotal + txn.tax).toString(),
        grand_total: (txn.subtotal + txn.tax).toString(),
      },
    },
    checkout: { url: `https://pay.example.test/checkout?_ptxn=${txn.id}` },
  });
  const http: PaddleHttp = async (request) => {
    requests.push({ method: request.method, path: request.path });
    if (failNext !== null) {
      const status = failNext;
      failNext = null;
      return json(status, { error: { code: 'scripted' } });
    }
    if (
      request.headers.authorization !== `Bearer ${options.apiKey}` ||
      request.headers['paddle-version'] !== '1'
    )
      return json(403, { error: { code: 'forbidden' } });
    type Body = {
      email: string;
      customer_id: string;
      address_id: string;
      currency_code: string;
      custom_data: Record<string, unknown>;
      items: { quantity: number; price: { unit_price: { amount: string } } }[];
    };
    const body = request.body ? (JSON.parse(request.body.toString('utf8')) as Body) : null;
    const url = new URL(request.path, 'https://paddle.invalid');
    if (request.method === 'GET' && url.pathname === '/customers') {
      const email = url.searchParams.get('email');
      return json(200, { data: [...customers.values()].filter((c) => c.email === email) });
    }
    if (request.method === 'POST' && url.pathname === '/customers') {
      const customer = { id: id('ctm'), email: body!.email };
      customers.set(customer.id, customer);
      return json(201, { data: customer });
    }
    const address = /^\/customers\/(ctm_[a-z0-9]+)\/addresses$/.exec(url.pathname);
    if (request.method === 'POST' && address)
      return customers.has(address[1]!) ? json(201, { data: { id: id('add') } }) : json(404, {});
    const priced = (items: Body['items']) =>
      BigInt(items[0]!.price.unit_price.amount) * BigInt(items[0]!.quantity);
    if (request.method === 'POST' && url.pathname === '/transactions/preview') {
      const subtotal = priced(body!.items);
      return json(200, {
        data: view({
          id: 'txn_preview',
          status: 'ready',
          customer_id: '',
          address_id: '',
          currency_code: body!.currency_code,
          custom_data: {},
          subtotal,
          tax: options.taxFor(subtotal),
        }),
      });
    }
    if (request.method === 'POST' && url.pathname === '/transactions') {
      if (!customers.has(body!.customer_id)) return json(400, {});
      const subtotal = priced(body!.items);
      const txn: FakeTransaction = {
        id: id('txn'),
        status: 'ready',
        customer_id: body!.customer_id,
        address_id: body!.address_id,
        currency_code: body!.currency_code,
        custom_data: body!.custom_data,
        subtotal,
        tax: options.taxFor(subtotal),
      };
      transactions.set(txn.id, txn);
      return json(201, { data: view(txn) });
    }
    const one = /^\/transactions\/(txn_[a-z0-9]+)$/.exec(url.pathname);
    if (request.method === 'GET' && one) {
      const txn = transactions.get(one[1]!);
      return txn ? json(200, { data: view(txn) }) : json(404, {});
    }
    return json(404, {});
  };
  return {
    http,
    requests,
    transactions,
    failNext(status: number) {
      failNext = status;
    },
    /** The customer paid at checkout. Answers the notification Paddle would send, signed. */
    pay(transactionId: string, secret: Buffer, nowSeconds: number) {
      const txn = transactions.get(transactionId)!;
      txn.status = 'completed';
      return notification(secret, 'transaction.completed', view(txn), nowSeconds);
    },
    cancel(transactionId: string, secret: Buffer, nowSeconds: number) {
      const txn = transactions.get(transactionId)!;
      txn.status = 'canceled';
      return notification(secret, 'transaction.canceled', view(txn), nowSeconds);
    },
  };
}

function notification(secret: Buffer, eventType: string, data: unknown, nowSeconds: number) {
  const body = new TextEncoder().encode(
    JSON.stringify({
      event_id: id('evt'),
      event_type: eventType,
      occurred_at: new Date(nowSeconds * 1000).toISOString(),
      notification_id: id('ntf'),
      data,
    }),
  );
  return {
    body,
    headers: { 'paddle-signature': signPaddleNotification(secret, body, nowSeconds) },
  };
}

/** Payme's side of the Merchant API: builds the calls Payme makes, with its Basic credential. */
export function createFakePayme(merchantKey: Buffer) {
  let rpc = 0;
  const call = (method: string, params: Record<string, unknown>) => ({
    body: new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params })),
    authorization: paymeAuthorizationFor(merchantKey),
  });
  const txnId = () => randomBytes(12).toString('hex');
  return { call, txnId };
}

/** Click's side of the SHOP API: builds signed Prepare and Complete requests. */
export function createFakeClick(input: { secretKey: Buffer; serviceId: string }) {
  let trans = 1000;
  const request = (fields: {
    action: 0 | 1;
    clickTransId?: string;
    orderRef: string;
    amount: string;
    merchantPrepareId?: string;
    error?: number;
  }) => {
    const form = {
      click_trans_id: fields.clickTransId ?? String(++trans),
      service_id: input.serviceId,
      click_paydoc_id: String(trans + 5000),
      merchant_trans_id: fields.orderRef,
      amount: fields.amount,
      action: String(fields.action),
      error: String(fields.error ?? 0),
      error_note: fields.error ? 'Payment failed' : 'Success',
      sign_time: '2026-11-11 10:00:00',
      merchant_prepare_id: fields.merchantPrepareId ?? null,
    };
    const sign = signClickRequest(form, input.secretKey);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...form, sign_string: sign }))
      if (value !== null) params.set(key, value);
    return { body: new TextEncoder().encode(params.toString()), clickTransId: form.click_trans_id };
  };
  return { request };
}

export const generatedSecret = () =>
  Buffer.from(createHash('sha256').update(randomUUID()).digest('hex'));
