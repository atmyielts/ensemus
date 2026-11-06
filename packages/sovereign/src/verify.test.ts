import { describe, expect, it } from 'vitest';
import { PAYLOAD_TYPES } from './envelope';
import {
  generateTestSigningKey,
  signForTest,
  testLicense,
  testMaintenance,
  testTrustRoot,
  testTrustRootText,
} from './testing';
import { parseTrustRoot, TrustRootError } from './trust-root';
import { verifyDocument } from './verify';

const key = generateTestSigningKey('key-a');
const other = generateTestSigningKey('key-b');
const root = testTrustRoot([key]);
const signedLicense = signForTest('license', testLicense(), [key]);

describe('a signed license', () => {
  it('verifies with only a public key, and says it was signed with a test key', () => {
    const verdict = verifyDocument('license', signedLicense, root);
    expect(verdict).toMatchObject({
      ok: true,
      keyIds: ['key-a'],
      testKey: true,
      retiredKey: false,
    });
    if (verdict.ok) expect(verdict.document.term.kind).toBe('perpetual');
  });

  it('refuses one changed byte, from any field', () => {
    const envelope = JSON.parse(signedLicense) as { payload: string };
    const changed = Buffer.from(envelope.payload, 'base64')
      .toString('utf8')
      .replace('2.0.0', '3.0.0');
    const forged = JSON.stringify({
      ...envelope,
      payload: Buffer.from(changed).toString('base64'),
    });
    expect(verifyDocument('license', forged, root)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('refuses a key this deployment does not know, whatever it signed', () => {
    const verdict = verifyDocument('license', signForTest('license', testLicense(), [other]), root);
    expect(verdict).toEqual({ ok: false, code: 'UNKNOWN_KEY' });
  });

  it('refuses a key that may not sign this kind of document', () => {
    const narrow = testTrustRoot([{ ...key, purposes: ['bundle'] }]);
    expect(verifyDocument('license', signedLicense, narrow)).toEqual({
      ok: false,
      code: 'WRONG_PURPOSE',
    });
  });

  it('cannot be passed off as another kind of document', () => {
    const asMaintenance = verifyDocument('maintenance', signedLicense, root);
    expect(asMaintenance).toEqual({ ok: false, code: 'WRONG_TYPE' });
    const relabelled = JSON.stringify({
      ...(JSON.parse(signedLicense) as object),
      payloadType: PAYLOAD_TYPES.maintenance,
    });
    expect(verifyDocument('maintenance', relabelled, root)).toEqual({
      ok: false,
      code: 'BAD_SIGNATURE',
    });
  });

  it('refuses what is not an envelope, and what is too big, without reading it', () => {
    expect(verifyDocument('license', 'not json', root)).toEqual({ ok: false, code: 'MALFORMED' });
    expect(verifyDocument('license', '{"payload":"x"}', root)).toEqual({
      ok: false,
      code: 'MALFORMED',
    });
    expect(verifyDocument('license', 'x'.repeat(2 * 1024 * 1024), root)).toEqual({
      ok: false,
      code: 'TOO_LARGE',
    });
  });

  it('refuses signed content that is not a license', () => {
    expect(verifyDocument('license', signForTest('license', { format: 'x' }, [key]), root)).toEqual(
      {
        ok: false,
        code: 'CONTENT_INVALID',
      },
    );
    expect(
      verifyDocument('license', signForTest('license', Buffer.from('nope'), [key]), root),
    ).toEqual({ ok: false, code: 'CONTENT_INVALID' });
  });
});

describe('what a customer on an old release keeps', () => {
  it('reads a later issue with fields it has never heard of', () => {
    const later = signForTest('license', testLicense({ added_in_a_later_version: { a: 1 } }), [
      key,
    ]);
    expect(verifyDocument('license', later, root).ok).toBe(true);
  });

  it('names a newer format as newer, and not as a bad file', () => {
    const newer = signForTest('license', testLicense({ format_version: 2 }), [key]);
    expect(verifyDocument('license', newer, root)).toEqual({
      ok: false,
      code: 'FORMAT_NOT_SUPPORTED',
    });
  });

  it('keeps a license good after its key is retired', () => {
    const retired = testTrustRoot([{ ...key, retiredOn: '2027-06-01' }]);
    expect(verifyDocument('license', signedLicense, retired)).toMatchObject({
      ok: true,
      retiredKey: true,
    });
  });

  it('keeps a license issued before a key leaked, and refuses one issued after', () => {
    const leaked = testTrustRoot([{ ...key, compromisedOn: '2027-06-01' }]);
    expect(verifyDocument('license', signedLicense, leaked).ok).toBe(true);
    const forged = signForTest('license', testLicense({ issued_at: '2027-06-02T00:00:00.000Z' }), [
      key,
    ]);
    expect(verifyDocument('license', forged, leaked)).toEqual({
      ok: false,
      code: 'KEY_NOT_VALID_FOR_THIS_DATE',
    });
  });

  it('takes no clock, so a stopped machine or one far in the future reads the same', () => {
    expect(verifyDocument.length).toBe(3);
    const far = signForTest('license', testLicense({ issued_at: '2099-01-01T00:00:00.000Z' }), [
      key,
    ]);
    expect(verifyDocument('license', far, root).ok).toBe(true);
  });
});

describe('a second signature, if the owner decides on one', () => {
  const both = testTrustRoot([key, other], { license: 2 });

  it('needs two different keys', () => {
    expect(verifyDocument('license', signedLicense, both)).toEqual({
      ok: false,
      code: 'NOT_ENOUGH_SIGNATURES',
    });
    const twice = signForTest('license', testLicense(), [key, key]);
    expect(verifyDocument('license', twice, both)).toEqual({
      ok: false,
      code: 'NOT_ENOUGH_SIGNATURES',
    });
    const two = signForTest('license', testLicense(), [key, other]);
    expect(verifyDocument('license', two, both).ok).toBe(true);
  });

  it('does not count a key past its date towards the two', () => {
    const one = testTrustRoot([{ ...key, retiredOn: '2020-01-01' }, other], { license: 2 });
    const two = signForTest('license', testLicense(), [key, other]);
    expect(verifyDocument('license', two, one)).toEqual({
      ok: false,
      code: 'KEY_NOT_VALID_FOR_THIS_DATE',
    });
  });
});

describe('a maintenance statement', () => {
  it('verifies alone, so renewing touches no license', () => {
    const verdict = verifyDocument(
      'maintenance',
      signForTest('maintenance', testMaintenance(), [key]),
      root,
    );
    expect(verdict.ok).toBe(true);
  });

  it('refuses an end before its start', () => {
    const backwards = testMaintenance({ starts_on: '2027-12-31', ends_on: '2027-01-01' });
    expect(
      verifyDocument('maintenance', signForTest('maintenance', backwards, [key]), root),
    ).toEqual({
      ok: false,
      code: 'CONTENT_INVALID',
    });
  });
});

describe('the trust root', () => {
  it('reads what a deployment would mount', () => {
    expect(parseTrustRoot(testTrustRootText([key])).keys[0]?.key_id).toBe('key-a');
  });

  it.each([
    ['not json', 'nope'],
    ['no keys', JSON.stringify({ format: 'ensemus.trust_root', format_version: 1, keys: [] })],
    ['the same key twice', testTrustRootText([key, key])],
    [
      'a key that is not Ed25519',
      JSON.stringify({
        format: 'ensemus.trust_root',
        format_version: 1,
        keys: [
          {
            key_id: 'x',
            algorithm: 'ed25519',
            public_key: Buffer.from('not a key').toString('base64'),
            purposes: ['license'],
          },
        ],
      }),
    ],
  ])('refuses %s, with one fixed error', (_, text) => {
    expect(() => parseTrustRoot(text)).toThrow(TrustRootError);
  });
});
