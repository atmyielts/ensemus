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

/**
 * What a verified delivery may ask for. Both are requests, not effects: `action_proposed` becomes an
 * intent that still needs a person's approval, and `sync_requested` only reads.
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
  | { kind: 'sync_requested' };

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
