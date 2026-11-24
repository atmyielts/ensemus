// The one process that holds the role that crosses tenants (ADR-035 D2). It polls only the federation queue
// and runs no workflows. It runs only where an operator turned cross-organization work on, under the
// `federation` profile. It holds no connector credential and no sealing key, and has no route out.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTenancyConfig, readSecret } from '@ensemus/config';
import {
  claimFederationCopy,
  loadFederationCopyState,
  loadGrantPartiesForWorker,
  observeFederationCopy,
  prepareFederationSenderFile,
  loadItemGrantForWorker,
  recordItemReceived,
  removeWithdrawnItem,
  settleGrantEndForTenant,
} from '@ensemus/application';
import { openAppDatabase } from '@ensemus/database';
import {
  federationBridgeReady,
  federationSenderReady,
  openBridgeDatabase,
} from '@ensemus/database/federation';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { FEDERATION_TASK_QUEUE } from '@ensemus/workflows/constants';
import { createFederationActivities } from '@ensemus/workflows/federation-activities';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';

const log = createLogger('federation-worker');
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Must run first. The SDK's default logger would print activity error messages.
  Runtime.install({
    logger: createTemporalLogger(log),
    telemetryOptions: { logging: { filter: 'WARN', forward: {} } },
  });
  // Started by mistake on a deployment with this off, it stops here and holds nothing open.
  if (!loadTenancyConfig().crossOrgEnabled) {
    log.error('federation_worker.not_enabled');
    process.exit(1);
  }
  const app = openAppDatabase(readSecret('DATABASE_URL_APP'));
  const bridge = openBridgeDatabase(readSecret('DATABASE_URL_FEDERATION'));
  const store = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  });
  // Probe with no business record in scope. The first heartbeat means all three dependencies
  // accepted the production role bindings and the provider can prove physical deletion.
  if (!(await federationSenderReady(app.db))) {
    log.error('federation_worker.sender_database_not_ready');
    process.exit(1);
  }
  if (!(await federationBridgeReady(bridge.db))) {
    log.error('federation_worker.bridge_database_not_ready');
    process.exit(1);
  }
  await store.assertPurgeCapability();
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
  });
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: FEDERATION_TASK_QUEUE,
    activities: createFederationActivities({
      bridge: bridge.db,
      store,
      followUp: {
        prepareSenderFile: (context, item) =>
          prepareFederationSenderFile(app.db, store, context, item),
        loadFileCopy: (context, target) => loadFederationCopyState(app.db, context, target),
        claimFileCopy: (context, target) => claimFederationCopy(app.db, context, target),
        observeFileCopy: (context, target, proof) =>
          observeFederationCopy(app.db, context, target, proof),
        loadItemGrant: (context, itemId) => loadItemGrantForWorker(app.db, context, itemId),
        recordItemReceived: (context, itemId) => recordItemReceived(app.db, context, { itemId }),
        loadGrantParties: (context, grantId) => loadGrantPartiesForWorker(app.db, context, grantId),
        settleGrantEnd: (context, input) => settleGrantEndForTenant(app.db, store, context, input),
        removeWithdrawnItem: (context, itemId) =>
          removeWithdrawnItem(app.db, store, context, itemId),
      },
    }),
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

  log.info('federation_worker.started', { taskQueue: FEDERATION_TASK_QUEUE });
  await worker.run();
  log.info('federation_worker.stopped');
  await app.close();
  await bridge.close();
  await connection.close();
}

main().catch((error: unknown) => {
  log.error('federation_worker.crashed', { errorCode: errorCode(error) });
  process.exit(1);
});
