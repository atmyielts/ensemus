import 'server-only';
import { createRestoreGate } from '@ensemus/application';
import { createAuth, type OidcProvider } from '@ensemus/auth';
import { loadWebConfig, readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';
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
  const { auth, redeemSetupToken, submitCredentials } = createAuth({
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
    submitCredentials,
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

/** A slow store costs a tenant's first request this long at most, and then the check is remembered. */
const GATE_REQUEST_MS = 2_000;
let restoreGate: ReturnType<typeof createRestoreGate> | undefined;

/** Refuses a tenant while its database is behind the tombstone ledger (ADR-026). */
export function getRestoreGate() {
  if (!restoreGate) {
    const { app, log } = getRuntime();
    restoreGate = createRestoreGate({
      database: app,
      store: new S3ObjectStore({
        endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
        bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
        accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
        secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
        requestTimeoutMs: GATE_REQUEST_MS,
        maxAttempts: 1,
      }),
      onCheckFailed: (error) =>
        log.warn('restore_gate.check_failed', { errorCode: errorCode(error) }),
      onClosed: (organizationId, count) =>
        log.error('restore_gate.closed', { organizationId, count }),
    });
  }
  return restoreGate;
}

/** Built on first use, so building the image needs no secrets and contains none. */
export function getRuntime() {
  runtime ??= build();
  return runtime;
}
