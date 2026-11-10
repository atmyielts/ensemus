// Real pinned Request implementations, not a Request-shaped mock. The unsigned envelope below tests
// only the input fence/replay transport; it is never proof of a valid SAML signature or sign-in.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { guardSamlRequest } from '../../packages/auth/src/sso-request';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Request: EdgeRequest } = webRequire(
  'next/dist/compiled/@edge-runtime/primitives/fetch',
) as { Request: typeof Request };
const { AbortController: EdgeAbortController } = webRequire(
  'next/dist/compiled/@edge-runtime/primitives',
) as { AbortController: typeof AbortController };
const URL_VALUE =
  'https://ensemus.example.invalid/api/auth/sso/saml2/sp/acs/generated?transport=post';
const XML =
  '<p:Response xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion"><a:Assertion><a:Issuer>https://idp.example.invalid</a:Issuer><a:Subject><a:NameID>generated-subject</a:NameID></a:Subject><a:AuthnStatement AuthnInstant="2026-01-01T00:00:00Z"/></a:Assertion></p:Response>';
const encoded = Buffer.from(XML).toString('base64');
const bodyOf = (json = false) =>
  json
    ? JSON.stringify({ SAMLResponse: encoded, RelayState: 'opaque + correlation/=' })
    : new URLSearchParams({
        SAMLResponse: encoded,
        RelayState: 'opaque + correlation/=',
      }).toString();
const headersOf = (json = false): [string, string][] => [
  ['content-type', json ? 'application/json' : 'application/x-www-form-urlencoded; charset=UTF-8'],
  ['cookie', 'session=opaque-generated-test; saml=opaque-generated-correlation'],
  ['origin', 'https://generated-idp.example.invalid'],
  ['x-generated-marker', 'keep this header'],
];

describe('SAML replay across actual Request implementations', () => {
  for (const [label, Constructor] of [
    ['Node', Request],
    ['Next edge', EdgeRequest],
  ] as const) {
    it.each([false, true])(
      `replays ${label} exact URL, method, headers, cookies, origin and bytes (JSON=%s)`,
      async (json) => {
        const body = bodyOf(json),
          source = new Constructor(URL_VALUE, { method: 'POST', headers: headersOf(json), body });
        if (label === 'Next edge') expect(source).not.toBeInstanceOf(Request);
        const expectedHeaders = Array.from(source.headers.entries()),
          result = await guardSamlRequest(source);
        expect(result).not.toBeInstanceOf(Response);
        if (result instanceof Response) throw new Error('GENERATED_ENVELOPE_UNEXPECTEDLY_REFUSED');
        expect(source.bodyUsed).toBe(true);
        expect(result.request).not.toBe(source);
        expect(result.request).toBeInstanceOf(Request);
        expect(result.request.url).toBe(URL_VALUE);
        expect(result.request.method).toBe('POST');
        expect(Array.from(result.request.headers.entries())).toEqual(expectedHeaders);
        expect(Buffer.from(await result.request.arrayBuffer())).toEqual(Buffer.from(body));
        expect(result.envelope).toMatchObject({
          issuer: 'https://idp.example.invalid',
          subject: 'generated-subject',
          bodySha256: createHash('sha256').update(body).digest('hex'),
        });
      },
    );

    it(`replays a ${label} streamed body without a foreign body or Request constructor input`, async () => {
      const body = Buffer.from(bodyOf()),
        stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body.subarray(0, 17));
            controller.enqueue(body.subarray(17));
            controller.close();
          },
        });
      const source = new Constructor(URL_VALUE, {
        method: 'POST',
        headers: headersOf(),
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      const result = await guardSamlRequest(source);
      if (result instanceof Response) throw new Error('GENERATED_STREAM_ENVELOPE_REFUSED');
      expect(Buffer.from(await result.request.arrayBuffer())).toEqual(body);
    });
  }

  it('carries cancellation from an actual Next edge signal after the bounded body read', async () => {
    const controller = new EdgeAbortController(),
      source = new EdgeRequest(URL_VALUE, {
        method: 'POST',
        headers: headersOf(),
        body: bodyOf(),
        signal: controller.signal,
      });
    const result = await guardSamlRequest(source);
    if (result instanceof Response) throw new Error('GENERATED_CANCELLATION_ENVELOPE_REFUSED');
    expect(result.request.signal.aborted).toBe(false);
    controller.abort('generated cancellation');
    expect(result.request.signal.aborted).toBe(true);
    expect(result.request.signal.reason).toBe('generated cancellation');
  });

  it('preserves an already-aborted foreign signal instead of replaying it as live', async () => {
    const controller = new EdgeAbortController();
    controller.abort('already cancelled');
    const source = new EdgeRequest(URL_VALUE, {
        method: 'POST',
        headers: headersOf(),
        body: bodyOf(),
        signal: controller.signal,
      }),
      result = await guardSamlRequest(source);
    if (result instanceof Response) throw new Error('GENERATED_ABORTED_ENVELOPE_REFUSED');
    expect(result.request.signal.aborted).toBe(true);
    expect(result.request.signal.reason).toBe('already cancelled');
  });

  it.each(['declaration', 'duplicate', 'encoded-cap', 'body-cap'] as const)(
    'keeps the foreign-request %s rejection boundary',
    async (kind) => {
      let body = bodyOf();
      if (kind === 'declaration')
        body = new URLSearchParams({
          SAMLResponse: Buffer.from(
            '<!DOCTYPE Response SYSTEM "https://never-fetch.invalid">' + XML,
          ).toString('base64'),
        }).toString();
      if (kind === 'duplicate') body += '&SAMLResponse=second';
      if (kind === 'encoded-cap')
        body = new URLSearchParams({ SAMLResponse: 'A'.repeat(256 * 1024 + 1) }).toString();
      if (kind === 'body-cap') body = 'A'.repeat(320 * 1024 + 1);
      const result = await guardSamlRequest(
        new EdgeRequest(URL_VALUE, { method: 'POST', headers: headersOf(), body }),
      );
      expect(result).toBeInstanceOf(Response);
      if (!(result instanceof Response)) throw new Error('UNSAFE_GENERATED_ENVELOPE_WAS_REPLAYED');
      expect(result.status).toBe(400);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(await result.json()).toEqual({
        code: 'SSO_REFUSED',
        message: 'Company sign-in could not be completed.',
      });
    },
  );

  it('leaves non-ACS requests untouched without consuming their body', async () => {
    const source = new EdgeRequest('https://ensemus.example.invalid/api/auth/other', {
        method: 'POST',
        body: 'not a SAML envelope',
      }),
      result = await guardSamlRequest(source);
    expect(result).toEqual({ request: source });
    expect(source.bodyUsed).toBe(false);
  });
});
