// The operator's live check of the Google Workspace and Microsoft 365 suite tools (ADR-038 D6), run once
// against a dedicated test tenant holding generated data only:
//   docker compose --profile connectors exec -e ENSEMUS_LIVE_CHECK=1 connector-worker \
//     node dist/live-suite-check.js --organization <uuid> --connection <uuid> [options]
//
// A WIRE-FORMAT CHECK, NOT A PRODUCT PATH. It calls the suite tools' handlers directly and so bypasses
// agents, proposals, approvals and the intent ledger on purpose: with --writes it makes drafts, events,
// edits and messages that nobody approved. That is why it refuses to start without ENSEMUS_LIVE_CHECK=1,
// refuses any connection whose name does not start with "TEST ", and is its own bundled entry that no
// other entry imports.
//
// Otherwise it is the connector worker: the same provider HTTP client over per-route gateways, the same
// SecretBroker lease of the connection's credential, the same operator apps and Message-ID domain, and the
// same createSuiteToolDispatch, runSend and runReconcile, under a service tenant context. It prints and
// writes codes and counts only (live-suite-check-core.ts). No token, secret or provider content is
// printed, logged or written.
import { writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { countDirectoryMatches } from '@ensemus/application';
import { loadLiveCheckConnection, syncedResourceIds } from '@ensemus/application/suite-live-check';
import { readSecret } from '@ensemus/config';
import { createGoogleWorkspaceConnector } from '@ensemus/connectors/google';
import { createMicrosoft365Connector } from '@ensemus/connectors/microsoft';
import { createProviderHttpClient } from '@ensemus/connectors/provider-http';
import { openAppDatabase } from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { createServiceContext } from '@ensemus/database/service';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { createLogger, errorCode } from '@ensemus/telemetry';
import {
  connectorNetwork,
  platformOAuthClients,
  providerRoutes,
  suiteConnectorDeps,
  suiteMailIdDomain,
} from './connector-composition';
import {
  connectionRefusal,
  LIVE_CHECK_ENV,
  LIVE_CHECK_USAGE,
  liveCheckEnabled,
  optionRefusal,
  parseLiveCheckArgs,
  recordingHttp,
  runLiveSuiteCheck,
} from './live-suite-check-core';

const log = createLogger('live-suite-check', (line) => process.stderr.write(`${line}\n`));
const REFUSED = 2;
/** Each read's deadline, as the worker's suite read has. */
const READ_DEADLINE_MS = 60_000;

const refuse = (reasonCode: string) => {
  log.error('live_suite_check.refused', { reasonCode });
  return REFUSED;
};

async function main(): Promise<number> {
  // Before anything is opened: the operator asked for this run on purpose.
  if (!liveCheckEnabled(process.env)) return refuse(`${LIVE_CHECK_ENV}_NOT_SET`);
  const parsed = parseLiveCheckArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(LIVE_CHECK_USAGE);
    return refuse(parsed.code);
  }
  const { options } = parsed;
  const { organizationId, connectionId } = options;

  const app = openAppDatabase(readSecret('DATABASE_URL_APP'));
  const secretsDb = openSecretsDatabase(readSecret('DATABASE_URL_SECRETS'));
  try {
    const context = createServiceContext(organizationId);
    const connection = await loadLiveCheckConnection(app.db, context, connectionId);
    const refusal =
      connectionRefusal(connection) ??
      (connection ? optionRefusal(options, connection.connectorType) : null);
    if (refusal || !connection?.credentialSecretId) return refuse(refusal ?? 'CONNECTION_INVALID');
    const secretId = connection.credentialSecretId;

    const secrets = new SecretBroker(
      secretsDb.db,
      new FileKeyProvider([readSecret('SECRET_SEALING_PRIVATE_KEY')]),
    );
    const recorder = recordingHttp(createProviderHttpClient({ routes: providerRoutes() }));
    const deps = suiteConnectorDeps({
      database: app.db,
      secrets,
      http: recorder.http,
      platformClients: platformOAuthClients(),
      messageIdDomain: suiteMailIdDomain(),
    });
    const connector =
      connection.connectorType === 'google_workspace'
        ? createGoogleWorkspaceConnector(deps)
        : createMicrosoft365Connector(deps);
    let config: unknown;
    try {
      config = connector.parseConfig(connection.config);
    } catch {
      return refuse('CONNECTION_CONFIG_INVALID');
    }
    const purpose = connector.manifest.credential.purpose;
    // One lease for the run, so reads share a token. Every change gets runSend's own wrapper over it.
    const credentials = {
      withCredential: <T>(use: (secret: Buffer) => Promise<T>): Promise<T> =>
        secrets.withSecret({ organizationId, secretId, purpose }, use),
    };
    const base = {
      organizationId,
      connectionId,
      config,
      grantedScopes: connection.grantedScopes,
      credentials,
      network: connectorNetwork(),
    };

    try {
      const report = await runLiveSuiteCheck(
        options,
        { connectorType: connection.connectorType, ownerKind: connection.ownerKind },
        {
          connector,
          readContext: () => ({
            ...base,
            signal: AbortSignal.timeout(READ_DEADLINE_MS),
            ownerKind: connection.ownerKind,
          }),
          actionContext: () => base,
          access:
            connection.ownerKind === 'organization'
              ? {
                  permitted: (externalIds) =>
                    syncedResourceIds(app.db, context, { connectionId, externalIds }),
                }
              : null,
          matchDirectoryEmails: (emails) => countDirectoryMatches(app.db, context, emails),
          take: recorder.take,
          write: (line) => process.stdout.write(`${line}\n`),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => new Date(),
          token: () => randomBytes(4).toString('hex'),
          uuid: () => randomUUID(),
        },
      );
      if (options.out) {
        writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      }
      return report.failures > 0 ? 1 : 0;
    } finally {
      connector.disposeAuthSession?.(credentials);
    }
  } finally {
    await app.close();
    await secretsDb.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log.error('live_suite_check.failed', { errorCode: errorCode(error) });
    process.exitCode = 1;
  },
);
