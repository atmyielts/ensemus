// The signed wrapper around every document Ensemus issues (ADR-030 D1). This is the DSSE envelope, a
// published format, with Ed25519 from Node's own crypto, so nothing here is a cipher or a signature scheme
// of our own. The signature covers the payload's exact bytes plus its type, so there is no canonical JSON
// to get wrong, and a maintenance statement can never be passed off as a license.
import { verify as verifySignature } from 'node:crypto';
import { z } from 'zod';
import type { DocumentPurpose, TrustedKey, TrustRoot } from './trust-root';

export const PAYLOAD_TYPES = {
  license: 'application/vnd.ensemus.license+json',
  maintenance: 'application/vnd.ensemus.maintenance+json',
  advisory: 'application/vnd.ensemus.advisory+json',
  support_policy: 'application/vnd.ensemus.support-policy+json',
  bundle: 'application/vnd.ensemus.bundle+json',
  diagnostic_recipient: 'application/vnd.ensemus.diagnostic-recipient+json',
} as const satisfies Record<DocumentPurpose, string>;

/** Bigger than any document that is not a bundle manifest. A bundle lists its files, so it gets more. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;
export const MAX_BUNDLE_ENVELOPE_BYTES = 16 * 1024 * 1024;

const envelopeSchema = z.strictObject({
  payloadType: z.string().min(1).max(200),
  payload: z.base64().min(1),
  signatures: z
    .array(z.strictObject({ keyid: z.string().min(1).max(64), sig: z.base64().min(1).max(256) }))
    .min(1)
    .max(16),
});
export type SignedEnvelope = z.infer<typeof envelopeSchema>;

/** The bytes actually signed: DSSE's pre-authentication encoding. */
export function preAuthEncoding(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `),
    payload,
  ]);
}

export type EnvelopeRefusal =
  | 'TOO_LARGE'
  | 'MALFORMED'
  | 'WRONG_TYPE'
  | 'UNKNOWN_KEY'
  | 'WRONG_PURPOSE'
  | 'BAD_SIGNATURE'
  | 'NOT_ENOUGH_SIGNATURES';

export type EnvelopeVerdict =
  | { ok: true; payload: Buffer; keys: readonly TrustedKey[] }
  | { ok: false; code: EnvelopeRefusal };

/**
 * Checks the signatures and nothing about the content. A signature from a key that is not in the trust
 * root, or that may not sign this kind of document, does not count, and any signature that fails refuses
 * the whole document rather than being skipped, so a damaged file is never quietly half-believed.
 */
export function verifyEnvelope(
  text: string,
  root: TrustRoot,
  purpose: DocumentPurpose,
): EnvelopeVerdict {
  const limit = purpose === 'bundle' ? MAX_BUNDLE_ENVELOPE_BYTES : MAX_ENVELOPE_BYTES;
  if (Buffer.byteLength(text) > limit) return { ok: false, code: 'TOO_LARGE' };

  let envelope: SignedEnvelope;
  try {
    envelope = envelopeSchema.parse(JSON.parse(text));
  } catch {
    return { ok: false, code: 'MALFORMED' };
  }
  if (envelope.payloadType !== PAYLOAD_TYPES[purpose]) return { ok: false, code: 'WRONG_TYPE' };

  const payload = Buffer.from(envelope.payload, 'base64');
  const signed = preAuthEncoding(envelope.payloadType, payload);
  const counted = new Map<string, TrustedKey>();
  let sawKnownKey = false;
  let sawWrongPurpose = false;
  for (const { keyid, sig } of envelope.signatures) {
    const key = root.keys.find((candidate) => candidate.key_id === keyid);
    if (!key) continue;
    sawKnownKey = true;
    if (!key.purposes.includes(purpose)) {
      sawWrongPurpose = true;
      continue;
    }
    if (!verifySignature(null, signed, key.publicKey, Buffer.from(sig, 'base64'))) {
      return { ok: false, code: 'BAD_SIGNATURE' };
    }
    counted.set(key.key_id, key);
  }
  if (!sawKnownKey) return { ok: false, code: 'UNKNOWN_KEY' };
  if (counted.size === 0 && sawWrongPurpose) return { ok: false, code: 'WRONG_PURPOSE' };
  if (counted.size < root.thresholds[purpose]) return { ok: false, code: 'NOT_ENOUGH_SIGNATURES' };
  return { ok: true, payload, keys: [...counted.values()] };
}
