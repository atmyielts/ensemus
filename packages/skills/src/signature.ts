// Owned by the skill-format slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D2. Verification
// only, with node:crypto and public keys. Signing is in ./sign, which no shipped code may import.

/** The fixed prefix on what a package signature signs, so it can never be spent as any other signature. */
export const SKILL_SIGNATURE_DOMAIN = 'ensemus.skill.signature.v1\0';

/** SHA-256 of the raw 32-byte public key, in hex. What a signature names and what a person compares. */
export function keyIdOf(_publicKey: Buffer): string {
  throw new Error('NOT_IMPLEMENTED');
}

/** Whether these bytes are a usable Ed25519 public key. Anything but 32 bytes that load as one is not. */
export function isValidPublicKey(_publicKey: Buffer): boolean {
  throw new Error('NOT_IMPLEMENTED');
}

/** Exactly the bytes a publisher signs: the domain prefix, then the digest as hex. */
export function signingPayload(_digest: string): Buffer {
  throw new Error('NOT_IMPLEMENTED');
}

/** Answers false for any failure at all, including a malformed key or signature, and never throws. */
export function verifySkillSignature(_input: {
  digest: string;
  signature: Buffer;
  publicKey: Buffer;
}): boolean {
  throw new Error('NOT_IMPLEMENTED');
}

export type SignerLookup = (
  keyId: string,
) => { publicKey: Buffer; state: 'active' | 'revoked' } | null;

/**
 * The whole trust decision for a tenant upload: the key named by the signature is on file, active, hashes
 * to its ID, and verifies. Each failure has its own code, so a person can see which one to fix.
 */
export function checkTenantSignature(_input: {
  digest: string;
  keyId: string;
  signature: Buffer;
  lookup: SignerLookup;
}): 'ok' | 'SIGNER_UNTRUSTED' | 'SIGNER_REVOKED' | 'SIGNATURE_INVALID' {
  throw new Error('NOT_IMPLEMENTED');
}
