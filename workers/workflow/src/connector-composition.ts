// How the connector worker reaches providers: one gateway per route, the operator's own OAuth apps, and the
// suite connectors' dependencies. Shared by connector-worker.ts and the operator's live suite check, so the
// check runs over exactly what the worker runs over. It reads configuration and mounted secrets only.
import { readSecret } from '@ensemus/config';
import type { ProviderHttpClient, ProviderRoute } from '@ensemus/connectors/knowledge';
import { createGatewayNetwork } from '@ensemus/connectors/runtime';
import {
  resolveMailIdDomain,
  type PlatformOAuthClient,
  type PlatformOAuthClients,
  type PlatformOAuthProvider,
} from '@ensemus/connectors/suites';
import type { AppDatabase } from '@ensemus/database';
import type { SecretBroker } from '@ensemus/secrets/broker';
import {
  createCredentialRotation,
  createGrantedScopesRecorder,
} from '@ensemus/workflows/oauth-exchange-activities';

/**
 * One gateway per provider route, each with the one target its operator set (ADR-027 D5, ADR-029 D11).
 * A route left unset has no way out, and a request on it answers PROVIDER_ROUTE_UNAVAILABLE.
 */
const ROUTE_GATEWAYS: Readonly<Record<Exclude<ProviderRoute, 'mcp_server'>, string>> = {
  google_api: 'ENSEMUS_EGRESS_GOOGLE_API',
  google_oauth: 'ENSEMUS_EGRESS_GOOGLE_OAUTH',
  google_gmail: 'ENSEMUS_EGRESS_GOOGLE_GMAIL',
  google_docs: 'ENSEMUS_EGRESS_GOOGLE_DOCS',
  google_sheets: 'ENSEMUS_EGRESS_GOOGLE_SHEETS',
  ms_graph: 'ENSEMUS_EGRESS_MS_GRAPH',
  ms_login: 'ENSEMUS_EGRESS_MS_LOGIN',
};

export function providerRoutes() {
  const routes: Partial<Record<ProviderRoute, ReturnType<typeof createGatewayNetwork>>> = {};
  for (const [route, variable] of Object.entries(ROUTE_GATEWAYS)) {
    const address = process.env[variable];
    if (address) routes[route as ProviderRoute] = createGatewayNetwork(address);
  }
  return routes;
}

/** The egress gateway every connector context names as its one way out. */
export const connectorNetwork = () =>
  createGatewayNetwork(process.env.ENSEMUS_EGRESS_GATEWAY ?? 'egress-gateway:2525');

/**
 * The operator's own apps (ADR-038 D2). The public client ID is plain configuration, and the secret is a
 * mounted secret read once here. This process is the only one that ever holds it: the web tier knows the
 * client ID alone. A provider with no client ID configured has no operator app on this deployment.
 */
export function platformOAuthClients(): PlatformOAuthClients {
  const clients = new Map<PlatformOAuthProvider, PlatformOAuthClient>();
  for (const [provider, prefix] of [
    ['google', 'ENSEMUS_OAUTH_GOOGLE'],
    ['microsoft', 'ENSEMUS_OAUTH_MICROSOFT'],
  ] as const) {
    const clientId = process.env[`${prefix}_CLIENT_ID`];
    if (clientId)
      clients.set(provider, {
        client_id: clientId,
        client_secret: readSecret(`${prefix}_CLIENT_SECRET`),
      });
  }
  return { get: (provider) => clients.get(provider) ?? null };
}

/**
 * The right-hand side of every suite mail's Message-ID (ADR-038 D6): the operator's
 * ENSEMUS_MAIL_ID_DOMAIN, else this deployment's public host. A bad explicit value throws, which stops the
 * worker. With neither it is null, and suite mail is refused unsent.
 */
export const suiteMailIdDomain = () =>
  resolveMailIdDomain({
    explicit: process.env.ENSEMUS_MAIL_ID_DOMAIN,
    publicUrl: process.env.ENSEMUS_PUBLIC_URL,
  });

/**
 * What both suite connectors are built with. Microsoft rotates the refresh token on every refresh. The new
 * one is resealed in place under the connection's existing secret ID (0562), because 0561 refuses a new
 * credential_secret_id from here.
 */
export function suiteConnectorDeps(input: {
  database: AppDatabase;
  secrets: SecretBroker;
  http: ProviderHttpClient;
  platformClients: PlatformOAuthClients;
  messageIdDomain: string | null;
}) {
  return {
    http: input.http,
    platformClients: input.platformClients,
    scopes: createGrantedScopesRecorder(input.database),
    rotation: createCredentialRotation(input.database, input.secrets),
    messageIdDomain: input.messageIdDomain,
  };
}
