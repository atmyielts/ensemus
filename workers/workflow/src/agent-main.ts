// The one process that can reach a model, open a model key, or read a prompt (ADR-028 FD-2). It polls only
// the agent queue, runs no workflows, and uses the agent database role. Model and tool ports bind to
// real adapters; a missing approved profile, budget or review reference is enforced by those adapters.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@ensemus/config';
import { openAgentDatabase } from '@ensemus/database/agent';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { AGENT_TASK_QUEUE } from '@ensemus/workflows/constants';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { createAgentServices } from './agent-composition';

const log = createLogger('agent-worker');
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Must run first. The SDK's default logger would print activity error messages.
  Runtime.install({
    logger: createTemporalLogger(log),
    telemetryOptions: { logging: { filter: 'WARN', forward: {} } },
  });
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
    // Native Core has no gRPC-JS channelArgs option; keep optional DNS load balancing disabled.
    dnsLoadBalancingConfig: null,
  });
  const agent = openAgentDatabase(readSecret('DATABASE_URL_AGENT'));
  const secretsDb = openSecretsDatabase(readSecret('DATABASE_URL_SECRETS'));
  const objects = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let services: ReturnType<typeof createAgentServices> | undefined;
  try {
    services = createAgentServices({
      database: agent.db,
      secrets: new SecretBroker(
        secretsDb.db,
        new FileKeyProvider([readSecret('SECRET_SEALING_PRIVATE_KEY')]),
      ),
      objects,
      log,
    });
    const worker = await Worker.create({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: AGENT_TASK_QUEUE,
      activities: services.activities,
      dataConverter: {
        payloadCodecs: [new AesGcmPayloadCodec(readSecret('TEMPORAL_CODEC_KEY'))],
        failureConverterPath: path.join(here, 'failure-converter.cjs'),
      },
    });

    // The container health check reads this file. Crashes stop updates, so they are never hidden.
    const beat = () => writeFileSync('/tmp/worker-alive', String(Date.now()));
    beat();
    timer = setInterval(beat, 5_000);
    timer.unref();

    services.watcher.start();
    log.info('agent_worker.started', { taskQueue: AGENT_TASK_QUEUE });
    await worker.run();
    log.info('agent_worker.stopped');
  } finally {
    clearInterval(timer);
    await services?.watcher.stop();
    objects.close();
    await agent.close();
    await secretsDb.close();
    await connection.close();
  }
}

main().catch((error: unknown) => {
  log.error('agent_worker.crashed', { errorCode: errorCode(error) });
  process.exit(1);
});
