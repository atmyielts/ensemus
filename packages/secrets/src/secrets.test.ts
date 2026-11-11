import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FileKeyProvider, openSealed, resealIfCurrent, SecretUnavailable } from './broker';
import { sealSecret } from './seal';

const makeKeys = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

const keys = makeKeys();
const provider = new FileKeyProvider([keys.privateKey]);
const binding = { organizationId: randomUUID(), secretId: randomUUID(), purpose: 'model.api_key' };
const PLAINTEXT = 'sk-canary-do-not-leak';
const seal = () => sealSecret({ publicKeyPem: keys.publicKey, plaintext: PLAINTEXT, ...binding });

describe('sealed secrets', () => {
  it('round-trips through seal and open', () => {
    expect(openSealed(provider, seal(), binding).toString()).toBe(PLAINTEXT);
  });

  it('never contains the plaintext, and differs every time', () => {
    const a = seal();
    const b = seal();
    for (const field of [a.ciphertext, a.wrappedKey, a.iv, a.authTag]) {
      expect(field.toString('latin1')).not.toContain(PLAINTEXT);
    }
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it.each([
    ['another tenant', { ...binding, organizationId: randomUUID() }],
    ['another secret ID', { ...binding, secretId: randomUUID() }],
    ['another purpose', { ...binding, purpose: 'connector.oauth' }],
  ])('refuses to open under %s', (_label, wrong) => {
    expect(() => openSealed(provider, seal(), wrong)).toThrow(SecretUnavailable);
  });

  it.each(['ciphertext', 'authTag', 'iv', 'wrappedKey'] as const)(
    'detects a changed %s',
    (field) => {
      const sealed = seal();
      sealed[field][0]! ^= 0xff;
      expect(() => openSealed(provider, sealed, binding)).toThrow(SecretUnavailable);
    },
  );

  it('cannot be opened with a different private key', () => {
    const other = makeKeys();
    const sealed = sealSecret({ publicKeyPem: other.publicKey, plaintext: PLAINTEXT, ...binding });
    expect(() => openSealed(provider, sealed, binding)).toThrow(SecretUnavailable);
  });

  it('does not reveal the cause of a failure', () => {
    const sealed = seal();
    sealed.authTag[0]! ^= 0xff;
    expect(() => openSealed(provider, sealed, binding)).toThrow('Secret is not available');
  });
});

describe('resealing a rotated connector credential', () => {
  const credential = {
    organizationId: randomUUID(),
    secretId: randomUUID(),
    purpose: 'connector_credential',
  };
  const BEFORE = '{"client":"platform","refresh_token":"generated-refresh-1"}';
  const AFTER = '{"client":"platform","refresh_token":"generated-refresh-2"}';
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
  const stored = () => ({
    ...sealSecret({ publicKeyPem: keys.publicKey, plaintext: BEFORE, ...credential }),
    purpose: credential.purpose,
  });

  it('seals the replacement under the same tenant, ID and purpose, with a fresh data key and IV', () => {
    const row = stored();
    const next = resealIfCurrent(provider, row, credential, sha256(BEFORE), Buffer.from(AFTER));
    expect(next).not.toBeNull();
    expect(openSealed(provider, next!, credential).toString()).toBe(AFTER);
    expect(next!.keyId).toBe(provider.activeKeyId);
    expect(next!.iv.equals(row.iv)).toBe(false);
    expect(next!.wrappedKey.equals(row.wrappedKey)).toBe(false);
    for (const field of [next!.ciphertext, next!.wrappedKey, next!.iv, next!.authTag])
      expect(field.toString('latin1')).not.toContain('generated-refresh-2');
  });

  it('answers null when the sealed value is not the one the caller read', () => {
    for (const expected of [sha256(AFTER), sha256(BEFORE).toUpperCase(), 'not-a-digest', ''])
      expect(
        resealIfCurrent(provider, stored(), credential, expected, Buffer.from(AFTER)),
      ).toBeNull();
  });

  it.each([
    ['another tenant', { ...credential, organizationId: randomUUID() }],
    ['another secret ID', { ...credential, secretId: randomUUID() }],
    ['another purpose', { ...credential, purpose: 'model.api_key' }],
  ])('refuses under %s, as a read would', (_label, wrong) => {
    expect(() =>
      resealIfCurrent(provider, stored(), wrong, sha256(BEFORE), Buffer.from(AFTER)),
    ).toThrow(SecretUnavailable);
  });

  it('refuses a row whose stored purpose is not the one asked for', () => {
    const row = { ...stored(), purpose: 'model.api_key' };
    expect(() =>
      resealIfCurrent(provider, row, credential, sha256(BEFORE), Buffer.from(AFTER)),
    ).toThrow(SecretUnavailable);
  });

  it('refuses any purpose but a connector credential, even when the row matches the binding', () => {
    const other = { ...credential, purpose: 'model.api_key' };
    const row = {
      ...sealSecret({ publicKeyPem: keys.publicKey, plaintext: BEFORE, ...other }),
      purpose: other.purpose,
    };
    expect(() => resealIfCurrent(provider, row, other, sha256(BEFORE), Buffer.from(AFTER))).toThrow(
      SecretUnavailable,
    );
  });

  it('refuses a tampered row', () => {
    const row = stored();
    row.authTag[0]! ^= 0xff;
    expect(() =>
      resealIfCurrent(provider, row, credential, sha256(BEFORE), Buffer.from(AFTER)),
    ).toThrow(SecretUnavailable);
  });
});
