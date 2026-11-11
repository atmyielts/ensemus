// The one process that holds connector credentials and reads what strangers send (ADR-027 D5). It sits
// on an internal network alone: PostgreSQL, Temporal and the egress gateway, and no route anywhere else.
// It polls only the connector queue and runs no workflows. It runs only under the `connectors` profile.
import { createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSaasConfig, readSecret } from '@ensemus/config';
import { createEmailConnector } from '@ensemus/connectors/email';
import { createGoogleWorkspaceConnector } from '@ensemus/connectors/google';
import { createInboundConnector } from '@ensemus/connectors/inbound';
import { createMicrosoft365Connector } from '@ensemus/connectors/microsoft';
import { createProviderHttpClient } from '@ensemus/connectors/provider-http';
import { createConnectorRegistry } from '@ensemus/connectors/runtime';
import { openAppDatabase } from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { OAUTH_CALLBACK_PATH } from '@ensemus/domain/workspace-suites';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { sealSecret } from '@ensemus/secrets/seal';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { createConnectorSyncActivities } from '@ensemus/workflows/connector-sync-activities';
import { CONNECTOR_TASK_QUEUE } from '@ensemus/workflows/constants';
import { createExternalActionConnectorActivities } from '@ensemus/workflows/external-action-activities';
import { createKnowledgeConnectorActivities } from '@ensemus/workflows/knowledge-connector-activities';
import { createOAuthExchangeActivities } from '@ensemus/workflows/oauth-exchange-activities';
import { createPaymentConnectorActivities } from '@ensemus/workflows/payment-activities';
import { createSuiteReadActivities } from '@ensemus/workflows/suite-read-activities';
import { createSuiteUpkeepActivities } from '@ensemus/workflows/suite-upkeep-activities';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { createTaxActivities } from '@ensemus/workflows/tax-activities';
import { createWebhookActivities } from '@ensemus/workflows/webhook-activities';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import {
  connectorNetwork,
  platformOAuthClients,
  providerRoutes,
  suiteConnectorDeps,
  suiteMailIdDomain,
} from './connector-composition';
import { createPaymentRuntimeOptions } from './payment-composition';
import { createPaymentWebhookAttester } from './payment-webhook-attester';

const log = createLogger('connector-worker');
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Must run first. The SDK's default logger would print activity error messages.
  Runtime.install({
    logger: createTemporalLogger(log),
    telemetryOptions: { logging: { filter: 'WARN', forward: {} } },
  });
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
  });
  const app = openAppDatabase(readSecret('DATABASE_URL_APP'));
  const secretsDb = openSecretsDatabase(readSecret('DATABASE_URL_SECRETS'));
  const sealingKey = readSecret('SECRET_SEALING_PRIVATE_KEY');
  const secrets = new SecretBroker(secretsDb.db, new FileKeyProvider([sealingKey]));
  // Sealing needs only the public half. The exchange seals the credential it was given and never reads it back.
  const sealingPublicKeyPem = createPublicKey(sealingKey)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const http = createProviderHttpClient({ routes: providerRoutes() });
  const platformClients = platformOAuthClients();
  // A bad explicit Message-ID domain stops the worker here. With none, suite mail is refused unsent,
  // and nothing else is affected.
  const messageIdDomain = suiteMailIdDomain();
  if (!messageIdDomain) log.warn('connector_worker.mail_id_domain_missing', {});
  const suiteDeps = suiteConnectorDeps({
    database: app.db,
    secrets,
    http,
    platformClients,
    messageIdDomain,
  });
  const deps = {
    database: app.db,
    registry: createConnectorRegistry([
      createEmailConnector({
        tls: process.env.ENSEMUS_SMTP_TLS === 'none' ? 'none' : 'required',
        messageIdDomain: process.env.ENSEMUS_SMTP_MESSAGE_ID_DOMAIN ?? 'ensemus.invalid',
      }),
      createInboundConnector(),
      createGoogleWorkspaceConnector(suiteDeps),
      createMicrosoft365Connector(suiteDeps),
    ]),
    secrets,
    network: connectorNetwork(),
  };
  // M8 (ADR-032 D4). Nothing here until the owner chooses a processor and a tax provider, and both have been
  // through outside security review. So a charge is refused, and `get` answering null is what says why.
  const saas = loadSaasConfig();
  const paymentDeps = {
    ...deps,
    billingEnabled: saas.billingEnabled,
    paymentProcessor: saas.paymentProcessor,
    processors: { get: () => null },
    billingOrganizationId: saas.billingOrganizationId,
    billingConnectionId: saas.billingConnectionId,
    tax: null,
  };
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: CONNECTOR_TASK_QUEUE,
    activities: {
      ...createExternalActionConnectorActivities(deps),
      ...createWebhookActivities({
        ...deps,
        attestPaymentWebhook: createPaymentWebhookAttester(secretsDb.db),
        paymentWebhook: {
          billingOrganizationId: saas.billingOrganizationId,
          billingConnectionId: saas.billingConnectionId,
          processor: saas.paymentProcessor,
        },
      }),
      ...createConnectorSyncActivities(deps),
      ...createKnowledgeConnectorActivities(deps),
      ...createOAuthExchangeActivities({
        database: app.db,
        secrets,
        http,
        platformClients,
        seal: (input) => sealSecret({ ...input, publicKeyPem: sealingPublicKeyPem }),
        // Providers require the very redirect URI the authorize URL named, so it comes from the same
        // public origin the web tier builds it from. Without one every exchange fails with a code,
        // and nothing else here needs it, so an install that only sends email still starts.
        redirectUri: process.env.ENSEMUS_PUBLIC_URL
          ? `${process.env.ENSEMUS_PUBLIC_URL}${OAUTH_CALLBACK_PATH}`
          : '',
      }),
      ...createSuiteUpkeepActivities({ database: app.db, secrets }),
      // Agents' suite reads (ADR-038 D6). The agent workflow schedules this here by IDs, because only this
      // process holds the credential; the agent worker collects the output it writes.
      ...createSuiteReadActivities(deps),
      // No native processor is selected. The composition supplies real standing/broker ports while
      // dispatch stays unavailable; it never fills origin/merchant identity from manifest or empty config.
      ...createPaymentConnectorActivities(
        paymentDeps,
        createPaymentRuntimeOptions(paymentDeps, secretsDb.db),
      ),
      ...createTaxActivities(paymentDeps),
    },
    dataConverter: {
      payloadCodecs: [new AesGcmPayloadCodec(readSecret('TEMPORAL_CODEC_KEY'))],
      failureConverterPath: path.join(here, 'failure-converter.cjs'),
    },
  });

  // The container health check reads this file. Crashes stop updates, so they are never hidden.
  const beat = () => writeFileSync('/tmp/worker-alive', String(Date.now()));
  beat();
  const timer = setInterval(beat, 5_000);
  timer.unref();

  log.info('connector_worker.started', { taskQueue: CONNECTOR_TASK_QUEUE });
  await worker.run();
  log.info('connector_worker.stopped');
  await app.close();
  await secretsDb.close();
  await connection.close();
}

main().catch((error: unknown) => {
  log.error('connector_worker.crashed', { errorCode: errorCode(error) });
  process.exit(1);
});
