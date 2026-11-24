import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  keyIdOf,
  isValidPublicKey,
  signingPayload,
  verifySkillSignature,
  checkTenantSignature,
} from './signature';
import { signSkillDigest } from './sign';

const pair = () => {
  const keys = generateKeyPairSync('ed25519');
  return { ...keys, raw: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32) };
};
const digest = 'a'.repeat(64);

describe('publisher signatures', () => {
  it('interoperates with Node Ed25519 over the specified domain, not a second hash', () => {
    const key = pair();
    const payload = Buffer.from(`ensemus.skill.signature.v1\0${digest}`);
    const signature = sign(null, payload, key.privateKey);
    expect(signingPayload(digest)).toEqual(payload);
    expect(keyIdOf(key.raw)).toBe(createHash('sha256').update(key.raw).digest('hex'));
    expect(isValidPublicKey(key.raw)).toBe(true);
    expect(verifySkillSignature({ digest, signature, publicKey: key.raw })).toBe(true);
    const privateKeyPem = key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(verify(null, payload, key.publicKey, signSkillDigest({ digest, privateKeyPem }))).toBe(
      true,
    );
  });

  it('rejects changed bytes, another signer, another signature domain and malformed encodings', () => {
    const key = pair();
    const signature = sign(
      null,
      Buffer.from(`ensemus.skill.signature.v1\0${digest}`),
      key.privateKey,
    );
    for (const input of [
      { digest: 'b'.repeat(64), signature, publicKey: key.raw },
      { digest, signature, publicKey: pair().raw },
      {
        digest,
        signature: sign(null, Buffer.from(`ensemus.skill.review.v1\0${digest}`), key.privateKey),
        publicKey: key.raw,
      },
      { digest: 'A'.repeat(64), signature, publicKey: key.raw },
      { digest, signature: signature.subarray(1), publicKey: key.raw },
      { digest, signature, publicKey: key.raw.subarray(1) },
    ])
      expect(verifySkillSignature(input)).toBe(false);
    expect(isValidPublicKey(Buffer.alloc(33))).toBe(false);
    expect(() => signingPayload('not-a-digest')).toThrow();
    expect(() => signSkillDigest({ digest, privateKeyPem: 'not-a-key' })).toThrow();
  });

  it('requires a live tenant trust row whose fingerprint matches its actual public key', () => {
    const key = pair();
    const keyId = keyIdOf(key.raw);
    const signature = sign(null, signingPayload(digest), key.privateKey);
    const input = { digest, keyId, signature };
    expect(checkTenantSignature({ ...input, lookup: () => null })).toBe('SIGNER_UNTRUSTED');
    expect(
      checkTenantSignature({ ...input, lookup: () => ({ publicKey: key.raw, state: 'revoked' }) }),
    ).toBe('SIGNER_REVOKED');
    expect(
      checkTenantSignature({
        ...input,
        lookup: () => ({ publicKey: pair().raw, state: 'active' }),
      }),
    ).toBe('SIGNER_UNTRUSTED');
    expect(
      checkTenantSignature({ ...input, lookup: () => ({ publicKey: key.raw, state: 'active' }) }),
    ).toBe('ok');
    expect(
      checkTenantSignature({
        ...input,
        digest: 'b'.repeat(64),
        lookup: () => ({ publicKey: key.raw, state: 'active' }),
      }),
    ).toBe('SIGNATURE_INVALID');
  });
});
