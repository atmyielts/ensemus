// The fake Bedrock route checks SigV4 signatures, and this proves that check against AWS's own published
// examples, so a request it accepts was signed the way AWS documents and not only the way the adapter's
// signer happens to sign. The example key is AWS's documentation key, which signs nothing anywhere.
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- sigv4.mjs is plain JavaScript, so the fake server can run as its own process.
import * as sigv4 from '../fixtures/fake-model/sigv4.mjs';

type Verify = (
  request: { method: string; path: string; headers: Record<string, string>; raw: string },
  options: { secrets: Map<string, string>; region: string; service: string; now?: Date },
) => string;
const { canonicalUri, signatureFor, signingKey, verifySigV4 } = sigv4 as {
  canonicalUri: (path: string) => string;
  signatureFor: (input: Record<string, unknown>) => string;
  signingKey: (secret: string, date: string, region: string, service: string) => Buffer;
  verifySigV4: Verify;
};

// From AWS's "Signature Version 4 signing process" documentation and its test suite.
const EXAMPLE_KEY_ID = ['AKID', 'EXAMPLE'].join('');
const EXAMPLE_SECRET = ['wJalrXUtnFEMI', 'K7MDENG+bPxRfiCYEXAMPLEKEY'].join('/');
const DATETIME = '20150830T123600Z';

describe('SigV4 as the fake checks it, against AWS published examples', () => {
  it('derives the documented signing key', () => {
    expect(signingKey(EXAMPLE_SECRET, '20150830', 'us-east-1', 'iam').toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
  });

  it('signs the documented IAM ListUsers request', () => {
    expect(
      signatureFor({
        method: 'GET',
        path: '/',
        search: 'Action=ListUsers&Version=2010-05-08',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
          host: 'iam.amazonaws.com',
          'x-amz-date': DATETIME,
        },
        signedHeaders: ['content-type', 'host', 'x-amz-date'],
        body: '',
        secretAccessKey: EXAMPLE_SECRET,
        datetime: DATETIME,
        region: 'us-east-1',
        service: 'iam',
      }),
    ).toBe('5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });

  it('signs the test suite get-vanilla request', () => {
    expect(
      signatureFor({
        method: 'GET',
        path: '/',
        headers: { host: 'example.amazonaws.com', 'x-amz-date': DATETIME },
        signedHeaders: ['host', 'x-amz-date'],
        body: '',
        secretAccessKey: EXAMPLE_SECRET,
        datetime: DATETIME,
        region: 'us-east-1',
        service: 'service',
      }),
    ).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('encodes each path segment twice, as every service but S3 expects', () => {
    expect(canonicalUri('/model/anthropic.claude-v2%3A1/converse')).toBe(
      '/model/anthropic.claude-v2%253A1/converse',
    );
    expect(canonicalUri('//a//b')).toBe('/a/b');
  });

  describe('verifying a request', () => {
    const now = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
    const signed = (overrides: Partial<Record<string, string>> = {}, body = '{"a":1}') => {
      const headers: Record<string, string> = {
        host: 'bedrock-runtime.us-east-1.amazonaws.com',
        'content-type': 'application/json',
        'x-amz-date': DATETIME,
      };
      const signature = signatureFor({
        method: 'POST',
        path: '/model/m/converse',
        headers,
        signedHeaders: ['content-type', 'host', 'x-amz-date'],
        body,
        secretAccessKey: EXAMPLE_SECRET,
        datetime: DATETIME,
        region: 'us-east-1',
        service: 'bedrock',
      });
      return {
        method: 'POST',
        path: '/model/m/converse',
        raw: body,
        headers: {
          ...headers,
          authorization: `AWS4-HMAC-SHA256 Credential=${EXAMPLE_KEY_ID}/20150830/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`,
          ...overrides,
        },
      };
    };
    const options = {
      secrets: new Map([[EXAMPLE_KEY_ID, EXAMPLE_SECRET]]),
      region: 'us-east-1',
      service: 'bedrock',
      now,
    };

    it('accepts a correctly signed request', () => {
      expect(verifySigV4(signed(), options)).toBe('valid');
    });

    it('refuses a changed body, host, region, key, date or a missing header', () => {
      expect(verifySigV4({ ...signed(), raw: '{"a":2}' }, options)).toBe('bad_signature');
      expect(verifySigV4(signed({ host: 'evil.example' }), options)).toBe('bad_signature');
      expect(verifySigV4(signed(), { ...options, region: 'us-west-2' })).toBe('wrong_scope');
      expect(verifySigV4(signed(), { ...options, secrets: new Map() })).toBe('unknown_key');
      expect(
        verifySigV4(signed(), { ...options, now: new Date(now.getTime() + 10 * 60_000) }),
      ).toBe('stale');
      const unsigned = signed();
      delete (unsigned.headers as Record<string, string | undefined>).authorization;
      expect(verifySigV4(unsigned, options)).toBe('absent');
      expect(verifySigV4(signed({ authorization: 'Bearer x' }), options)).toBe('malformed');
    });
  });
});
