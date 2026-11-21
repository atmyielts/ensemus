// Payme Merchant API (ADR-032 D4a). Payme calls us: CheckPerformTransaction, CreateTransaction,
// PerformTransaction, CancelTransaction, CheckTransaction and GetStatement, as JSON-RPC 2.0 over HTTPS with
// HTTP Basic auth, login "Paycom" and the merchant key as password. Amounts are tiyin. We never call Payme,
// so our own rows are the record Payme reconciles against, through CheckTransaction and GetStatement.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isOrderRef, type JsonRpcId, type PaymeCall } from '@ensemus/domain/checkout';
import { PAYME_AUTHORIZATION_DIGEST_HEADER } from '@ensemus/domain/webhook';
import type { PaymentProcessor } from '@ensemus/saas/payment';
import { boundedRpcId, PAYME_ACCOUNT_FIELD } from '@ensemus/saas/checkout';
export {
  PAYME_CHECKOUT_ORIGINS,
  paymeCheckoutUrl,
  type CheckoutEnvironment,
} from '@ensemus/saas/checkout';
import { MalformedWebhook, type WebhookVerification } from '../../index';

export const PAYME_LOGIN = 'Paycom';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** The whole header Payme sends for this key, so it can be compared with the stored digest. */
export const paymeAuthorizationFor = (merchantKey: Buffer) =>
  `Basic ${Buffer.concat([Buffer.from(`${PAYME_LOGIN}:`), merchantKey]).toString('base64')}`;

/**
 * Compares the digest the web tier stored of `Authorization` with the digest of what this key would send,
 * in constant time. The key is high-entropy, so its digest is no use to anyone who reads the row.
 */
export function verifyPaymeRequest(
  merchantKey: Buffer,
  input: { body: Uint8Array; headers: Readonly<Record<string, string>>; nowMs: number },
): WebhookVerification {
  const stored = input.headers[PAYME_AUTHORIZATION_DIGEST_HEADER];
  if (!stored) return { ok: false, code: 'SIGNATURE_MISSING' };
  if (!/^[0-9a-f]{64}$/.test(stored) || !merchantKey.length)
    return { ok: false, code: 'BAD_SIGNATURE' };
  const expected = Buffer.from(sha256(paymeAuthorizationFor(merchantKey)), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(stored, 'hex')))
    return { ok: false, code: 'BAD_SIGNATURE' };
  return {
    ok: true,
    // Unique to these exact bytes: every distinct call is answered, and the same bytes again were already
    // folded into one delivery at the door.
    providerEventId: `payme:${sha256(input.body).slice(0, 48)}`,
    signedAtSeconds: Math.floor(input.nowMs / 1000),
  };
}

const TXN_ID = /^[A-Za-z0-9]{1,64}$/;
const wholeText = (value: unknown): string | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;

/** Reads one authenticated call. Anything that is not a well-formed call of ours is `invalid`. */
export function parsePaymeCall(body: Uint8Array): PaymeCall {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    return { provider: 'payme', rpcId: null, method: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { provider: 'payme', rpcId: null, method: 'invalid' };
  const request = parsed as Record<string, unknown>;
  const rpcId: JsonRpcId = boundedRpcId(request.id);
  const params = request.params;
  if (
    typeof request.method !== 'string' ||
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params)
  )
    return { provider: 'payme', rpcId, method: 'invalid' };
  const p = params as Record<string, unknown>;
  const invalid: PaymeCall = { provider: 'payme', rpcId, method: 'invalid' };
  const orderOf = (account: unknown): string | null => {
    if (!account || typeof account !== 'object' || Array.isArray(account)) return null;
    const value = (account as Record<string, unknown>)[PAYME_ACCOUNT_FIELD];
    return isOrderRef(value) ? value : null;
  };
  const txn = typeof p.id === 'string' && TXN_ID.test(p.id) ? p.id : null;
  switch (request.method) {
    case 'CheckPerformTransaction': {
      const amount = wholeText(p.amount);
      if (amount === null) return invalid;
      return {
        provider: 'payme',
        rpcId,
        method: request.method,
        amount,
        orderRef: orderOf(p.account),
      };
    }
    case 'CreateTransaction': {
      const amount = wholeText(p.amount);
      const timeMs = wholeText(p.time);
      if (amount === null || timeMs === null || !txn) return invalid;
      return {
        provider: 'payme',
        rpcId,
        method: request.method,
        paymeTxnId: txn,
        timeMs,
        amount,
        orderRef: orderOf(p.account),
      };
    }
    case 'PerformTransaction':
    case 'CheckTransaction':
      return txn ? { provider: 'payme', rpcId, method: request.method, paymeTxnId: txn } : invalid;
    case 'CancelTransaction':
      return txn && typeof p.reason === 'number' && Number.isSafeInteger(p.reason)
        ? { provider: 'payme', rpcId, method: request.method, paymeTxnId: txn, reason: p.reason }
        : invalid;
    case 'GetStatement': {
      const fromMs = wholeText(p.from);
      const toMs = wholeText(p.to);
      return fromMs !== null && toMs !== null && BigInt(fromMs) <= BigInt(toMs)
        ? { provider: 'payme', rpcId, method: request.method, fromMs, toMs }
        : invalid;
    }
    default:
      // ChangePassword and SetFiscalData included: the key is rotated by an operator, and fiscal data is
      // an owner decision this release does not make (see the runbook).
      return { provider: 'payme', rpcId, method: 'unsupported' };
  }
}

/**
 * The port's view of Payme. Payme takes no charge we start and has no customer to register: the customer
 * pays on Payme's page and Payme calls us. So `charge` says, on purpose and without contact, that nothing
 * was sent and nothing can be, and an earlier merchant-initiated path can never reach Payme.
 */
export function createPaymeProcessor(): PaymentProcessor {
  return {
    manifest: {
      processor: 'payme',
      version: '1.0.0',
      // Our rows are the record. Payme asks us, through CheckTransaction; we have nothing to ask Payme.
      lookup: 'none',
      // One order is payable once, because CreateTransaction holds it for one Payme transaction id.
      nativeIdempotency: true,
      webhookScheme: 'payme_basic_v1',
    },
    async createCustomer() {
      throw new Error('PAYMENT_CUSTOMER_UNSUPPORTED');
    },
    async charge() {
      return { outcome: 'not_sent', code: 'NO_PAYMENT_METHOD', retryable: false };
    },
    async lookup() {
      return { found: 'cannot_answer' };
    },
    interpretWebhook(_eventId, body) {
      // A Payme call is a checkout callback, not a payment event of the charge path. Anything that is not
      // even a JSON-RPC call is refused.
      if (parsePaymeCall(body).method === 'invalid') throw new MalformedWebhook();
      return null;
    },
  };
}
