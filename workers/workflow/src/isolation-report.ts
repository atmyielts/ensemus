// Owned by the isolation slice (EXP-08). See docs/06-delivery/m11c-slices.md and ADR-035 D5. A one-shot job that
// runs real probes from inside a deployment and records what it found, so nobody writes "isolated" by hand.
import { loadIsolationConfig, readSecret } from '@ensemus/config';
import { listIsolationOrganizationIds, openDispatcherDatabase } from '@ensemus/database/dispatcher';
import {
  readAppliedDeploymentProfile,
  recordIsolationEvidence,
} from '@ensemus/database/deployment';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';
import {
  AGENT_TASK_QUEUE,
  KNOWLEDGE_TASK_QUEUE,
  PLATFORM_TASK_QUEUE,
} from '@ensemus/workflows/constants';
import { temporal } from '@temporalio/proto';
import { openDispatcherConnection } from './temporal-connection';
import { collectIsolationEvidence, connectForIsolation } from './isolation-probes';

const log = createLogger('isolation-report');
const { TASK_QUEUE_TYPE_WORKFLOW, TASK_QUEUE_TYPE_ACTIVITY } = temporal.api.enums.v1.TaskQueueType;
const requiredQueues = [
  { name: PLATFORM_TASK_QUEUE, type: TASK_QUEUE_TYPE_WORKFLOW },
  { name: AGENT_TASK_QUEUE, type: TASK_QUEUE_TYPE_ACTIVITY },
  { name: KNOWLEDGE_TASK_QUEUE, type: TASK_QUEUE_TYPE_ACTIVITY },
];

async function main() {
  const config = loadIsolationConfig();
  const migrator = readSecret('DATABASE_URL_MIGRATOR');
  const applied = await readAppliedDeploymentProfile(migrator);
  if (applied?.tier !== 'dedicated' || !applied.pinnedOrganizationId) {
    throw Object.assign(new Error('DEDICATED_PROFILE_REQUIRED'), {
      code: 'DEDICATED_PROFILE_REQUIRED',
    });
  }
  const store = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: config.bucket,
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
    requestTimeoutMs: 3_000,
    maxAttempts: 1,
  });
  const dispatcher = openDispatcherDatabase(readSecret('DATABASE_URL_DISPATCHER'));
  const connection = openDispatcherConnection(process.env.TEMPORAL_ADDRESS ?? 'temporal:7233');
  try {
    const evidence = await collectIsolationEvidence(config, applied.pinnedOrganizationId, {
      listOrganizationIds: () => listIsolationOrganizationIds(dispatcher.db),
      async localNamespace() {
        const namespace = await connection.withDeadline(Date.now() + 5_000, () =>
          connection.workflowService.describeNamespace({ namespace: config.namespace }),
        );
        return namespace.namespaceInfo?.name === config.namespace;
      },
      async localWorkerPool() {
        const queues = await connection.withDeadline(Date.now() + 5_000, () =>
          Promise.all(
            requiredQueues.map(({ name, type }) =>
              connection.workflowService.describeTaskQueue({
                namespace: config.namespace,
                taskQueue: { name },
                taskQueueType: type,
              }),
            ),
          ),
        );
        return queues.every((queue) => Boolean(queue.pollers?.length));
      },
      async localBucket() {
        await store.assertPurgeCapability();
        return true;
      },
      connect: connectForIsolation,
    });
    await recordIsolationEvidence(
      migrator,
      evidence.map((row) => ({ ...row, releaseVersion: config.releaseVersion })),
    );
    for (const row of evidence) {
      log.info('isolation_report.check', {
        aspect: row.aspect,
        status: row.result,
        reasonCode: row.code,
      });
    }
    if (evidence.some((row) => row.result === 'failed')) process.exitCode = 1;
  } finally {
    store.close();
    await Promise.all([dispatcher.close(), connection.close()]);
  }
}

main().catch((error: unknown) => {
  log.error('isolation_report.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
