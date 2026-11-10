// Workers only (lint blocks this from the web tier). The private key lives here and nowhere else.
import {
  constants,
  createDecipheriv,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
} from 'node:crypto';
import {
  listTenantSecrets,
  readSealedSecret,
  replaceWrappedKey,
  revokeSecret,
  type openSecretsDatabase,
} from '@ensemus/database/secrets';
import { additionalData, keyIdOf } from './format';

export class SecretUnavailable extends Error {
  override name = 'SecretUnavailable';
  constructor() {
    // Never says why: missing, revoked and tampered look the same to a caller.
    super('Secret is not available');
  }
}

/** Where key-encryption keys come from. A KMS or vault adapter implements the same port. */
export interface KeyProvider {
  readonly activeKeyId: string;
  unwrap(keyId: string, wrappedKey: Buffer): Buffer;
  wrapWithActiveKey(dataKey: Buffer): Buffer;
}

/** Keys from mounted PEM files. The first is active; the rest stay readable during rotation. */
export class FileKeyProvider implements KeyProvider {
  readonly activeKeyId: string;
  readonly #keys = new Map<string, string>();
  readonly #activePublicKey: string;

  constructor(privateKeyPems: [string, ...string[]]) {
    for (const pem of privateKeyPems) {
      const publicPem = createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString();
      this.#keys.set(keyIdOf(publicPem), pem);
    }
    this.#activePublicKey = createPublicKey(privateKeyPems[0])
      .export({ type: 'spki', format: 'pem' })
      .toString();
    this.activeKeyId = keyIdOf(this.#activePublicKey);
  }

  unwrap(keyId: string, wrappedKey: Buffer): Buffer {
    const key = this.#keys.get(keyId);
    if (!key) throw new SecretUnavailable();
    return privateDecrypt(
      { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      wrappedKey,
    );
  }

  wrapWithActiveKey(dataKey: Buffer): Buffer {
    return publicEncrypt(
      { key: this.#activePublicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      dataKey,
    );
  }
}

type SealedFields = {
  keyId: string;
  wrappedKey: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
};

/** Opens a sealed value. Any tampering, or the wrong tenant or purpose, fails the same way. */
export function openSealed(
  provider: KeyProvider,
  sealed: SealedFields,
  binding: { organizationId: string; secretId: string; purpose: string },
): Buffer {
  let dataKey: Buffer | undefined;
  try {
    dataKey = provider.unwrap(sealed.keyId, sealed.wrappedKey);
    const decipher = createDecipheriv('aes-256-gcm', dataKey, sealed.iv);
    decipher.setAAD(additionalData(binding.organizationId, binding.secretId, binding.purpose));
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    throw new SecretUnavailable();
  } finally {
    dataKey?.fill(0);
  }
}

type SecretsDb = ReturnType<typeof openSecretsDatabase>['db'];

export class SecretBroker {
  readonly #db: SecretsDb;
  readonly #provider: KeyProvider;

  constructor(db: SecretsDb, provider: KeyProvider) {
    this.#db = db;
    this.#provider = provider;
  }

  /**
   * Lends a secret to `use` and wipes the buffer afterwards. There is deliberately no method that
   * returns a secret, so it cannot end up in a prompt, a trace or a workflow payload by accident.
   */
  async withSecret<T>(
    binding: { organizationId: string; secretId: string; purpose: string },
    use: (secret: Buffer) => Promise<T>,
  ): Promise<T> {
    const row = await readSealedSecret(this.#db, binding.organizationId, binding.secretId);
    if (!row || row.purpose !== binding.purpose) throw new SecretUnavailable();
    const secret = openSealed(this.#provider, row, binding);
    try {
      return await use(secret);
    } finally {
      secret.fill(0);
    }
  }

  revoke(organizationId: string, secretId: string) {
    return revokeSecret(this.#db, organizationId, secretId);
  }

  /** Rewraps a tenant's data keys under the active key. Ciphertext is untouched. */
  async rotateTenant(organizationId: string): Promise<number> {
    const rows = await listTenantSecrets(this.#db, organizationId);
    let rotated = 0;
    for (const row of rows) {
      if (row.keyId === this.#provider.activeKeyId) continue;
      const dataKey = this.#provider.unwrap(row.keyId, row.wrappedKey);
      try {
        await replaceWrappedKey(this.#db, organizationId, row.id, {
          keyId: this.#provider.activeKeyId,
          wrappedKey: this.#provider.wrapWithActiveKey(dataKey),
        });
        rotated += 1;
      } finally {
        dataKey.fill(0);
      }
    }
    return rotated;
  }
}
