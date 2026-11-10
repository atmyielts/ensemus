import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  exportRecipientPublicKey,
  generateRecipientKeyPair,
  open,
  parseRecipientPublicKey,
  recipientKeyId,
  seal,
  SealedRefused,
  sealedRecipientId,
} from './sealed';

const { publicKey, privateKey } = generateRecipientKeyPair();

describe('sealed objects', () => {
  it('opens what was sealed, including nothing at all', () => {
    const message = randomBytes(100_000);
    expect(open(seal(message, publicKey), privateKey).equals(message)).toBe(true);
    expect(open(seal(Buffer.alloc(0), publicKey), privateKey).length).toBe(0);
  });

  it('holds no plain text, and gives the same message a different form each time', () => {
    const message = Buffer.from('canary-plain-text-canary');
    const first = seal(message, publicKey);
    expect(first.includes(message)).toBe(false);
    expect(first.equals(seal(message, publicKey))).toBe(false);
  });

  it('refuses the wrong key', () => {
    const wrong = generateRecipientKeyPair().privateKey;
    expect(() => open(seal(Buffer.from('x'), publicKey), wrong)).toThrow(SealedRefused);
  });

  it('refuses a change to any part of it', () => {
    const sealed = seal(Buffer.from('some content'), publicKey);
    for (const position of [20, 30, 60, sealed.length - 20, sealed.length - 1]) {
      const changed = Buffer.from(sealed);
      changed[position] = (changed[position] as number) ^ 1;
      expect(() => open(changed, privateKey), `byte ${position}`).toThrow(SealedRefused);
    }
  });

  it('refuses what is not sealed, and what was cut short', () => {
    expect(() => open(Buffer.from('plain'), privateKey)).toThrow(SealedRefused);
    const sealed = seal(Buffer.from('content'), publicKey);
    expect(() => open(sealed.subarray(0, sealed.length - 1), privateKey)).toThrow(SealedRefused);
    expect(() => open(sealed.subarray(0, 25), privateKey)).toThrow(SealedRefused);
  });

  it('says who it is for without opening it', () => {
    expect(sealedRecipientId(seal(Buffer.from('x'), publicKey))).toBe(recipientKeyId(publicKey));
    expect(sealedRecipientId(Buffer.from('plain'))).toBeNull();
  });
});

describe('a recipient key', () => {
  it('travels as text and comes back the same', () => {
    const text = exportRecipientPublicKey(publicKey);
    expect(recipientKeyId(parseRecipientPublicKey(text))).toBe(recipientKeyId(publicKey));
  });

  it('refuses anything that is not an X25519 public key', () => {
    expect(() => parseRecipientPublicKey('nonsense')).toThrow();
    expect(() => parseRecipientPublicKey(Buffer.from('nonsense').toString('base64'))).toThrow();
  });
});
