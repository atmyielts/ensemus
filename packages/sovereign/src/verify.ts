// The offline verifier (COMM-03). Takes a file's text and a trust root, and needs no network, no clock and
// no vendor. The web tier can run it, since it holds only public keys.
import { DOCUMENT_SCHEMAS, type DocumentFor } from './documents';
import { verifyEnvelope, type EnvelopeRefusal } from './envelope';
import type { DocumentPurpose, TrustedKey, TrustRoot } from './trust-root';

export type DocumentRefusal =
  | EnvelopeRefusal
  /** A `format_version` this verifier does not read. A newer issue, and nothing wrong with it. */
  | 'FORMAT_NOT_SUPPORTED'
  | 'CONTENT_INVALID'
  /** Issued after the signing key was retired or marked compromised. */
  | 'KEY_NOT_VALID_FOR_THIS_DATE';

export type DocumentVerdict<P extends DocumentPurpose> =
  | {
      ok: true;
      document: DocumentFor<P>;
      keyIds: readonly string[];
      /** Signed with a generated test key. Every page that shows this document says so. */
      testKey: boolean;
      /** Signed with a key since retired. Still good, and worth a note. */
      retiredKey: boolean;
    }
  | { ok: false; code: DocumentRefusal };

/** Whether this key could have signed something on this day. A later retirement changes nothing earlier. */
const validOn = (key: TrustedKey, day: string) =>
  (key.retired_on === null || day <= key.retired_on) &&
  (key.compromised_on === null || day <= key.compromised_on);

/**
 * Verifies one signed document of one kind. There is deliberately no `now` here: signatures, keys and
 * dates inside the document are all it looks at, so a stopped clock on an isolated machine cannot refuse
 * a good license, and no document can go bad by itself.
 */
export function verifyDocument<P extends DocumentPurpose>(
  purpose: P,
  text: string,
  root: TrustRoot,
): DocumentVerdict<P> {
  const verdict = verifyEnvelope(text, root, purpose);
  if (!verdict.ok) return verdict;

  let raw: unknown;
  try {
    raw = JSON.parse(verdict.payload.toString('utf8'));
  } catch {
    return { ok: false, code: 'CONTENT_INVALID' };
  }
  const version = (raw as { format_version?: unknown } | null)?.format_version;
  if (typeof version === 'number' && version > 1) {
    return { ok: false, code: 'FORMAT_NOT_SUPPORTED' };
  }
  const parsed = DOCUMENT_SCHEMAS[purpose].safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'CONTENT_INVALID' };
  const document = parsed.data as DocumentFor<P>;

  // Only keys that signed for a date they were good for count towards the threshold.
  const issuedOn = (document as { issued_at: string }).issued_at.slice(0, 10);
  const valid = verdict.keys.filter((key) => validOn(key, issuedOn));
  if (valid.length < root.thresholds[purpose]) {
    return { ok: false, code: 'KEY_NOT_VALID_FOR_THIS_DATE' };
  }
  return {
    ok: true,
    document,
    keyIds: valid.map((key) => key.key_id),
    testKey: valid.some((key) => key.test_only),
    retiredKey: valid.some((key) => key.retired_on !== null || key.compromised_on !== null),
  };
}
