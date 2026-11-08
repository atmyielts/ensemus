import { createRequire } from 'node:module';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { generatedSamlIdp } from '../helpers/saml-idp';
import { guardSamlRequest } from '../../packages/auth/src/sso-request';

const { IdentityProvider, ServiceProvider, SamlLib } = createRequire(import.meta.url)(
  'samlify',
) as typeof import('samlify');
const metadata = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://generated-sp.example.invalid"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="true"><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://generated-sp.example.invalid/acs" index="0" isDefault="true"/></md:SPSSODescriptor></md:EntityDescriptor>`;

describe('generated SAML provider uses actual request validation and assertion signing', () => {
  it('answers a real redirect request with a verifiable correlated assertion', async () => {
    const generated = await generatedSamlIdp(),
      idp = IdentityProvider({ metadata: generated.metadata }),
      sp = ServiceProvider({ metadata }),
      request = sp.createLoginRequest(idp, 'redirect'),
      answer = await generated.response(request.context, metadata, 'generated@example.invalid'),
      xml = Buffer.from(answer.SAMLResponse, 'base64').toString('utf8');
    expect(xml).toContain(`InResponseTo="${request.id}"`);
    expect(xml).toContain('Destination="https://generated-sp.example.invalid/acs"');
    expect(
      SamlLib.verifySignature(xml, {
        metadata: idp.entityMeta,
        allowedSignatureAlgorithms: ['http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'],
      })[0],
    ).toBe(true);
    const guarded = await guardSamlRequest(
      new Request('https://generated-sp.example.invalid/api/auth/sso/saml2/sp/acs/generated', {
        method: 'POST',
        body: new URLSearchParams({
          SAMLResponse: answer.SAMLResponse,
          RelayState: answer.RelayState,
        }),
      }),
    );
    expect(guarded).not.toBeInstanceOf(Response);
    if (guarded instanceof Response) throw new Error('GENERATED_VALID_ASSERTION_REFUSED');
    expect(guarded.envelope).toMatchObject({
      issuer: generated.issuer,
      subject: 'generated@example.invalid',
      authenticatedAt: expect.any(Number),
    });
  });

  it('refuses well-formed XML that violates the actual SAML request schema', async () => {
    const generated = await generatedSamlIdp(),
      idp = IdentityProvider({ metadata: generated.metadata }),
      request = ServiceProvider({ metadata }).createLoginRequest(idp, 'redirect'),
      url = new URL(request.context),
      xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString(
        'utf8',
      ),
      invalid = xml.replace(
        /(<\/(?:\w+:)?AuthnRequest>)$/,
        '<unexpected xmlns="urn:generated:invalid"/>$1',
      );
    expect(invalid).not.toBe(xml);
    url.searchParams.set('SAMLRequest', deflateRawSync(invalid).toString('base64'));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        generated.response(url.href, metadata, 'generated@example.invalid'),
      ).rejects.toThrow('ERR_INVALID_XML');
    } finally {
      diagnostic.mockRestore();
    }
  });
});
