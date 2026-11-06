// The webhook signature scheme (ADR-027 D4). It runs in the connector worker only, because checking a
// signature takes the secret and the web tier can never open one.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isWebhookEventId, withinTimestampWindow } from '@ensemus/domain/webhook';
import type { WebhookVerification, WebhookVerifyInput } from '../index';

const SIGNATURE = /^[0-9a-f]{64}$/;
// Whole seconds and nothing else. The signed bytes hold the text as sent, so `+1` or `1e9` could never
// be the same bytes a sender signed, and this says so rather than calling them a bad signature.
const TIMESTAMP = /^[0-9]{1,15}$/;

const mac = (secret: Buffer, timestamp: string, eventId: string, body: Uint8Array) =>
  createHmac('sha256', secret).update(`${timestamp}.${eventId}.`).update(body).digest();

/**
 * Checks a stored delivery against a secret lent for this call, in constant time, and then its signed
 * time against the window. For `ensemus_hmac_sha256_v1` the signed bytes are
 * `{timestamp}.{event id}.{body}`, so neither the time nor the ID can be changed separately. The time is
 * looked at only after the signature passes, so a stranger learns nothing about the window from it.
 */
export function verifyWebhookSignature(
  secret: Buffer,
  input: WebhookVerifyInput,
): WebhookVerification {
  if (input.scheme !== 'ensemus_hmac_sha256_v1') return { ok: false, code: 'BAD_SIGNATURE' };
  const signature = input.headers['x-ensemus-signature'];
  if (!signature) return { ok: false, code: 'SIGNATURE_MISSING' };
  const timestamp = input.headers['x-ensemus-timestamp'];
  if (!timestamp || !TIMESTAMP.test(timestamp)) return { ok: false, code: 'TIMESTAMP_MISSING' };
  const eventId = input.headers['x-ensemus-event-id'];
  if (!eventId || !isWebhookEventId(eventId)) return { ok: false, code: 'BAD_SIGNATURE' };
  if (!SIGNATURE.test(signature)) return { ok: false, code: 'BAD_SIGNATURE' };

  const expected = mac(secret, timestamp, eventId, input.body);
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
    return { ok: false, code: 'BAD_SIGNATURE' };
  }
  const signedAtSeconds = Number(timestamp);
  if (!withinTimestampWindow(signedAtSeconds, input.nowMs, input.toleranceSeconds)) {
    return { ok: false, code: 'TIMESTAMP_OUTSIDE_WINDOW' };
  }
  return { ok: true, providerEventId: eventId, signedAtSeconds };
}

/** What a sender does. Exported so tests and the operator docs have one definition of the bytes. */
export function signWebhook(
  secret: Buffer,
  input: { timestampSeconds: number; eventId: string; body: Uint8Array },
): string {
  // Refused here too, so nobody builds a sender whose every request would be turned away.
  if (!isWebhookEventId(input.eventId)) throw new Error('Invalid webhook event ID');
  return mac(secret, String(input.timestampSeconds), input.eventId, input.body).toString('hex');
}
