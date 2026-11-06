// Owned by the webhooks slice. See docs/06-delivery/m3-slices.md.
import type { WebhookVerification, WebhookVerifyInput } from '../index';

/**
 * Checks a stored delivery against a secret lent for this call, in constant time, and then its signed
 * time against the window. For `ensemus_hmac_sha256_v1` the signed bytes are
 * `{timestamp}.{event id}.{body}`, so neither the time nor the ID can be changed separately.
 */
export function verifyWebhookSignature(
  _secret: Buffer,
  _input: WebhookVerifyInput,
): WebhookVerification {
  throw new Error('NOT_IMPLEMENTED');
}

/** What a sender does. Exported so tests and the operator docs have one definition of the bytes. */
export function signWebhook(
  _secret: Buffer,
  _input: { timestampSeconds: number; eventId: string; body: Uint8Array },
): string {
  throw new Error('NOT_IMPLEMENTED');
}
