// Webhook rules (ADR-027 D4). Pure, and shared by the web tier, which stores what arrived and believes
// none of it, and the worker, which verifies it later.
import { createHash } from 'node:crypto';

/** Hard ceiling for any endpoint, whatever its row says, and the size the web tier reads up to. */
export const WEBHOOK_MAX_BODY_BYTES = 1_048_576;
export const WEBHOOK_MAX_HEADER_BYTES = 1024;
export const WEBHOOK_TOKEN_BYTES = 32;
/** A body nobody has verified by then is dropped, and what is left of the row goes a week later. */
export const WEBHOOK_UNPROCESSED_RETENTION_HOURS = 24;
export const WEBHOOK_METADATA_RETENTION_DAYS = 7;

/** Before any database use, per web replica. Deliberately in memory: it protects the database. */
export const WEBHOOK_UNKNOWN_CALLER_LIMIT_PER_MINUTE = 300;
export const WEBHOOK_REPLICA_LIMIT_PER_MINUTE = 3000;

/** Replied at once, so a provider's own retry and an unauthenticated caller learn the same. */
export const WEBHOOK_INGRESS_OUTCOMES = [
  'accepted',
  'not_found',
  'too_large',
  'rate_limited',
] as const;
export type WebhookIngressOutcome = (typeof WEBHOOK_INGRESS_OUTCOMES)[number];

export const WEBHOOK_DELIVERY_STATES = [
  'received',
  'applied',
  'duplicate',
  'rejected',
  'failed',
] as const;
export type WebhookDeliveryState = (typeof WEBHOOK_DELIVERY_STATES)[number];

export const WEBHOOK_REJECT_CODES = [
  'BAD_SIGNATURE',
  'SIGNATURE_MISSING',
  'TIMESTAMP_OUTSIDE_WINDOW',
  'TIMESTAMP_MISSING',
  'MALFORMED_PAYLOAD',
  'ENDPOINT_NOT_ACTIVE',
  'SECRET_UNAVAILABLE',
  'NOT_PROCESSED_IN_TIME',
] as const;
export type WebhookRejectCode = (typeof WEBHOOK_REJECT_CODES)[number];

export const SIGNATURE_SCHEMES = ['ensemus_hmac_sha256_v1'] as const;
export type SignatureScheme = (typeof SIGNATURE_SCHEMES)[number];

/** The only request headers ever stored, and each is cut off at WEBHOOK_MAX_HEADER_BYTES. */
export const WEBHOOK_STORED_HEADERS: Readonly<Record<SignatureScheme, readonly string[]>> = {
  ensemus_hmac_sha256_v1: [
    'content-type',
    'x-ensemus-signature',
    'x-ensemus-timestamp',
    'x-ensemus-event-id',
  ],
};

/** The set of stored headers as JSON. Below the column's 8 KiB, which also counts jsonb's spacing. */
export const WEBHOOK_MAX_STORED_HEADERS_BYTES = 8000;

// Control characters go first: a NUL makes jsonb refuse the row, and a stranger must not be able to turn
// a request into a 500. Nothing the scheme signs ever holds one, so its signature simply fails later.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** Cuts text to a number of bytes, without leaving half a character at the end. */
function cutToBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  // A UTF-8 continuation byte is 10xxxxxx. Going back past them finds where the last character starts.
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString();
}

/**
 * What is kept of a request's headers: the scheme's allowlist, cleaned and cut, and no more than fits.
 * Anything left out only means the signature fails later, so none of this has to reject.
 */
export function storedWebhookHeaders(
  scheme: string,
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const allowed = (WEBHOOK_STORED_HEADERS as Readonly<Record<string, readonly string[]>>)[scheme];
  const kept: Record<string, string> = {};
  for (const name of allowed ?? []) {
    const value = headers[name];
    if (value === undefined) continue;
    const clean = cutToBytes(value.replace(CONTROL_CHARACTERS, ''), WEBHOOK_MAX_HEADER_BYTES);
    const next = { ...kept, [name]: clean };
    if (Buffer.byteLength(JSON.stringify(next)) > WEBHOOK_MAX_STORED_HEADERS_BYTES) break;
    kept[name] = clean;
  }
  return kept;
}

const WEBHOOK_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes in base64url. Anything else was never issued, and is not worth a query. */
export const isWebhookTokenShape = (token: string) => WEBHOOK_TOKEN_SHAPE.test(token);

const WEBHOOK_EVENT_ID = /^[A-Za-z0-9_:-]{1,255}$/;

/**
 * A sender's event ID. It sits between dots in the signed bytes, so it may not hold one: if it could,
 * moving text from the start of the body into the ID would sign the same bytes, and anyone holding one
 * valid request could mint a new event ID from it.
 */
export const isWebhookEventId = (eventId: string) => WEBHOOK_EVENT_ID.test(eventId);

export const hashWebhookToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** The consumer ID in platform.inbox_events for one endpoint. */
export const webhookInboxConsumer = (endpointId: string) => `webhook:${endpointId}`;

/**
 * The inbox's event ID, since it holds a UUID and a provider's ID is any text. Derived from the endpoint
 * and the verified ID, so one sender cannot use up another's. Only ever written after the signature has
 * passed, so nobody can get in first with an ID they guessed.
 */
export function webhookInboxEventId(endpointId: string, providerEventId: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([endpointId, providerEventId]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const PAYMENT_EVENT_KINDS = [
  'payment_succeeded',
  'payment_failed',
  'payment_refunded',
  'payment_disputed',
  'customer_updated',
] as const;
export type PaymentEventKind = (typeof PAYMENT_EVENT_KINDS)[number];

/**
 * What a processor's verified webhook says, in IDs, enums and amounts (ADR-032 D4). The customer reference
 * goes only as a hash, and the tenant is found from that against our own row, never from this.
 */
export type PaymentEventFact = {
  processor: string;
  providerEventId: string;
  kind: PaymentEventKind;
  customerRefHash: string;
  processorPaymentRef: string | null;
  /** Our payment ID, when the processor echoes back what we sent. A row confirms it. Never trusted alone. */
  paymentId: string | null;
  /** Micros as a string of digits. */
  amountMicros: string | null;
  currency: string | null;
  occurredAtSeconds: number;
};

/**
 * What a verified delivery may ask for. None are effects by themselves: `action_proposed` becomes an
 * intent that still needs a person's approval, `sync_requested` only reads, and `payment_event` is routed
 * to its tenant later and checked against what that tenant's rows say.
 */
export type WebhookEffect =
  | {
      kind: 'action_proposed';
      workUnitId: string;
      connectionId: string;
      toolName: string;
      toolVersion: string;
      payload: unknown;
    }
  | { kind: 'sync_requested' }
  | {
      kind: 'payment_event';
      event: PaymentEventFact;
      /** Native parser observation from the already signature-verified body. Never routing authority by itself. */
      executionIdentitySha256?: string;
      accountNamespaceSha256?: string;
    };

/** The digest of one exact request. A repeat of the same bytes is stored once. */
export function webhookRequestDigest(
  body: Uint8Array,
  storedHeaders: Readonly<Record<string, string>>,
): string {
  const sorted = Object.entries(storedHeaders).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(sorted)).update(body).digest('hex');
}

/** Whether a signed time is close enough to now. An old signature is no use, however valid. */
export function withinTimestampWindow(
  signedAtSeconds: number,
  nowMs: number,
  toleranceSeconds: number,
): boolean {
  if (!Number.isSafeInteger(signedAtSeconds)) return false;
  return Math.abs(nowMs / 1000 - signedAtSeconds) <= toleranceSeconds;
}
