import 'server-only';
// The web tier's half of connecting Google Workspace and Microsoft 365 by consent (ADR-038 D1, D2). It can
// seal and cannot unseal, and it knows the operator's public client IDs, never their secrets. The routes
// and the connections page both go through here, so a rule holds whichever way someone arrives.
import {
  getAuthorization,
  startAuthorization,
  type OAuthAuthorizationView,
  type OAuthWebSide,
} from '@ensemus/application';
import { readSecret } from '@ensemus/config';
import type {
  OAuthAuthorizationDto,
  StartedOAuthAuthorizationDto,
  StartOAuthAuthorizationBody,
} from '@ensemus/contracts/workspace-suites';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { OAUTH_CALLBACK_PATH, type SuiteProvider } from '@ensemus/domain/workspace-suites';
import { storeSecret } from '@ensemus/secrets/seal';
import { assertConnectorsEnabled, assertManagesConnections } from './api';
import { getRuntime } from './runtime';

/**
 * Where an operator names their own app's client ID for each provider. Public values: the secret that
 * goes with each is set only on the connector worker. Unset means this deployment offers only a
 * customer's own app for that provider.
 */
const PLATFORM_CLIENT_ID_ENV: Readonly<Record<SuiteProvider, string>> = {
  google: 'ENSEMUS_GOOGLE_CLIENT_ID',
  microsoft: 'ENSEMUS_MICROSOFT_CLIENT_ID',
};

// Google's client IDs end in .apps.googleusercontent.com, and Microsoft's are GUIDs. Both fit this, and a
// value that does not is treated as unset rather than put into a URL.
const PUBLIC_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/;

export function platformClientId(provider: SuiteProvider): string | null {
  const value = process.env[PLATFORM_CLIENT_ID_ENV[provider]]?.trim();
  return value && PUBLIC_CLIENT_ID.test(value) ? value : null;
}

/** The one address providers send the admin back to. It has to match the registered one exactly. */
export const oauthRedirectUri = () => `${getRuntime().config.publicUrl}${OAUTH_CALLBACK_PATH}`;

/** The port the application's consent functions take, for this tenant and this person. */
export function oauthWebSide(database: AppDatabase, context: TenantContext): OAuthWebSide {
  return {
    async seal(purpose, plaintext) {
      try {
        const { secretRef } = await storeSecret(database, context, {
          publicKeyPem: readSecret('SECRET_SEALING_PUBLIC_KEY'),
          purpose,
          plaintext: plaintext.toString('utf8'),
        });
        return secretRef;
      } finally {
        // The string copy cannot be cleared, but the buffer can, so it does not wait for the collector.
        plaintext.fill(0);
      }
    },
    redirectUri: oauthRedirectUri(),
    platformClientId,
  };
}

/** The public shape of a consent attempt. Listed fields only: no state, verifier, code or secret. */
export function oauthAuthorizationDto(row: OAuthAuthorizationView): OAuthAuthorizationDto {
  return {
    id: row.id,
    connector_type: row.connectorType,
    display_name: row.displayName,
    client_kind: row.clientKind,
    capabilities: [...row.capabilities],
    scopes: [...row.scopes],
    status: row.status,
    error_code: row.errorCode,
    connection_id: row.connectionId,
    owner_membership_id: row.ownerMembershipId,
    started_by_membership_id: row.startedByMembershipId,
    expires_at: row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Starts a consent and answers where to send the admin's browser. Not idempotent by key on purpose: the
 * state is kept only as a hash, so a repeat could not answer the same address, and an attempt nobody
 * finishes simply expires in ten minutes.
 */
export async function beginAuthorization(
  database: AppDatabase,
  context: TenantContext,
  body: StartOAuthAuthorizationBody,
): Promise<StartedOAuthAuthorizationDto> {
  assertManagesConnections(context);
  // So no attempt can wait for a worker that is not coming.
  assertConnectorsEnabled();
  const client = body.client;
  const started = await startAuthorization(
    database,
    context,
    {
      connectorType: body.connector_type,
      displayName: body.display_name,
      config: body.config,
      capabilities: body.capabilities,
      client:
        client.kind === 'platform'
          ? { kind: 'platform' }
          : {
              kind: 'customer',
              clientId: client.client_id,
              clientSecret: client.client_secret,
              ...(client.tenant !== undefined ? { tenant: client.tenant } : {}),
            },
    },
    oauthWebSide(database, context),
  );
  const authorization = await getAuthorization(database, context, {
    authorizationId: started.authorizationId,
  });
  return {
    authorization: oauthAuthorizationDto(authorization),
    authorize_url: started.authorizeUrl,
  };
}
