// The process that hands jobs to a sandbox runner (ADR-034 D3). It holds the database as the ordinary application
// role, the object store and the runner's address, and nothing else: no secrets broker, no connector, no
// egress gateway. It polls only the sandbox queue and runs no workflows. It runs only under the `sandbox`
// profile, so a deployment that never asked for code execution has none of this running.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entitledSkillFeatureGate } from '@ensemus/application';
import { createSandboxWorkerControl } from '@ensemus/application/sandbox-worker-control';
import { createEntitlementChecker } from '@ensemus/application/saas/entitlements';
import {
  loadSandboxCeilings,
  loadSandboxWorkerConfig,
  loadSkillFeatures,
  loadSaasConfig,
  readSecret,
} from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { createRunnerClient } from '@ensemus/sandbox/client';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { SANDBOX_TASK_QUEUE } from '@ensemus/workflows/constants';
import { createSandboxRunActivities } from '@ensemus/workflows/sandbox-run-activities';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';

const log = createLogger('sandbox-worker');
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const features = loadSkillFeatures();
  if (!features.sandbox) {
    log.info('sandbox_worker.disabled');
    return;
  }
  const config = loadSandboxWorkerConfig();
  const runner = createRunnerClient({
    url: config.runnerUrl,
    token: readSecret('SANDBOX_RUNNER_TOKEN'),
  });
  // Install before any Temporal calls. The SDK's default logger would print activity error messages.
  Runtime.install({
    logger: createTemporalLogger(log),
    telemetryOptions: { logging: { filter: 'WARN', forward: {} } },
  });
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
  });
  const app = openAppDatabase(readSecret('DATABASE_URL_APP'));
  const control = await createSandboxWorkerControl(app.db);
  const gate = entitledSkillFeatureGate(
    features,
    createEntitlementChecker(app.db, loadSaasConfig().billingEnabled),
  );
  const store = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  });
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: SANDBOX_TASK_QUEUE,
    maxConcurrentActivityTaskExecutions: 4,
    activities: createSandboxRunActivities({
      control,
      gate,
      ceilings: loadSandboxCeilings(),
      store,
      runner,
      maxConcurrentPerTenant: config.maxConcurrentPerTenant,
      probeMaxAgeMs: config.probeMaxAgeMs,
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

  log.info('sandbox_worker.started', { taskQueue: SANDBOX_TASK_QUEUE });
  await worker.run();
  log.info('sandbox_worker.stopped');
  await app.close();
  await connection.close();
}

main().catch((error: unknown) => {
  log.error('sandbox_worker.crashed', { errorCode: errorCode(error) });
  process.exit(1);
});
