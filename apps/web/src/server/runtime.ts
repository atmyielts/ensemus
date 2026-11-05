import 'server-only';
import { createAuth, type OidcProvider } from '@ensemus/auth';
import { loadWebConfig, readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { createLogger } from '@ensemus/telemetry';
import { nextCookies } from 'better-auth/next-js';

function loadOidc(): OidcProvider | undefined {
  const discoveryUrl = process.env.ENSEMUS_OIDC_DISCOVERY_URL;
  if (!discoveryUrl) return undefined;
  return {
    providerId: 'company-sso',
    discoveryUrl,
    clientId: readSecret('ENSEMUS_OIDC_CLIENT_ID'),
    clientSecret: readSecret('ENSEMUS_OIDC_CLIENT_SECRET'),
  };
}

function build() {
  const config = loadWebConfig();
  const oidc = loadOidc();
  const { auth } = createAuth({
    databaseUrl: readSecret('DATABASE_URL_AUTH'),
    secret: readSecret('AUTH_SECRET'),
    baseURL: config.publicUrl,
    allowSignup: config.allowSignup,
    ...(oidc ? { oidc } : {}),
    plugins: [nextCookies()],
  });
  return {
    config,
    auth,
    app: openAppDatabase(readSecret('DATABASE_URL_APP')).db,
    log: createLogger('web'),
  };
}

let runtime: ReturnType<typeof build> | undefined;

/** Built on first use, so building the image needs no secrets and contains none. */
export function getRuntime() {
  runtime ??= build();
  return runtime;
}
