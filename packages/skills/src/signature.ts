// Owned by the skill-format slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D2. Verification
// only, with node:crypto and public keys. Signing is in ./sign, which no shipped code may import.

import { createHash, createPublicKey, verify } from 'node:crypto';

// RFC 8410 SubjectPublicKeyInfo wrapper for a raw Ed25519 public key.
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const DIGEST = /^[0-9a-f]{64}$/;
function publicKeyObject(publicKey: Buffer) {
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32)
    throw new Error('SKILL_SIGNER_KEY_INVALID');
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI, publicKey]),
    format: 'der',
    type: 'spki',
  });
}

/** The fixed prefix on what a package signature signs, so it can never be spent as any other signature. */
export const SKILL_SIGNATURE_DOMAIN = 'ensemus.skill.signature.v1\0';

/** SHA-256 of the raw 32-byte public key, in hex. What a signature names and what a person compares. */
export function keyIdOf(publicKey: Buffer): string {
  if (!isValidPublicKey(publicKey)) throw new Error('SKILL_SIGNER_KEY_INVALID');
  return createHash('sha256').update(publicKey).digest('hex');
}

/** Whether these bytes are a usable Ed25519 public key. Anything but 32 bytes that load as one is not. */
export function isValidPublicKey(publicKey: Buffer): boolean {
  try {
    return publicKeyObject(publicKey).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

/** Exactly the bytes a publisher signs: the domain prefix, then the digest as hex. */
export function signingPayload(digest: string): Buffer {
  if (!DIGEST.test(digest)) throw new Error('DIGEST_MISMATCH');
  return Buffer.from(SKILL_SIGNATURE_DOMAIN + digest, 'utf8');
}

/** Answers false for any failure at all, including a malformed key or signature, and never throws. */
export function verifySkillSignature(input: {
  digest: string;
  signature: Buffer;
  publicKey: Buffer;
}): boolean {
  try {
    return (
      Buffer.isBuffer(input.signature) &&
      input.signature.length === 64 &&
      verify(null, signingPayload(input.digest), publicKeyObject(input.publicKey), input.signature)
    );
  } catch {
    return false;
  }
}

export type SignerLookup = (
  keyId: string,
) => { publicKey: Buffer; state: 'active' | 'revoked' } | null;

/**
 * The whole trust decision for a tenant upload: the key named by the signature is on file, active, hashes
 * to its ID, and verifies. Each failure has its own code, so a person can see which one to fix.
 */
export function checkTenantSignature(input: {
  digest: string;
  keyId: string;
  signature: Buffer;
  lookup: SignerLookup;
}): 'ok' | 'SIGNER_UNTRUSTED' | 'SIGNER_REVOKED' | 'SIGNATURE_INVALID' {
  const signer = input.lookup(input.keyId);
  if (!signer || !isValidPublicKey(signer.publicKey) || keyIdOf(signer.publicKey) !== input.keyId)
    return 'SIGNER_UNTRUSTED';
  if (signer.state === 'revoked') return 'SIGNER_REVOKED';
  return verifySkillSignature({
    digest: input.digest,
    signature: input.signature,
    publicKey: signer.publicKey,
  })
    ? 'ok'
    : 'SIGNATURE_INVALID';
}
