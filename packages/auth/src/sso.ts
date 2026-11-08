// ADR-031 D9: browser-carried SAML only. Metadata is parsed in process, never downloaded.
import { X509Certificate } from 'node:crypto';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { sso, SignatureAlgorithm, DigestAlgorithm, type SAMLConfig, type SSOSAMLUserResolutionInput,type SSOUserResolutionContext,type SSOUserResolution } from '@better-auth/sso';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import { ssoBoundary, ssoIdpIssuer, trustedSamlProvider, type SamlCandidate } from './sso-flow';

export const MAX_SAML_METADATA_BYTES = 100 * 1024;
const MD = 'urn:oasis:names:tc:SAML:2.0:metadata',
  DS = 'http://www.w3.org/2000/09/xmldsig#',
  SAML = 'urn:oasis:names:tc:SAML:2.0:protocol';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const invalid = () => new Error('SSO_METADATA_INVALID');
function children(parent: Element, namespace: string, localName: string): Element[] {
  const result: Element[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling)
    if (child.nodeType === 1) {
      const element = child as Element;
      if (element.localName === localName) {
        if (element.namespaceURI !== namespace) throw invalid();
        result.push(element);
      }
    }
  return result;
}
function https(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      !url.hostname ||
      value.trim() !== value
    )
      throw invalid();
    return url.href;
  } catch {
    throw invalid();
  }
}
/** Fail closed on ambiguous/nested metadata and every parser diagnostic. No generic XML fallback. */
export function parseSamlMetadata(
  xml: string,
  baseURL: string,
  providerId: string,
): { issuer: string; samlConfig: SAMLConfig } | null {
  try {
    if (
      typeof xml !== 'string' ||
      !xml ||
      Buffer.byteLength(xml, 'utf8') > MAX_SAML_METADATA_BYTES ||
      /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) ||
      xml.includes('\0')
    )
      return null;
    const document = new DOMParser({
      locator: false,
      onError: () => {
        throw invalid();
      },
    }).parseFromString(xml, 'application/xml');
    if (document.doctype) return null;
    const root = document.documentElement;
    if (!root || root.namespaceURI !== MD || root.localName !== 'EntityDescriptor') return null;
    const issuer = root.getAttribute('entityID');
    if (
      !issuer ||
      issuer.length > 2048 ||
      /\s/.test(issuer) ||
      [...issuer].some((character) => character.charCodeAt(0) < 32)
    )
      return null;
    const identifier = new URL(issuer);
    if (
      !['http:', 'https:', 'urn:'].includes(identifier.protocol) ||
      identifier.username ||
      identifier.password ||
      (identifier.protocol === 'urn:' && !/^urn:[a-z0-9][a-z0-9-]{0,31}:.+/i.test(issuer))
    )
      return null;
    // Iterative bounds also reject nested authorities and foreign namespace lookalikes.
    const pending: { element: Element; depth: number }[] = [{ element: root, depth: 1 }];
    let nodes = 0;
    while (pending.length) {
      const current = pending.pop()!;
      if (++nodes > 2048 || current.depth > 32) return null;
      if (
        current.element !== root &&
        ['EntityDescriptor', 'EntitiesDescriptor'].includes(current.element.localName ?? '')
      )
        return null;
      for (let child = current.element.firstChild; child; child = child.nextSibling)
        if (child.nodeType === 1)
          pending.push({ element: child as Element, depth: current.depth + 1 });
    }
    const descriptors = children(root, MD, 'IDPSSODescriptor');
    if (descriptors.length !== 1) return null;
    const descriptor = descriptors[0]!;
    if (!(descriptor.getAttribute('protocolSupportEnumeration') ?? '').split(/\s+/).includes(SAML))
      return null;
    const endpoints = children(descriptor, MD, 'SingleSignOnService');
    if (!endpoints.length || endpoints.length > 2) return null;
    const redirect = endpoints.filter((endpoint) => endpoint.getAttribute('Binding') === REDIRECT);
    if (redirect.length !== 1) return null;
    const bindings = new Set<string>();
    for (const endpoint of endpoints) {
      const binding = endpoint.getAttribute('Binding') ?? '';
      if (![REDIRECT, POST].includes(binding) || bindings.has(binding)) return null;
      bindings.add(binding);
      https(endpoint.getAttribute('Location') ?? '');
    }
    for (const endpoint of children(descriptor, MD, 'SingleLogoutService'))
      https(endpoint.getAttribute('Location') ?? '');
    const certificates: string[] = [];
    for (const key of children(descriptor, MD, 'KeyDescriptor')) {
      const use = key.getAttribute('use');
      if (use && use !== 'signing' && use !== 'encryption') return null;
      if (use === 'encryption') continue;
      const infos = children(key, DS, 'KeyInfo');
      if (infos.length !== 1) return null;
      const data = children(infos[0]!, DS, 'X509Data');
      if (data.length !== 1) return null;
      const values = children(data[0]!, DS, 'X509Certificate');
      if (values.length !== 1) return null;
      const encoded = (values[0]!.textContent ?? '').replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 16384) return null;
      const certificate = new X509Certificate(Buffer.from(encoded, 'base64'));
      if (
        certificate.publicKey.asymmetricKeyType !== 'rsa' ||
        (certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        return null;
      if (
        new Date(certificate.validFrom).getTime() > Date.now() ||
        new Date(certificate.validTo).getTime() <= Date.now()
      )
        return null;
      if (certificates.includes(certificate.toString())) return null;
      certificates.push(certificate.toString());
    }
    if (!certificates.length || certificates.length > 4) return null;
    const spIssuer = new URL(
      `/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`,
      baseURL,
    ).href;
    return {
      issuer,
      samlConfig: {
        issuer: spIssuer,
        audience: spIssuer,
        entryPoint: https(redirect[0]!.getAttribute('Location') ?? ''),
        cert: certificates,
        idpMetadata: {
          entityID: issuer,
          cert: certificates,
          singleSignOnService: endpoints.map((endpoint) => ({
            Binding: endpoint.getAttribute('Binding')!,
            Location: https(endpoint.getAttribute('Location')!),
          })),
        },
        wantAssertionsSigned: true,
        authnRequestsSigned: false,
        signatureAlgorithm: SignatureAlgorithm.RSA_SHA256,
        digestAlgorithm: DigestAlgorithm.SHA256,
        callbackUrl: new URL('/sso/complete', baseURL).href,
      },
    };
  } catch {
    return null;
  }
}

