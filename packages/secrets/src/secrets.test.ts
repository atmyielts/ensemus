import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FileKeyProvider, openSealed, SecretUnavailable } from './broker';
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
