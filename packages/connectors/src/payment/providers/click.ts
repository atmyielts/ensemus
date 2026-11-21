// Click SHOP API and Merchant API (ADR-032 D4a). Click calls us twice per payment, Prepare (action 0) and
// Complete (action 1), form-encoded, each signed with
// md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id [+ merchant_prepare_id] + amount + action
// + sign_time), the prepare id only on Complete. Amounts are so'm with up to two decimals. We can ask Click
// about one payment through the Merchant API, with `Auth: merchant_user_id:sha1(timestamp + key):timestamp`.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ClickCall } from '@ensemus/domain/checkout';
import type { PaymentProcessor } from '@ensemus/saas/payment';
export { CLICK_PAY_ORIGIN, clickCheckoutUrl } from '@ensemus/saas/checkout';
import { MalformedWebhook, type WebhookVerification } from '../../index';

/** The Merchant API's host, fixed in code as the TLS name its egress route may reach. */
export const CLICK_API_TLS_NAME = 'api.click.uz';

const FIELDS = [
  'click_trans_id',
  'service_id',
  'click_paydoc_id',
  'merchant_trans_id',
  'amount',
  'action',
  'error',
  'sign_time',
  'sign_string',
] as const;
const DIGITS = /^[0-9]{1,20}$/;
const SIGNED_INT = /^-?[0-9]{1,9}$/;

type ClickForm = Record<(typeof FIELDS)[number], string> & { merchant_prepare_id: string | null };

function readForm(body: Uint8Array): ClickForm | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  }
  const form: Partial<ClickForm> = {};
  for (const name of FIELDS) {
    const values = params.getAll(name);
    if (values.length !== 1 || values[0]!.length > 256) return null;
    form[name] = values[0]!;
  }
  const prepare = params.getAll('merchant_prepare_id');
  if (prepare.length > 1) return null;
  form.merchant_prepare_id = prepare[0] ?? null;
  const f = form as ClickForm;
  if (
    !DIGITS.test(f.click_trans_id) ||
    !DIGITS.test(f.service_id) ||
    !DIGITS.test(f.click_paydoc_id) ||
    !SIGNED_INT.test(f.action) ||
    !SIGNED_INT.test(f.error) ||
    !/^[0-9a-f]{32}$/i.test(f.sign_string) ||
    f.merchant_trans_id.length < 1 ||
    (f.merchant_prepare_id !== null && !DIGITS.test(f.merchant_prepare_id))
  )
    return null;
  return f;
}

/** The exact concatenation Click signs, from the exact text it sent. */
function clickSignedText(form: ClickForm, secretKey: Buffer): Buffer {
  const head = Buffer.from(`${form.click_trans_id}${form.service_id}`);
  const tail = Buffer.from(
    `${form.merchant_trans_id}${form.action === '1' ? (form.merchant_prepare_id ?? '') : ''}${form.amount}${form.action}${form.sign_time}`,
  );
  return Buffer.concat([head, secretKey, tail]);
}

export function signClickRequest(
  fields: Omit<ClickForm, 'sign_string'>,
  secretKey: Buffer,
): string {
  return createHash('md5')
    .update(clickSignedText({ ...fields, sign_string: '' }, secretKey))
    .digest('hex');
}

export function verifyClickRequest(
  secretKey: Buffer,
  input: { body: Uint8Array; nowMs: number },
): WebhookVerification {
  const form = readForm(input.body);
  if (!form) return { ok: false, code: 'SIGNATURE_MISSING' };
  if (!secretKey.length) return { ok: false, code: 'BAD_SIGNATURE' };
  const expected = createHash('md5').update(clickSignedText(form, secretKey)).digest();
  if (!timingSafeEqual(expected, Buffer.from(form.sign_string.toLowerCase(), 'hex')))
    return { ok: false, code: 'BAD_SIGNATURE' };
  return {
    ok: true,
    providerEventId: `click:${form.action === '1' ? 'complete' : 'prepare'}:${createHash('sha256')
      .update(input.body)
      .digest('hex')
      .slice(0, 48)}`,
    signedAtSeconds: Math.floor(input.nowMs / 1000),
  };
}

