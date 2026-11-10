// Which keys this deployment believes (ADR-030 D3). Configuration: a file an operator mounts, delivered
// out of band. Who holds the private keys, and how many must sign, is the owner's open decision, so both
// are data here. Nothing in this file has an expiry, because a perpetual license has to keep verifying on
// a machine nobody has touched in ten years.
import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const DOCUMENT_PURPOSES = [
  'license',
  'maintenance',
  'advisory',
  'support_policy',
  'bundle',
  'diagnostic_recipient',
] as const;
export type DocumentPurpose = (typeof DOCUMENT_PURPOSES)[number];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const trustedKeySchema = z.strictObject({
  key_id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
  algorithm: z.literal('ed25519'),
  /** The public key, SPKI DER, base64. */
  public_key: z.string().min(1).max(512),
  purposes: z.array(z.enum(DOCUMENT_PURPOSES)).min(1),
  /** Documents issued after this day are refused. Those issued before stay good for ever. */
  retired_on: day.nullable().default(null),
  /** The same rule, for a key that leaked, and said louder. */
  compromised_on: day.nullable().default(null),
  /** A generated key for tests and rehearsal. Every document it signs says so, on every page. */
  test_only: z.boolean().default(false),
});

const trustRootSchema = z
  .strictObject({
    format: z.literal('ensemus.trust_root'),
    format_version: z.literal(1),
    keys: z.array(trustedKeySchema).min(1).max(64),
    /** How many different keys must sign each kind of document. One until the owner decides otherwise. */
    thresholds: z
      .strictObject({
        license: z.int().min(1).max(8).default(1),
        maintenance: z.int().min(1).max(8).default(1),
        advisory: z.int().min(1).max(8).default(1),
        support_policy: z.int().min(1).max(8).default(1),
        bundle: z.int().min(1).max(8).default(1),
        diagnostic_recipient: z.int().min(1).max(8).default(1),
      })
      .prefault({}),
  })
  .refine((root) => new Set(root.keys.map((key) => key.key_id)).size === root.keys.length, {
    path: ['keys'],
  });

export type TrustedKey = z.infer<typeof trustedKeySchema> & { publicKey: KeyObject };
export type TrustRoot = {
  keys: readonly TrustedKey[];
  thresholds: Record<DocumentPurpose, number>;
};

export class TrustRootError extends Error {
  override name = 'TrustRootError';
  constructor() {
    // Fixed text, since the file is not ours and its contents should not reach a log.
    super('The license trust root could not be read');
  }
}

/** Reads a trust root from its JSON text. Throws one fixed error on anything else. */
export function parseTrustRoot(text: string): TrustRoot {
  try {
    const root = trustRootSchema.parse(JSON.parse(text));
    return {
      thresholds: root.thresholds,
      keys: root.keys.map((key) => {
        const publicKey = createPublicKey({
          key: Buffer.from(key.public_key, 'base64'),
          format: 'der',
          type: 'spki',
        });
        // Whatever the file says about itself, only the real key type counts.
        if (publicKey.asymmetricKeyType !== 'ed25519') throw new TrustRootError();
        return { ...key, publicKey };
      }),
    };
  } catch {
    throw new TrustRootError();
  }
}

export function loadTrustRootFile(path: string): TrustRoot {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new TrustRootError();
  }
  return parseTrustRoot(text);
}
