// Workers only (lint blocks this from the web tier). The private key lives here and nowhere else.
import {
  constants,
  createDecipheriv,
  createHash,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  listLiveSecretsByPurpose,
  listTenantSecrets,
  readSealedSecret,
  replaceWrappedKey,
  resealSecret,
  revokeSecret,
  type openSecretsDatabase,
  type ResealedFields,
} from '@ensemus/database/secrets';
import { additionalData, encryptBound, keyIdOf } from './format';

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

/**
 * The one purpose whose value may be replaced in place, because providers rotate refresh tokens (0562).
 * The database refuses any other with EN124; this refuses it first, as a read of a missing secret would.
 */
export const RESEALABLE_PURPOSE = 'connector_credential';

/**
 * The new seal for a rotated secret, or null when the value sealed now is not the one the caller started
 * from. The caller names what it read by its SHA-256, so a refresh that lost a race to another refresh
 * never overwrites the newer token with its own. The new seal has a fresh data key under the active key,
 * as `sealSecret` makes, and the same tenant, ID and purpose in its additional data, which is what lets it
 * keep the row's ID. A row that will not open throws, as a read would.
 */
export function resealIfCurrent(
  provider: KeyProvider,
  row: SealedFields & { purpose: string },
  binding: { organizationId: string; secretId: string; purpose: string },
  expectedSha256: string,
  replacement: Buffer,
): ResealedFields | null {
  if (binding.purpose !== RESEALABLE_PURPOSE || row.purpose !== binding.purpose) {
    throw new SecretUnavailable();
  }
  const current = openSealed(provider, row, binding);
  try {
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) return null;
    const digest = createHash('sha256').update(current).digest();
    if (!timingSafeEqual(digest, Buffer.from(expectedSha256, 'hex'))) return null;
  } finally {
    current.fill(0);
  }
  const dataKey = randomBytes(32);
  try {
    return {
      keyId: provider.activeKeyId,
      wrappedKey: provider.wrapWithActiveKey(dataKey),
      ...encryptBound(dataKey, binding, replacement),
    };
  } finally {
    dataKey.fill(0);
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

  /**
   * Replaces a connector credential's value after the provider rotated it (0562). 'stale' when the value
   * sealed now is not the one the caller read, and nothing is written. A secret that is gone, revoked,
   * of another purpose than the binding names, or of any purpose but a connector credential throws, as
   * reading a missing one would. `replacement` stays the caller's to wipe.
   */
  async reseal(
    binding: { organizationId: string; secretId: string; purpose: string },
    expectedSha256: string,
    replacement: Buffer,
  ): Promise<'stored' | 'stale'> {
    if (binding.purpose !== RESEALABLE_PURPOSE) throw new SecretUnavailable();
    const result = await resealSecret(this.#db, binding, (row) =>
      resealIfCurrent(this.#provider, row, binding, expectedSha256, replacement),
    );
    if (result === 'missing') throw new SecretUnavailable();
    return result;
  }

  revoke(organizationId: string, secretId: string) {
    return revokeSecret(this.#db, organizationId, secretId);
  }

  /** The tenant's live sealed values of these purposes, by ID, purpose and age. Never a value. */
  listLive(organizationId: string, purposes: readonly string[]) {
    return listLiveSecretsByPurpose(this.#db, organizationId, purposes);
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
