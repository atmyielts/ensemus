// The process that reads what strangers wrote, and removes what was derived from it (ADR-029 D4). It holds
// no credential, no sealing key and no secrets role, and needs no route out: PostgreSQL, Temporal and the
// object store only. Parsing happens in worker threads below this. It polls only the knowledge queue and
// runs no workflows.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { KNOWLEDGE_TASK_QUEUE } from '@ensemus/workflows/constants';
import { createKnowledgeAnswerFallbackActivities } from '@ensemus/workflows/knowledge-answer-activities';
import { createKnowledgeIngestActivities } from '@ensemus/workflows/knowledge-ingest-activities';
import { createKnowledgePurgeActivities } from '@ensemus/workflows/knowledge-purge-activities';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { createKnowledgeRuntimePorts } from './knowledge-ports';

const log = createLogger('knowledge-worker');
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
  const store = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  });
  const deps = { database: app.db, store, ...createKnowledgeRuntimePorts() };
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: KNOWLEDGE_TASK_QUEUE,
    // Parsing allocates a bounded child heap. Do not let the SDK's broad default exhaust this
    // process by starting a parser for every pending document at once.
    maxConcurrentActivityTaskExecutions: 2,
    activities: {
      ...createKnowledgeIngestActivities(deps),
      ...createKnowledgePurgeActivities(deps),
      ...createKnowledgeAnswerFallbackActivities(deps),
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

  log.info('knowledge_worker.started', { taskQueue: KNOWLEDGE_TASK_QUEUE });
  await worker.run();
  log.info('knowledge_worker.stopped');
  await app.close();
  await connection.close();
}

main().catch((error: unknown) => {
  log.error('knowledge_worker.crashed', { errorCode: errorCode(error) });
  process.exit(1);
});
