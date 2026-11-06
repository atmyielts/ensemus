import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generatedSamlIdp } from '../../../tests/helpers/saml-idp';
import {
  createSsoOperations,
  parseSamlMetadata,
  MAX_SAML_METADATA_BYTES,
  SSO_DISABLED_PATHS,
} from './sso';
import { createSamlFlow, ssoBoundary, ssoIdpIssuer } from './sso-flow';
import { guardSamlRequest } from './sso-request';
describe('SAML metadata and verified session boundary', () => {
  let idp: Awaited<ReturnType<typeof generatedSamlIdp>>;
  beforeAll(async () => {
    idp = await generatedSamlIdp();
  });
  it('uses namespace-aware IdP authority, secure browser endpoints and a current RSA key for SHA256-only signed assertions', () => {
    const parsed = parseSamlMetadata(idp.metadata, 'https://ensemus.example.invalid', 'generated');
    expect(parsed?.issuer).toBe(idp.issuer);
    expect(parsed?.samlConfig).toMatchObject({
      wantAssertionsSigned: true,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      idpMetadata: { entityID: idp.issuer },
      entryPoint: 'https://generated-idp.example.invalid/sign-in',
    });
    expect(parsed?.samlConfig.issuer).not.toBe(idp.issuer);
  });
  it.each([
    'doctype',
    'entity',
    'http',
    'credentials',
    'duplicateEndpoint',
    'duplicateAuthority',
    'foreignNamespace',
    'missingCertificate',
    'malformed',
    'oversize',
  ] as const)('refuses unsafe or ambiguous metadata: %s', (kind) => {
    let xml = idp.metadata;
    if (kind === 'doctype')
      xml = '<!DOCTYPE root SYSTEM "https://never-fetch.invalid/entity">' + xml;
    if (kind === 'entity') xml = '<!ENTITY secret SYSTEM "file:///never-read">' + xml;
    if (kind === 'http')
      xml = xml.replace(
        'https://generated-idp.example.invalid/sign-in',
        'http://generated-idp.example.invalid/sign-in',
      );
    if (kind === 'credentials')
      xml = xml.replace(
        'https://generated-idp.example.invalid/sign-in',
        'https://user:password@generated-idp.example.invalid/sign-in',
      );
    if (kind === 'duplicateEndpoint')
      xml = xml.replace(
        '</md:IDPSSODescriptor>',
        xml.match(/<md:SingleSignOnService[^>]+\/>/)![0] + '</md:IDPSSODescriptor>',
      );
    if (kind === 'duplicateAuthority')
      xml = xml.replace(
        '</md:EntityDescriptor>',
        '<md:EntityDescriptor entityID="https://other.invalid"/></md:EntityDescriptor>',
      );
    if (kind === 'foreignNamespace')
      xml = xml.replace(
        'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"',
        'xmlns:md="https://foreign.invalid"',
      );
    if (kind === 'missingCertificate')
      xml = xml.replace(/<md:KeyDescriptor[\s\S]*?<\/md:KeyDescriptor>/, '');
    if (kind === 'malformed') xml = xml.replace('</md:EntityDescriptor>', '');
    if (kind === 'oversize') xml += ' '.repeat(MAX_SAML_METADATA_BYTES);
    expect(parseSamlMetadata(xml, 'https://ensemus.example.invalid', 'generated')).toBeNull();
  });
  it('never stores bad metadata and stores only parsed provider configuration with separate SP and IdP issuers', async () => {
    const store = vi.fn(async (_input: { issuer: string; samlConfig: string }) => {}),
      operations = createSsoOperations({
        baseURL: 'https://ensemus.example.invalid',
        store,
        remove: vi.fn(async () => {}),
        provider: async () => null,
        verifiedSession: async () => null,
      });
    expect(
      await operations.storeProvider({
        providerId: 'generated',
        domain: 'example.invalid',
        idpMetadataXml: '<!DOCTYPE bad>',
      }),
    ).toBe('invalid_metadata');
    expect(store).not.toHaveBeenCalled();
    expect(
      await operations.storeProvider({
        providerId: 'generated',
        domain: 'example.invalid',
        idpMetadataXml: idp.metadata,
      }),
    ).toBe('stored');
    const record = store.mock.calls[0]![0] as unknown as { issuer: string; samlConfig: string };
    expect(record.issuer).toContain('/api/auth/sso/saml2/sp/metadata');
    expect(JSON.parse(record.samlConfig).idpMetadata.entityID).toBe(idp.issuer);
    expect(record.samlConfig).not.toContain('<md:');
  });
  it('closes every installed mutation/domain route, and does not expose tenant OIDC callbacks', () => {
    expect(SSO_DISABLED_PATHS).toEqual(
      expect.arrayContaining([
        '/sso/register',
        '/sso/update-provider',
        '/sso/delete-provider',
        '/sso/request-domain-verification',
        '/sso/verify-domain',
        '/sso/callback/:providerId',
      ]),
    );
  });
  it('keeps SP issuer distinct from the signed IdP issuer and binds its exact authentication configuration', () => {
    const config = parseSamlMetadata(
        idp.metadata,
        'https://ensemus.example.invalid',
        'generated',
      )!.samlConfig,
      provider = {
        providerId: 'generated',
        issuer: config.issuer,
        domain: 'example.invalid',
        samlConfig: JSON.stringify(config),
      };
    expect(ssoIdpIssuer(provider)).toBe(idp.issuer);
    expect(ssoBoundary(provider)).not.toBe(ssoBoundary({ ...provider, domain: 'other.invalid' }));
    expect(ssoBoundary(provider)).not.toBe(
      ssoBoundary({
        ...provider,
        samlConfig: JSON.stringify({
          ...config,
          idpMetadata: { entityID: 'https://other.invalid' },
        }),
      }),
    );
    expect(ssoIdpIssuer({ samlConfig: null })).toBeNull();
    const reordered = Object.fromEntries(Object.entries(config).reverse());
    expect(ssoBoundary({ ...provider, samlConfig: JSON.stringify(reordered) })).toBe(
      ssoBoundary(provider),
    );
  });
  it('isolates concurrent request-local assertion handoffs and refuses calls without an active verified request', async () => {
    const record = vi.fn(async (_input: { externalSubject: string; sessionId: string }) => true),
      flow = createSamlFlow(record);
    const identity = {
      providerId: 'generated',
      issuer: 'https://idp.invalid',
      externalSubject: 'generated-subject',
      email: 'generated@example.invalid',
      userId: randomUUID(),
      boundary: 'a'.repeat(64),
    };
    expect(() => flow.verified(identity)).toThrow();
    expect(await flow.confirm({ ...identity, sessionId: 'outside' })).toBe(false);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        flow.run(
          async () => {
            const current = {
                ...identity,
                externalSubject: `subject-${index}`,
                userId: randomUUID(),
              },
              sessionId = `session-${index}`;
            flow.verified(current);
            await Promise.resolve();
            expect(await flow.confirm({ ...current, sessionId, providerId: 'wrong' })).toBe(false);
            expect(await flow.confirm({ ...current, sessionId, userId: 'wrong' })).toBe(false);
            expect(await flow.confirm({ ...current, sessionId })).toBe(true);
          },
          {
            issuer: identity.issuer,
            subject: `subject-${index}`,
            authenticatedAt: Date.now(),
            bodySha256: 'b'.repeat(64),
          },
        ),
      ),
    );
    expect(record).toHaveBeenCalledTimes(8);
    for (const [value] of record.mock.calls)
      expect(value.sessionId).toBe(value.externalSubject.replace('subject', 'session'));
    expect(() => flow.verified(identity)).toThrow();
  });
  it.each(['doctype', 'entity', 'utf16', 'oversize', 'duplicate'] as const)(
    'refuses unsafe assertion envelopes before the cryptographic verifier: %s',
    async (kind) => {
      const url = 'https://ensemus.example.invalid/api/auth/sso/saml2/sp/acs/generated';
      let xml = '<Response/>';
      if (kind === 'doctype')
        xml = '<!DOCTYPE Response SYSTEM "https://never-fetch.invalid">' + xml;
      if (kind === 'entity') xml = '<!ENTITY secret SYSTEM "file:///never-read">' + xml;
      if (kind === 'utf16') xml = '\0<Response/>';
      if (kind === 'oversize') xml = 'x'.repeat(256 * 1024);
      const fields = new URLSearchParams({ SAMLResponse: Buffer.from(xml).toString('base64') });
      if (kind === 'duplicate') fields.append('SAMLResponse', 'second');
      const result = await guardSamlRequest(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: fields,
        }),
      );
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
    },
  );
  it('captures an untrusted assertion envelope and preserves its exact POST body for the real verifier', async () => {
    const xml = `<p:Response xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion"><a:Assertion><a:Issuer>https://idp.invalid</a:Issuer><a:Subject><a:NameID>subject</a:NameID></a:Subject><a:AuthnStatement AuthnInstant="${new Date(Date.now() - 1000).toISOString()}"/></a:Assertion></p:Response>`;
    const body = new URLSearchParams({
      SAMLResponse: Buffer.from(xml).toString('base64'),
      RelayState: 'opaque',
    }).toString();
    const result = await guardSamlRequest(
      new Request('https://ensemus.example.invalid/api/auth/sso/saml2/sp/acs/generated', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error('Envelope refused');
    expect(await result.request.text()).toBe(body);
    expect(result.envelope).toMatchObject({
      issuer: 'https://idp.invalid',
      subject: 'subject',
      bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