export type VerifiedSsoIdentity = {
  providerId: string;
  issuer: string;
  externalSubject: string;
  email: string;
};
export type SsoCallbacks = {
  authorizeIdentity: (input: VerifiedSsoIdentity) => Promise<boolean>;
  completeIdentity: (
    input: VerifiedSsoIdentity & { userId: string },
  ) => Promise<'member' | 'no_membership' | 'refused'>;
  currentPrimary: (input: VerifiedSsoIdentity & { userId: string }) => Promise<boolean>;
};
export type SsoProviderState = {
  providerId: string;
  issuer: string;
  domain: string;
  domainVerified: boolean;
  samlConfig: string | null;
};
function sameDomain(email: string, domain: string) {
  return (
    /^[^\s@]+@[^\s@]+$/.test(email) &&
    email.slice(email.lastIndexOf('@') + 1).toLowerCase() === domain
  );
}
export function ssoPlugins(options: {
  baseURL: string;
  callbacks?: SsoCallbacks;
  verified?: (input: SamlCandidate) => void;
  resolveBrowser?: (input:SSOSAMLUserResolutionInput,context:SSOUserResolutionContext,provider:SsoProviderState)=>Promise<SSOUserResolution>;
}): BetterAuthPlugin[] {
  return [
    sso({
      domainVerification: { enabled: true },
      providersLimit: 0,
      disableImplicitSignUp: false,
      trustEmailVerified: false,
      organizationProvisioning: { disabled: true },
      guardProviderMutation: async () => {
        throw new Error('SSO_PROVIDER_MUTATION_DISABLED');
      },
      saml: {
        enableInResponseToValidation: true,
        allowIdpInitiated: false,
        requireTimestamps: true,
        requestTTL: 300000,
        clockSkew: 60000,
        maxResponseSize: 256 * 1024,
        maxMetadataSize: MAX_SAML_METADATA_BYTES,
        enableSingleLogout: false,
        algorithms: {
          onDeprecated: 'reject',
          allowedSignatureAlgorithms: [SignatureAlgorithm.RSA_SHA256],
          allowedDigestAlgorithms: [DigestAlgorithm.SHA256],
        },
      },
      resolveUser: async (input, { database }) => {
        if (input.protocol !== 'saml' || !options.callbacks)
          return { action: 'reject', code: 'SSO_REFUSED' };
        const provider = await database.findOne<SsoProviderState>({
          model: 'ssoProvider',
          where: [{ field: 'providerId', value: input.providerId }],
        });
        if (
          !provider?.domainVerified ||
          !trustedSamlProvider(provider) ||
          ssoIdpIssuer(provider) !== input.accountKey.issuer ||
          !sameDomain(input.providerUser.email, provider.domain) ||
          !(await options.callbacks.authorizeIdentity({
            providerId: input.providerId,
            issuer: input.accountKey.issuer,
            externalSubject: input.accountKey.accountId,
            email: input.providerUser.email,
          }))
        )
          return { action: 'reject', code: 'SSO_REFUSED' };
        return options.resolveBrowser?options.resolveBrowser(input,{database},provider):{action:'reject',code:'SSO_REFUSED'};
      },
      provisionUserOnEveryLogin: true,
      provisionUser: async ({ user, userInfo, provider }) => {
        if (
          !options.callbacks ||
          !options.verified ||
          typeof userInfo.id !== 'string' ||
          typeof userInfo.email !== 'string' ||
          !provider.samlConfig ||
          !sameDomain(userInfo.email, provider.domain)
        )
          throw new APIError('FORBIDDEN', { code: 'SSO_REFUSED' });
        const state = {
            ...provider,
            samlConfig:
              typeof provider.samlConfig === 'string'
                ? provider.samlConfig
                : JSON.stringify(provider.samlConfig),
          },
          issuer = ssoIdpIssuer(state);
        if (!issuer) throw new APIError('FORBIDDEN', { code: 'SSO_REFUSED' });
        options.verified({
          providerId: provider.providerId,
          issuer,
          userId: user.id,
          externalSubject: userInfo.id,
          email: userInfo.email,
          boundary: ssoBoundary(state),
        });
      },
    }),
  ];
}
/** Provider mutation and domain claims have no public router path, including future internal callers. */
export const SSO_DISABLED_PATHS: readonly string[] = [
  '/sso/register',
  '/sso/update-provider',
  '/sso/delete-provider',
  '/sso/request-domain-verification',
  '/sso/verify-domain',
  '/sso/providers',
  '/sso/get-provider',
  '/sso/callback',
  '/sso/callback/:providerId',
  '/sso/saml2/sp/slo/:providerId',
  '/sso/saml2/logout/:providerId',
];
export type SsoDependencies = {
  baseURL: string;
  store: (input: {
    providerId: string;
    issuer: string;
    domain: string;
    samlConfig: string;
  }) => Promise<void>;
  remove: (providerId: string) => Promise<void>;
  provider: (providerId: string) => Promise<SsoProviderState | null>;
  verifiedSession: (input: {
    sessionId: string;
    userId: string;
  }) => Promise<(VerifiedSsoIdentity & { userId: string }) | null>;
};
export type SsoOperations = {
  storeProvider: (input: {
    providerId: string;
    domain: string;
    idpMetadataXml: string;
  }) => Promise<'stored' | 'invalid_metadata'>;
  removeProvider: (providerId: string) => Promise<void>;
  status: (providerId: string) => Promise<{ ready: boolean; configurationSha256: string | null }>;
  verifiedSession: SsoDependencies['verifiedSession'];
};
export function createSsoOperations(deps: SsoDependencies): SsoOperations {
  return {
    async storeProvider(input) {
      const parsed = parseSamlMetadata(input.idpMetadataXml, deps.baseURL, input.providerId);
      if (!parsed) return 'invalid_metadata';
      await deps.store({
        providerId: input.providerId,
        domain: input.domain,
        issuer: parsed.samlConfig.issuer,
        samlConfig: JSON.stringify(parsed.samlConfig),
      });
      return 'stored';
    },
    removeProvider: deps.remove,
    verifiedSession: deps.verifiedSession,
    async status(providerId) {
      const provider = await deps.provider(providerId);
      let configurationSha256: string | null = null;
      if (provider)
        try {
          configurationSha256 = ssoBoundary(provider);
        } catch {
          /* Unknown legacy configuration has no reviewable fingerprint. */
        }
      return {
        ready: !!provider?.domainVerified && trustedSamlProvider(provider),
        configurationSha256,
      };
    },
  };
}
