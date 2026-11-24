import { createCipheriv, createHash, createPublicKey, randomBytes } from 'node:crypto';

export type SealedValue = {
  keyId: string;
  wrappedKey: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
};

/**
 * Binds a ciphertext to its tenant, its ID and its purpose. A sealed value moved to another tenant
 * or used for another purpose fails authentication, even if the database was tampered with.
 */
export function additionalData(organizationId: string, secretId: string, purpose: string): Buffer {
  return Buffer.from(`ensemus.secret.v1|${organizationId}|${secretId}|${purpose}`, 'utf8');
}

/**
 * AES-256-GCM under one data key, with a fresh IV, bound by `additionalData`. Sealing a new secret and
 * resealing a rotated one both come here, so the two can never disagree about the binding.
 */
export function encryptBound(
  dataKey: Buffer,
  binding: { organizationId: string; secretId: string; purpose: string },
  plaintext: Buffer,
): { iv: Buffer; ciphertext: Buffer; authTag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(additionalData(binding.organizationId, binding.secretId, binding.purpose));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
}

export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32);
}
