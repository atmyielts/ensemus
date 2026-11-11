// Paddle Billing (ADR-032 D4a). Paddle is merchant of record for card payments abroad: it sells to the
// customer, works out and remits the tax, and tells us with signed notifications. We create one transaction
// per checkout, carrying our order reference in `custom_data`, and send the customer to its checkout link.
// Notifications are signed `Paddle-Signature: ts=…;h1=…`, HMAC-SHA-256 over `{ts}:{raw body}`.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isOrderRef, PADDLE_FACT_KINDS, type PaddleFact } from '@ensemus/domain/checkout';
import { isWebhookEventId, withinTimestampWindow } from '@ensemus/domain/webhook';
import type { PaymentProcessor } from '@ensemus/saas/payment';
import { CHECKOUT_CURRENCIES, parseMinor, type PaddleLookup } from '@ensemus/saas/checkout';
import { TaxRefused, type TaxInput, type TaxPort, type TaxResult } from '@ensemus/saas/tax';
import { MalformedWebhook, type WebhookVerification } from '../../index';

/** TLS names are code, so an egress gateway can only ever carry a request to the host its route names. */
export const PADDLE_API_TLS_NAMES = {
  live: 'api.paddle.com',
  sandbox: 'sandbox-api.paddle.com',
} as const;
export type PaddleEnvironment = keyof typeof PADDLE_API_TLS_NAMES;

/** The key's own prefix names its environment, so a live key can never be used against the sandbox. */
const KEY_PREFIX: Record<PaddleEnvironment, string> = {
  live: 'pdl_live_apikey_',
  sandbox: 'pdl_sdbx_apikey_',
};

const SIGNATURE_PART = /^h1=([0-9a-f]{64})$/;

export function verifyPaddleSignature(
  secret: Buffer,
  input: {
    body: Uint8Array;
    headers: Readonly<Record<string, string>>;
    nowMs: number;
    toleranceSeconds: number;
  },
): WebhookVerification {
  const header = input.headers['paddle-signature'];
  if (!header) return { ok: false, code: 'SIGNATURE_MISSING' };
  const parts = header.split(';');
  const ts = parts.find((part) => part.startsWith('ts='))?.slice(3);
  if (
    !ts ||
    !/^[0-9]{1,15}$/.test(ts) ||
    parts.filter((part) => part.startsWith('ts=')).length !== 1
  )
    return { ok: false, code: 'TIMESTAMP_MISSING' };
  // More than one h1 is how Paddle signs during a secret rotation. Any one of them may match.
  const signatures = parts
    .filter((part) => part !== `ts=${ts}`)
    .map((part) => SIGNATURE_PART.exec(part)?.[1] ?? null);
  if (!signatures.length || signatures.length > 4 || signatures.some((value) => value === null))
    return { ok: false, code: 'BAD_SIGNATURE' };
  if (!secret.length) return { ok: false, code: 'BAD_SIGNATURE' };
  const expected = createHmac('sha256', secret).update(`${ts}:`).update(input.body).digest();
  if (!signatures.some((value) => timingSafeEqual(expected, Buffer.from(value!, 'hex'))))
    return { ok: false, code: 'BAD_SIGNATURE' };
  const signedAtSeconds = Number(ts);
  if (!withinTimestampWindow(signedAtSeconds, input.nowMs, input.toleranceSeconds))
    return { ok: false, code: 'TIMESTAMP_OUTSIDE_WINDOW' };
  // The event ID is inside the signed bytes, so it is read only now.
  const eventId = readEnvelope(input.body)?.eventId;
  if (!eventId) return { ok: false, code: 'MALFORMED_PAYLOAD' };
  return { ok: true, providerEventId: eventId, signedAtSeconds };
}

