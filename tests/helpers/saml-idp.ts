// Generated, in-process IdP. Real pinned samlify signing/parsing, no listener, hosted account or key.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { generate } from 'selfsigned';
// Pinned samlify is CommonJS with getter exports; load its actual module identically in native
// ESM, Playwright and tsx/Vitest transforms. No default/namespace interop heuristic.
const { IdentityProvider, ServiceProvider, SamlLib } = createRequire(import.meta.url)(
  'samlify',
) as typeof import('samlify');
const SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const esc = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
export async function generatedSamlIdp(options: { issuer?: string; keySize?: number } = {}) {
  const pems = await generate([{ name: 'commonName', value: 'generated-idp.example.invalid' }], {
    algorithm: 'sha256',
    keyType: 'rsa',
    keySize: options.keySize ?? 2048,
    notBeforeDate: new Date(Date.now() - 60000),
    notAfterDate: new Date(Date.now() + 86400000),
  });
  const issuer = options.issuer ?? `https://generated-idp.example.invalid/${randomUUID()}`;
  const endpoint = 'https://generated-idp.example.invalid/sign-in';
  const certificate = pems.cert.replace(/-----[^-]+-----|\s/g, '');
  const metadata = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${esc(issuer)}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${endpoint}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
  const idp = IdentityProvider({
    metadata,
    privateKey: pems.private,
    signingCert: pems.cert,
    wantAuthnRequestsSigned: false,
    requestSignatureAlgorithm: SHA256,
  });
  return {
    metadata,
    issuer,
    certificate: pems.cert,
    async response(
      authorizationURL: string,
      spMetadata: string,
      email: string,
      options: {
        subject?: string;
        issuer?: string;
        requestId?: string;
        noInResponseTo?: boolean;
        unsigned?: boolean;
        expired?: boolean;
        audience?: string;
        role?: string;
        algorithm?: string;
        authenticatedAt?: number | null;
      } = {},
    ) {
      const sp = ServiceProvider({ metadata: spMetadata }),
        url = new URL(authorizationURL);
      const request = await idp.parseLoginRequest(sp, 'redirect', {
        query: Object.fromEntries(url.searchParams),
      });
      const requestId = options.requestId ?? request.extract.request?.id;
      if (typeof requestId !== 'string') throw new Error('GENERATED_REQUEST_MISSING');
      const assertionId = `_${randomUUID()}`,
        responseId = `_${randomUUID()}`,
        subject = options.subject ?? email;
      const now = Date.now(),
        issue = new Date(now - 1000).toISOString(),
        before = new Date(now - (options.expired ? 900000 : 10000)).toISOString(),
        after = new Date(now + (options.expired ? -600000 : 300000)).toISOString();
      const authentication =
        options.authenticatedAt === null
          ? ''
          : ` AuthnInstant="${new Date(options.authenticatedAt ?? now - 1000).toISOString()}"`;
      const destination = sp.entityMeta.getAssertionConsumerService(
        'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
      );
      if (typeof destination !== 'string') throw new Error('GENERATED_ACS_MISSING');
      const correlation = options.noInResponseTo ? '' : ` InResponseTo="${esc(requestId)}"`;
      const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${issue}" Destination="${esc(destination)}"${correlation}><saml:Issuer>${esc(options.issuer ?? issuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${issue}"><saml:Issuer>${esc(options.issuer ?? issuer)}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${esc(subject)}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData Recipient="${esc(destination)}" NotOnOrAfter="${after}"${correlation}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${before}" NotOnOrAfter="${after}"><saml:AudienceRestriction><saml:Audience>${esc(options.audience ?? sp.entityMeta.getEntityID())}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${issue}" SessionIndex="${responseId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${esc(email)}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Generated SAML person</saml:AttributeValue></saml:Attribute><saml:Attribute Name="role"><saml:AttributeValue>${esc(options.role ?? 'owner')}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
      const withAuthn = xml.replace(`AuthnInstant="${issue}"`, authentication.trim());
      const signed = options.unsigned
        ? withAuthn
        : SamlLib.constructSAMLSignature({
            rawSamlMessage: withAuthn,
            privateKey: pems.private,
            signingCert: pems.cert,
            signatureAlgorithm: options.algorithm ?? SHA256,
            isBase64Output: false,
            referenceTagXPath: "/*[local-name(.)='Response']/*[local-name(.)='Assertion']",
            signatureConfig: {
              prefix: 'ds',
              location: {
                reference:
                  "/*[local-name(.)='Response']/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
                action: 'after',
              },
            },
          });
      return {
        SAMLResponse: Buffer.from(signed, 'utf8').toString('base64'),
        RelayState: url.searchParams.get('RelayState') ?? '',
        assertionId,
        subject,
        email,
        issuer,
      };
    },
  };
}
export function tamperSaml(encoded: string, change: (xml: string) => string) {
  return Buffer.from(change(Buffer.from(encoded, 'base64').toString('utf8')), 'utf8').toString(
    'base64',
  );
}
