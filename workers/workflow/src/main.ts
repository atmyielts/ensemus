// A separate process from the web tier (ADR-016). It serves no HTTP; it only polls Temporal.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { createActivities, type WorkflowProbe } from '@ensemus/workflows/activities';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { PLATFORM_TASK_QUEUE, TEMPORAL_CHANNEL_ARGS } from '@ensemus/workflows/constants';
import { createExternalActionPlatformActivities } from '@ensemus/workflows/external-action-activities';
import { createObjectMigrationActivities } from '@ensemus/workflows/object-migration-activities';
import { createProcessRunActivities } from '@ensemus/workflows/process-run-activities';
import { createSimulationActivities } from '@ensemus/workflows/simulation-activities';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { workflowIdFor } from '@ensemus/workflows/schemas';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';

import { workerProductPorts } from './product-ports';

const log = createLogger('worker');
const here = path.dirname(fileURLToPath(import.meta.url));
/** One slow answer about one run may not hold up the sweep it is part of. */
const PROBE_DEADLINE_MS = 5_000;

async function main() {
  // Must run first. The SDK's default logger would print activity error messages.
  Runtime.install({
    logger: createTemporalLogger(log),
    telemetryOptions: { logging: { filter: 'WARN', forward: {} } },
  });
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
  });
  const { db, close } = openAppDatabase(readSecret('DATABASE_URL_APP'));
  const store = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  });
  // Reads only whether a run is open, so it needs no payload codec.
  const clientConnection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
    channelArgs: TEMPORAL_CHANNEL_ARGS,
  });
  const client = new Client({
    connection: clientConnection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  });
  const probeWorkflow: WorkflowProbe = async (input) => {
    try {
      const { status } = await clientConnection.withDeadline(Date.now() + PROBE_DEADLINE_MS, () =>
        client.workflow.getHandle(workflowIdFor(input), input.runId).describe(),
      );
      return status.name === 'RUNNING' ? 'open' : 'closed';
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return 'closed';
      // Not knowing is no reason to fail someone's work. The next sweep asks again.
      log.warn('worker.probe_failed', { errorCode: errorCode(error) });
      return 'open';
    }
  };
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: PLATFORM_TASK_QUEUE,
    workflowBundle: { codePath: path.join(here, 'workflow-bundle.cjs') },
    activities: {
      ...createActivities({ database: db, store, probeWorkflow }),
      // Only what reads PostgreSQL. Anything holding a credential is on the connector queue.
      ...createExternalActionPlatformActivities({ database: db }),
      // M7 (ADR-031). None of these holds a credential, or calls anything outside PostgreSQL.
      ...createSimulationActivities({ database: db }),
      ...createProcessRunActivities({ database: db, ports: workerProductPorts() }),
      ...createObjectMigrationActivities({ database: db }),
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

  log.info('worker.started', { taskQueue: PLATFORM_TASK_QUEUE });
  await worker.run();
  log.info('worker.stopped');
  await close();
  await clientConnection.close();
  await connection.close();
}

main().catch((error: unknown) => {
  log.error('worker.crashed', { errorCode: errorCode(error) });
  process.exit(1);
});