export function signPaddleNotification(secret: Buffer, body: Uint8Array, ts: number): string {
  return `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:`).update(body).digest('hex')}`;
}

type Envelope = {
  eventId: string;
  eventType: string;
  occurredAtSeconds: number;
  data: Record<string, unknown>;
};

function readEnvelope(body: Uint8Array): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const occurred = typeof value.occurred_at === 'string' ? Date.parse(value.occurred_at) : NaN;
  if (
    typeof value.event_id !== 'string' ||
    !/^evt_[a-z0-9]{1,64}$/.test(value.event_id) ||
    !isWebhookEventId(value.event_id) ||
    typeof value.event_type !== 'string' ||
    !/^[a-z_]+\.[a-z_]+$/.test(value.event_type) ||
    !Number.isFinite(occurred) ||
    !value.data ||
    typeof value.data !== 'object' ||
    Array.isArray(value.data)
  )
    return null;
  return {
    eventId: value.event_id,
    eventType: value.event_type,
    occurredAtSeconds: Math.floor(occurred / 1000),
    data: value.data as Record<string, unknown>,
  };
}

const TXN = /^txn_[a-z0-9]{1,64}$/;
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function totalsOf(data: Record<string, unknown>) {
  const totals = object(object(data.details)?.totals);
  const grand = typeof totals?.grand_total === 'string' ? totals.grand_total : null;
  const tax = typeof totals?.tax === 'string' ? totals.tax : null;
  const subtotal = typeof totals?.subtotal === 'string' ? totals.subtotal : null;
  if (parseMinor(grand) === null || parseMinor(tax) === null || parseMinor(subtotal) === null)
    return null;
  return { grand: grand!, tax: tax!, subtotal: subtotal! };
}

/**
 * Reads a notification whose signature has passed. A transaction that is completed or paid, a cancelled
 * transaction, and an approved refund or chargeback adjustment become facts; another well-formed type is
 * null, and anything malformed throws.
 */
export function interpretPaddleNotification(body: Uint8Array): PaddleFact | null {
  const envelope = readEnvelope(body);
  if (!envelope) throw new MalformedWebhook();
  const { data } = envelope;
  const base = {
    provider: 'paddle' as const,
    eventId: envelope.eventId,
    occurredAtSeconds: envelope.occurredAtSeconds,
  };
  if (envelope.eventType.startsWith('transaction.')) {
    const kind =
      envelope.eventType === 'transaction.completed' || envelope.eventType === 'transaction.paid'
        ? 'paid'
        : envelope.eventType === 'transaction.canceled'
          ? 'cancelled'
          : null;
    if (!kind) return null;
    if (typeof data.id !== 'string' || !TXN.test(data.id) || typeof data.currency_code !== 'string')
      throw new MalformedWebhook();
    const totals = totalsOf(data);
    if (!totals) throw new MalformedWebhook();
    const custom = object(data.custom_data);
    return {
      ...base,
      kind,
      transactionId: data.id,
      orderRef: isOrderRef(custom?.ensemus_order) ? (custom.ensemus_order as string) : null,
      currency: data.currency_code,
      grandTotalMinor: totals.grand,
      taxMinor: totals.tax,
      subtotalMinor: totals.subtotal,
    };
  }
  if (envelope.eventType === 'adjustment.created' || envelope.eventType === 'adjustment.updated') {
    if (data.status !== 'approved') return null;
    const kind =
      data.action === 'refund' ? 'refunded' : data.action === 'chargeback' ? 'disputed' : null;
    if (!kind || !(PADDLE_FACT_KINDS as readonly string[]).includes(kind)) return null;
    const totals = object(data.totals);
    if (
      typeof data.transaction_id !== 'string' ||
      !TXN.test(data.transaction_id) ||
      typeof data.currency_code !== 'string' ||
      parseMinor(totals?.total) === null ||
      parseMinor(totals?.tax) === null ||
      parseMinor(totals?.subtotal) === null
    )
      throw new MalformedWebhook();
    return {
      ...base,
      kind,
      transactionId: data.transaction_id,
      orderRef: null,
      currency: data.currency_code,
      grandTotalMinor: totals!.total as string,
      taxMinor: totals!.tax as string,
      subtotalMinor: totals!.subtotal as string,
    };
  }
  return null;
}

// --- The Paddle API, over the egress gateway. Every call is one bounded request with the key lent for it.

export type PaddleHttp = (request: {
  method: 'GET' | 'POST';
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: Buffer;
}) => Promise<{ status: number; body: Uint8Array }>;

export class PaddleRefused extends Error {
  override name = 'PaddleRefused';
  constructor(
    readonly code:
      | 'PADDLE_NOT_CONFIGURED'
      | 'PADDLE_REJECTED'
      | 'PADDLE_UNAVAILABLE'
      | 'PADDLE_RESPONSE_INVALID'
      | 'PADDLE_AMOUNT_INVALID',
  ) {
    super(code);
  }
}

export type PaddleClient = ReturnType<typeof createPaddleClient>;

/**
 * Paddle's API for checkout and tax. `apiKey` is lent per request and never kept. A thrown error carries a
 * code and never Paddle's text.
 */
export function createPaddleClient(deps: {
  environment: PaddleEnvironment;
  http: PaddleHttp;
  withApiKey<T>(use: (key: Buffer) => Promise<T>): Promise<T>;
  /** The Paddle tax category for what Ensemus sells. The owner's decision; there is no default. */
  taxCategory: string;
}) {
  if (!/^[a-z][a-z-]{1,62}$/.test(deps.taxCategory))
    throw new PaddleRefused('PADDLE_NOT_CONFIGURED');
  const call = (method: 'GET' | 'POST', path: string, payload?: unknown) =>
    deps.withApiKey(async (key) => {
      const text = key.toString('utf8');
      if (!text.startsWith(KEY_PREFIX[deps.environment]) || /\s/.test(text))
        throw new PaddleRefused('PADDLE_NOT_CONFIGURED');
      let response: { status: number; body: Uint8Array };
      try {
        response = await deps.http({
          method,
          path,
          headers: {
            authorization: `Bearer ${text}`,
            accept: 'application/json',
            'paddle-version': '1',
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(payload === undefined ? {} : { body: Buffer.from(JSON.stringify(payload)) }),
        });
      } catch {
        throw new PaddleRefused('PADDLE_UNAVAILABLE');
      }
      if (response.status >= 500 || response.status === 429)
        throw new PaddleRefused('PADDLE_UNAVAILABLE');
      if (response.status < 200 || response.status >= 300)
        throw new PaddleRefused('PADDLE_REJECTED');
      try {
        const parsed = object(JSON.parse(Buffer.from(response.body).toString('utf8')));
        if (!parsed || !('data' in parsed)) throw new Error('shape');
        return parsed.data;
      } catch {
        throw new PaddleRefused('PADDLE_RESPONSE_INVALID');
      }
    });
  const exponentOf = (currency: string) => {
    const exponent = CHECKOUT_CURRENCIES.paddle[currency];
    if (exponent === undefined) throw new PaddleRefused('PADDLE_AMOUNT_INVALID');
    return exponent;
  };
  const item = (amountMinor: bigint, currency: string, description: string) => {
    if (amountMinor <= 0n || !/^[A-Z]{3}$/.test(currency))
      throw new PaddleRefused('PADDLE_AMOUNT_INVALID');
    exponentOf(currency);
    return {
      quantity: 1,
      price: {
        description,
        name: description,
        // Our amount excludes tax: Paddle, as merchant of record, adds what it computes.
        tax_mode: 'external',
        unit_price: { amount: amountMinor.toString(), currency_code: currency },
        product: { name: 'Ensemus', tax_category: deps.taxCategory, description },
      },
    };
  };
  const readTotals = (data: unknown) => {
    const totals = totalsOf(object(data) ?? {});
    if (!totals) throw new PaddleRefused('PADDLE_RESPONSE_INVALID');
    return totals;
  };
  return {
    environment: deps.environment,
    /** Finds the customer by email, or creates one. Paddle keeps one customer per email address. */
    async customerFor(input: { email: string; name: string }): Promise<string> {
      const found = await call(
        'GET',
        `/customers?email=${encodeURIComponent(input.email)}&per_page=1`,
      );
      const first = Array.isArray(found) ? object(found[0]) : null;
      if (first && typeof first.id === 'string' && /^ctm_[a-z0-9]{1,64}$/.test(first.id))
        return first.id;
      const created = object(
        await call('POST', '/customers', { email: input.email, name: input.name }),
      );
      if (typeof created?.id !== 'string' || !/^ctm_[a-z0-9]{1,64}$/.test(created.id))
        throw new PaddleRefused('PADDLE_RESPONSE_INVALID');
      return created.id;
    },
    async addressFor(
      customerId: string,
      input: { countryCode: string; postalCode: string | null; region: string },
    ) {
      if (!/^ctm_[a-z0-9]{1,64}$/.test(customerId) || !/^[A-Z]{2}$/.test(input.countryCode))
        throw new PaddleRefused('PADDLE_RESPONSE_INVALID');
      const created = object(
        await call('POST', `/customers/${customerId}/addresses`, {
          country_code: input.countryCode,
          ...(input.postalCode ? { postal_code: input.postalCode } : {}),
          ...(input.region ? { region: input.region } : {}),
        }),
      );
      if (typeof created?.id !== 'string' || !/^add_[a-z0-9]{1,64}$/.test(created.id))
        throw new PaddleRefused('PADDLE_RESPONSE_INVALID');
      return created.id;
    },
    /** One transaction for one checkout, ready to pay, with its link. */
    async createTransaction(input: {
      customerId: string;
      addressId: string;
      currency: string;
      amountMinor: bigint;
      description: string;
      orderRef: string;
    }): Promise<{ transactionId: string; checkoutUrl: string }> {
      if (!isOrderRef(input.orderRef)) throw new PaddleRefused('PADDLE_AMOUNT_INVALID');
      const data = object(
        await call('POST', '/transactions', {
          customer_id: input.customerId,
          address_id: input.addressId,
          currency_code: input.currency,
          collection_mode: 'automatic',
          items: [item(input.amountMinor, input.currency, input.description)],
          custom_data: { ensemus_order: input.orderRef },
        }),
      );
      const url =
        typeof object(data?.checkout)?.url === 'string'
          ? (object(data?.checkout)!.url as string)
          : null;
      if (typeof data?.id !== 'string' || !TXN.test(data.id) || !url)
        throw new PaddleRefused('PADDLE_RESPONSE_INVALID');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new PaddleRefused('PADDLE_RESPONSE_INVALID');
      }
      // The link is the operator's own default payment link with `_ptxn` added by Paddle. Nothing else is
      // sent to a customer's browser.
      if (
        parsed.protocol !== 'https:' ||
        parsed.searchParams.get('_ptxn') !== data.id ||
        parsed.username
      )
        throw new PaddleRefused('PADDLE_RESPONSE_INVALID');
      return { transactionId: data.id, checkoutUrl: parsed.toString() };
    },
    /** The authoritative reconcile: what Paddle says this one transaction is now. */
    async transaction(transactionId: string): Promise<PaddleLookup> {
      if (!TXN.test(transactionId)) throw new PaddleRefused('PADDLE_RESPONSE_INVALID');
      const data = object(await call('GET', `/transactions/${transactionId}`));
      if (!data || data.id !== transactionId || typeof data.status !== 'string')
        throw new PaddleRefused('PADDLE_RESPONSE_INVALID');
      if (data.status === 'completed' || data.status === 'paid') {
        if (typeof data.currency_code !== 'string')
          throw new PaddleRefused('PADDLE_RESPONSE_INVALID');
        const totals = readTotals(data);
        return {
          status: 'paid',
          transactionId,
          currency: data.currency_code,
          grandTotalMinor: totals.grand,
          taxMinor: totals.tax,
        };
      }
      if (data.status === 'canceled') return { status: 'cancelled', transactionId };
      return { status: 'open', transactionId };
    },
    /** Paddle's tax for an amount and a place, without creating anything. */
    async previewTax(input: {
      currency: string;
      amountMinor: bigint;
      countryCode: string;
      postalCode: string | null;
    }): Promise<{ taxMinor: bigint; grandTotalMinor: bigint }> {
      const data = await call('POST', '/transactions/preview', {
        currency_code: input.currency,
        address: {
          country_code: input.countryCode,
          ...(input.postalCode ? { postal_code: input.postalCode } : {}),
        },
        items: [item(input.amountMinor, input.currency, 'Ensemus')],
      });
      const totals = readTotals(data);
      return { taxMinor: BigInt(totals.tax), grandTotalMinor: BigInt(totals.grand) };
    },
  };
}

/**
 * Tax for invoices whose place the operator set to `provider_computed`, from Paddle as merchant of record.
 * It answers only for Paddle's currencies, so an invoice in so'm is never given a Paddle figure: it keeps
 * whatever treatment the operator approved for its place, and with `provider_computed` stays a draft.
 */
export function createPaddleTaxPort(client: PaddleClient): TaxPort {
  return {
    provider: 'paddle',
    async compute(input: TaxInput, signal: AbortSignal): Promise<TaxResult> {
      if (signal.aborted) throw new TaxRefused('TAX_PROVIDER_UNAVAILABLE');
      const exponent = CHECKOUT_CURRENCIES.paddle[input.currency];
      if (exponent === undefined) throw new TaxRefused('TAX_PROVIDER_NOT_CONFIGURED');
      const unit = 1_000_000n / 10n ** BigInt(exponent);
      const subtotal = input.lines.reduce((sum, line) => sum + line.amountMicros, 0n);
      if (subtotal <= 0n || subtotal % unit !== 0n) throw new TaxRefused('TAX_ADDRESS_REJECTED');
      let preview;
      try {
        preview = await client.previewTax({
          currency: input.currency,
          amountMinor: subtotal / unit,
          countryCode: input.countryCode,
          postalCode: input.postalCode,
        });
      } catch (error) {
        throw new TaxRefused(
          error instanceof PaddleRefused && error.code === 'PADDLE_REJECTED'
            ? 'TAX_ADDRESS_REJECTED'
            : 'TAX_PROVIDER_UNAVAILABLE',
        );
      }
      if (preview.taxMinor < 0n || preview.grandTotalMinor !== subtotal / unit + preview.taxMinor)
        throw new TaxRefused('TAX_PROVIDER_UNAVAILABLE');
      return {
        taxMicros: preview.taxMinor * unit,
        currency: input.currency,
        providerRef: `paddle:preview:${createHash('sha256')
          .update(
            JSON.stringify([input.idempotencyKey, input.currency, preview.taxMinor.toString()]),
          )
          .digest('hex')
          .slice(0, 32)}`,
      };
    },
  };
}

/** The port's view of Paddle. One-off invoices are paid at Paddle's checkout; `charge` never makes contact. */
export function createPaddleProcessor(): PaymentProcessor {
  return {
    manifest: {
      processor: 'paddle',
      version: '1.0.0',
      // GET /transactions/{id} is the transaction itself, so not finding it, or finding it open, is final.
      lookup: 'authoritative',
      // One checkout row creates at most one transaction, keyed by our order reference in custom_data.
      nativeIdempotency: true,
      webhookScheme: 'paddle_signature_v1',
    },
    async createCustomer() {
      // Customers are created when a checkout opens, through the checkout client, not the charge path.
      throw new Error('PAYMENT_CUSTOMER_UNSUPPORTED');
    },
    async charge() {
      // Paddle charges a saved card only for its own subscriptions. Ensemus bills by invoice, so the
      // customer pays each one at checkout, and the merchant-initiated path is refused without contact.
      return { outcome: 'not_sent', code: 'NO_PAYMENT_METHOD', retryable: false };
    },
    async lookup() {
      return { found: 'cannot_answer' };
    },
    interpretWebhook(_eventId, body) {
      interpretPaddleNotification(body);
      return null;
    },
  };
}
