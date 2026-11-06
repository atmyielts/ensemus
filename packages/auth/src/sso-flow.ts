// Ephemeral request-local handoff from verified provisioning to the actual newly-created session.
// No process map/cache, browser parameter or later GET can manufacture the accepted assertion fence.
import { AsyncLocalStorage } from 'node:async_hooks';
import { ssoConfigurationSha256 } from '@ensemus/database/auth';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';
import type { SsoProviderState, VerifiedSsoIdentity } from './sso';
import type { SamlEnvelope } from './sso-request';

export function ssoBoundary(
  provider: Pick<SsoProviderState, 'providerId' | 'issuer' | 'domain' | 'samlConfig'>,
): string {
  return ssoConfigurationSha256(provider);
}
/** SAML's IdP authority is separate from the provider row's SP issuer. New stored configs contain
 * the explicit namespace-checked entityID; unknown legacy attribution fails closed. */
export function ssoIdpIssuer(provider: Pick<SsoProviderState, 'samlConfig'>): string | null {
  try {
    const config =
      typeof provider.samlConfig === 'string'
        ? (JSON.parse(provider.samlConfig) as { idpMetadata?: { entityID?: unknown } })
        : provider.samlConfig;
    return config && typeof config.idpMetadata?.entityID === 'string'
      ? config.idpMetadata.entityID
      : null;
  } catch {
    return null;
  }
}
export function trustedSamlProvider(
  provider: Pick<SsoProviderState, 'issuer' | 'samlConfig'>,
): boolean {
  try {
    if (!provider.samlConfig) return false;
    const config = JSON.parse(provider.samlConfig) as {
      issuer?: unknown;
      wantAssertionsSigned?: unknown;
      signatureAlgorithm?: unknown;
      digestAlgorithm?: unknown;
      spMetadata?: unknown;
      entryPoint?: unknown;
      idpMetadata?: { entityID?: unknown; metadata?: unknown; cert?: unknown };
    };
    if (
      config.issuer !== provider.issuer ||
      config.wantAssertionsSigned !== true ||
      config.signatureAlgorithm !== 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' ||
      config.digestAlgorithm !== 'http://www.w3.org/2001/04/xmlenc#sha256' ||
      config.spMetadata !== undefined ||
      config.idpMetadata?.metadata !== undefined ||
      typeof config.idpMetadata?.entityID !== 'string' ||
      !config.idpMetadata.entityID ||
      typeof config.entryPoint !== 'string'
    )
      return false;
    const endpoint = new URL(config.entryPoint),
      cert = config.idpMetadata.cert;
    return (
      endpoint.protocol === 'https:' &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.hash &&
      Array.isArray(cert) &&
      cert.length > 0 &&
      cert.length <= 4 &&
      cert.every((value) => typeof value === 'string' && value.length > 0)
    );
  } catch {
    return false;
  }
}
export type AcceptedSaml = VerifiedSsoIdentity & {
  userId: string;
  boundary: string;
  authenticatedAt: number | null;
  bodySha256: string;
};
export type SamlCandidate = Omit<AcceptedSaml, 'authenticatedAt' | 'bodySha256'>;
export function createSamlFlow(
  record: (input: AcceptedSaml & { sessionId: string }) => Promise<boolean>,
) {
  const storage = new AsyncLocalStorage<{ accepted?: AcceptedSaml; envelope?: SamlEnvelope }>();
  const confirm = async (input: {
    providerId: string;
    userId: string;
    sessionId: string;
  }): Promise<boolean> => {
    const accepted = storage.getStore()?.accepted;
    if (!accepted || accepted.providerId !== input.providerId || accepted.userId !== input.userId)
      return false;
    return record({ ...accepted, sessionId: input.sessionId });
  };
  return {
    run<T>(operation: () => Promise<T>, envelope?: SamlEnvelope): Promise<T> {
      return storage.run(envelope ? { envelope } : {}, operation);
    },
    verified(input: SamlCandidate) {
      const scope = storage.getStore();
      if (
        !scope?.envelope ||
        scope.accepted ||
        scope.envelope.issuer !== input.issuer ||
        scope.envelope.subject !== input.externalSubject
      )
        throw new APIError('FORBIDDEN', { code: 'SSO_REFUSED' });
      scope.accepted = {
        ...input,
        authenticatedAt: scope.envelope.authenticatedAt,
        bodySha256: scope.envelope.bodySha256,
      };
    },
    confirm,
    candidate: () => storage.getStore()?.accepted ?? null,
    plugin: {
      id: 'ensemus-saml-session-proof',
      hooks: {
        after: [
          {
            matcher: (context) => context.path === '/sso/saml2/sp/acs/:providerId',
            handler: createAuthMiddleware(async (context) => {
              const session = context.context.newSession;
              if (context.method !== 'POST' || !session) return;
              let allowed = false;
              try {
                allowed =
                  typeof context.params?.providerId === 'string' &&
                  (await confirm({
                    providerId: context.params.providerId,
                    userId: session.user.id,
                    sessionId: session.session.id,
                  }));
              } catch {
                /* A refused/unknown proof never forwards the created session. */
              }
              if (!allowed) {
                context.context.responseHeaders?.delete('set-cookie');
                deleteSessionCookie(context, true);
                context.context.setNewSession(null);
                await context.context.internalAdapter
                  .deleteSession(session.session.token)
                  .catch(() => undefined);
                throw new APIError('FORBIDDEN', { code: 'SSO_REFUSED' });
              }
            }),
          },
        ],
      },
    } satisfies BetterAuthPlugin,
  };
}
