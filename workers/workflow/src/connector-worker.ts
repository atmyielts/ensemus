// The one process that holds connector credentials and reads what strangers send (ADR-027 D5). It sits
// on an internal network alone: PostgreSQL, Temporal and the egress gateway, and no route anywhere else.
// It polls only the connector queue and runs no workflows. It runs only under the `connectors` profile.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSaasConfig, readSecret } from '@ensemus/config';
import { createEmailConnector } from '@ensemus/connectors/email';
import { createInboundConnector } from '@ensemus/connectors/inbound';
import { createConnectorRegistry, createGatewayNetwork } from '@ensemus/connectors/runtime';
import { openAppDatabase } from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { createConnectorSyncActivities } from '@ensemus/workflows/connector-sync-activities';
import { CONNECTOR_TASK_QUEUE } from '@ensemus/workflows/constants';
import { createExternalActionConnectorActivities } from '@ensemus/workflows/external-action-activities';
import { createPaymentConnectorActivities } from '@ensemus/workflows/payment-activities';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { createTaxActivities } from '@ensemus/workflows/tax-activities';
import { createWebhookActivities } from '@ensemus/workflows/webhook-activities';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';

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
  const secrets = new SecretBroker(
    secretsDb.db,
    new FileKeyProvider([readSecret('SECRET_SEALING_PRIVATE_KEY')]),
  );
  const deps = {
    database: app.db,
    registry: createConnectorRegistry([
      createEmailConnector({
        tls: process.env.ENSEMUS_SMTP_TLS === 'none' ? 'none' : 'required',
        messageIdDomain: process.env.ENSEMUS_SMTP_MESSAGE_ID_DOMAIN ?? 'ensemus.invalid',
      }),
      createInboundConnector(),
    ]),
    secrets,
    network: createGatewayNetwork(process.env.ENSEMUS_EGRESS_GATEWAY ?? 'egress-gateway:2525'),
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
        ...(saas.billingEnabled
          ? {
              paymentWebhook: {
                billingOrganizationId: saas.billingOrganizationId,
                billingConnectionId: saas.billingConnectionId,
                processor: saas.paymentProcessor,
              },
            }
          : {}),
      }),
      ...createConnectorSyncActivities(deps),
      ...createPaymentConnectorActivities(paymentDeps),
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
