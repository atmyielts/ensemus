import { createHash, createPublicKey } from 'node:crypto';

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

export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32);
}
