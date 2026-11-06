// Owned by the sso slice (ID-04). See docs/06-delivery/m7-slices.md and ADR-031 D9. SAML through
// `@better-auth/sso`. Provider registration is never reachable from the network: only `sso.storeProvider`
// writes one, after the application service checked the person asking.
import type { BetterAuthPlugin } from 'better-auth';

/** Empty until the slice lands, so nothing is mounted until then. */
export function ssoPlugins(_options: { baseURL: string }): BetterAuthPlugin[] {
  return [];
}

/**
 * The plugin's own routes that would let any signed-in person register, change or remove a provider. These
 * are switched off at the router, so `/api/auth/sso/register` is a 404. A test holds this list.
 */
export const SSO_DISABLED_PATHS: readonly string[] = [
  '/sso/register',
  '/sso/update-provider',
  '/sso/delete-provider',
  '/sso/request-domain-verification',
  '/sso/verify-domain',
];

export type SsoDependencies = {
  store: (input: {
    providerId: string;
    issuer: string;
    domain: string;
    samlConfig: string;
  }) => Promise<void>;
  remove: (providerId: string) => Promise<void>;
  recordAssurance: (input: {
    sessionId: string;
    userId: string;
    ssoProviderId: string;
  }) => Promise<void>;
};

export type SsoOperations = {
  /** Parses and checks the provider's metadata, refusing HTTP endpoints and weak signatures, then stores it. */
  storeProvider(input: {
    providerId: string;
    domain: string;
    idpMetadataXml: string;
  }): Promise<'stored' | 'invalid_metadata'>;
  removeProvider(providerId: string): Promise<void>;
};

export function createSsoOperations(_deps: SsoDependencies): SsoOperations {
  const notBuilt = async () => {
    throw new Error('NOT_IMPLEMENTED');
  };
  return { storeProvider: notBuilt, removeProvider: notBuilt };
}
