import 'server-only';
import { createAuth, type OidcProvider } from '@ensemus/auth';
import { loadWebConfig, readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { S3ObjectStore } from '@ensemus/storage';
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
  const { auth, redeemSetupToken } = createAuth({
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
    redeemSetupToken,
    app: openAppDatabase(readSecret('DATABASE_URL_APP')).db,
    log: createLogger('web'),
  };
}

let runtime: ReturnType<typeof build> | undefined;

let store: S3ObjectStore | undefined;

/** Object storage for artifacts. Bytes only ever pass through permission-checked services. */
export function getStore() {
  store ??= new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  });
  return store;
}

/** Built on first use, so building the image needs no secrets and contains none. */
export function getRuntime() {
  runtime ??= build();
  return runtime;
}
