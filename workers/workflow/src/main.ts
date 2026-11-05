// A separate process from the web tier (ADR-016). It serves no HTTP; it only polls Temporal.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { createActivities } from '@ensemus/workflows/activities';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';

const log = createLogger('worker');
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
  const { db, close } = openAppDatabase(readSecret('DATABASE_URL_APP'));
  const store = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  });
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: PLATFORM_TASK_QUEUE,
    workflowBundle: { codePath: path.join(here, 'workflow-bundle.cjs') },
    activities: createActivities({ database: db, store }),
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
  await connection.close();
}

main().catch((error: unknown) => {
  log.error('worker.crashed', { errorCode: errorCode(error) });
  process.exit(1);
});