/** Reads a call whose signature has passed. A call for another service is refused as malformed. */
export function parseClickCall(body: Uint8Array, expectedServiceId: string): ClickCall {
  const form = readForm(body);
  if (!form || form.service_id !== expectedServiceId) throw new MalformedWebhook();
  return {
    provider: 'click',
    action: Number(form.action),
    clickTransId: form.click_trans_id,
    clickPaydocId: form.click_paydoc_id,
    serviceId: form.service_id,
    // Sent back as Click sent it. Anything that is not one of our references matches no row, and Click
    // hears "not found".
    orderRef: form.merchant_trans_id,
    merchantPrepareId: form.merchant_prepare_id,
    amount: form.amount,
    error: Number(form.error),
  };
}

/** The Merchant API's `Auth` header for one request. */
export function clickMerchantAuth(merchantUserId: string, secretKey: Buffer, nowSeconds: number) {
  if (!DIGITS.test(merchantUserId) || !Number.isSafeInteger(nowSeconds) || nowSeconds < 1)
    throw new Error('CLICK_AUTH_INVALID');
  const timestamp = String(nowSeconds);
  const digest = createHash('sha1')
    .update(Buffer.concat([Buffer.from(timestamp), secretKey]))
    .digest('hex');
  return `${merchantUserId}:${digest}:${timestamp}`;
}

export type ClickPaymentStatus = 'paid' | 'failed' | 'pending' | 'cannot_answer';

/**
 * Reads `GET /v2/merchant/payment/status/{service_id}/{payment_id}`. Click's documentation does not define
 * every `payment_status` value, so only the reading the owner confirmed in Click's sandbox should be
 * believed: this answers `paid` for 2, `failed` for a negative status, `pending` for 0 or 1, and
 * `cannot_answer` for anything else. It is a best-effort lookup and never settles money by itself.
 */
export function readClickPaymentStatus(
  status: number,
  body: Uint8Array,
  paymentId: string,
): ClickPaymentStatus {
  if (status !== 200) return 'cannot_answer';
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    return 'cannot_answer';
  }
  if (!parsed || typeof parsed !== 'object') return 'cannot_answer';
  const value = parsed as Record<string, unknown>;
  if (value.error_code !== 0 || String(value.payment_id) !== paymentId) return 'cannot_answer';
  const s = value.payment_status;
  if (typeof s !== 'number' || !Number.isInteger(s)) return 'cannot_answer';
  if (s === 2) return 'paid';
  if (s < 0) return 'failed';
  if (s === 0 || s === 1) return 'pending';
  return 'cannot_answer';
}

export const clickPaymentStatusPath = (serviceId: string, paymentId: string) => {
  if (!DIGITS.test(serviceId) || !DIGITS.test(paymentId)) throw new Error('CLICK_LOOKUP_INVALID');
  return `/v2/merchant/payment/status/${serviceId}/${paymentId}`;
};

/** The port's view of Click: customer-initiated only, like Payme. `charge` never makes contact. */
export function createClickProcessor(): PaymentProcessor {
  return {
    manifest: {
      processor: 'click',
      version: '1.0.0',
      // The Merchant API can find a payment, but its statuses are not fully documented, so not finding one
      // proves nothing and finding one is shown to a person rather than believed.
      lookup: 'best_effort',
      // One order is payable once: Prepare holds it for one click_trans_id.
      nativeIdempotency: true,
      webhookScheme: 'click_md5_v1',
    },
    async createCustomer() {
      throw new Error('PAYMENT_CUSTOMER_UNSUPPORTED');
    },
    async charge() {
      return { outcome: 'not_sent', code: 'NO_PAYMENT_METHOD', retryable: false };
    },
    async lookup() {
      // Our idempotency key is not a Click payment id; the checkout row holds that and asks on its own.
      return { found: 'cannot_answer' };
    },
    interpretWebhook(_eventId, body) {
      if (!readForm(body)) throw new MalformedWebhook();
      return null;
    },
  };
}
