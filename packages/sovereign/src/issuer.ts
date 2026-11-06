// Owned by the issuer slice (SOV-01, SOV-04). See docs/06-delivery/m6-slices.md and ADR-030 D3. The vendor's
// tool, and nothing that ships: lint keeps this out of the web tier and the workers, and a test checks that
// no image's build reaches it. Who holds the real signing keys is the owner's open decision, so signing is
// a port, and the only implementation so far reads a generated key from a file for rehearsal.
import type { DocumentFor } from './documents';
import type { DocumentPurpose } from './trust-root';

/** Signs bytes. A hardware token, a KMS or a second holder implements this once custody is decided. */
export interface DocumentSigner {
  readonly keyId: string;
  sign(preAuthEncoded: Buffer): Promise<Buffer>;
}

/**
 * Reads a generated key from a file. Refuses unless `rehearsal` is true, and the issuer's output and its
 * register both record that it was used. No real key is stored or used until the owner decides custody and
 * outside review has happened.
 */
export function createRehearsalFileSigner(_input: {
  keyId: string;
  privateKeyPemFile: string;
  rehearsal: true;
}): DocumentSigner {
  throw new Error('NOT_IMPLEMENTED');
}

/** Wraps a validated document in an envelope. Refuses a document its own schema would refuse. */
export async function issueDocument<P extends DocumentPurpose>(
  _purpose: P,
  _document: DocumentFor<P>,
  _signers: readonly DocumentSigner[],
): Promise<string> {
  throw new Error('NOT_IMPLEMENTED');
}

/** One line of the issuer's append-only register. IDs, hashes and the key used, and nothing confidential. */
export type IssueRecord = {
  issued_at: string;
  purpose: DocumentPurpose;
  document_id: string;
  envelope_sha256: string;
  key_ids: readonly string[];
  rehearsal: boolean;
};

/**
 * The command line: `keygen`, `license`, `maintenance`, `advisory`, `support-policy`, `verify`. Takes its
 * rights and policy from a file with no defaults, so nothing here chooses what the owner decides. Returns
 * an exit status, and takes its file and console access as arguments so a test can run it whole.
 */
export function runIssuerCommand(
  _argv: readonly string[],
  _io: {
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, data: Buffer | string): Promise<void>;
    appendFile(path: string, data: string): Promise<void>;
    out(line: string): void;
    err(line: string): void;
    now(): Date;
  },
): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}
