// A separate process from the web tier (ADR-016). It serves no HTTP; it only polls Temporal.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOnboardingAgentRuns } from '@ensemus/application/knowledge/onboarding-run-port';
import { loadSaasConfig, readSecret } from '@ensemus/config';
import { loadSovereignConfig } from '@ensemus/config/sovereign';
import { openAppDatabase } from '@ensemus/database';
import { S3ObjectStore } from '@ensemus/storage';
import { withRawKnowledgeObjects } from '@ensemus/application/knowledge/raw-objects';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { createActivities, type WorkflowProbe } from '@ensemus/workflows/activities';
import { createBillingActivities } from '@ensemus/workflows/billing-activities';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { createClientOnboardingActivities } from '@ensemus/workflows/client-onboarding-activities';
import { PLATFORM_TASK_QUEUE, TEMPORAL_CHANNEL_ARGS } from '@ensemus/workflows/constants';
import { createCreditActivities } from '@ensemus/workflows/credit-activities';
import { createExternalActionPlatformActivities } from '@ensemus/workflows/external-action-activities';
import { createObjectMigrationActivities } from '@ensemus/workflows/object-migration-activities';
import { createProcessRunActivities } from '@ensemus/workflows/process-run-activities';
import { createSimulationActivities } from '@ensemus/workflows/simulation-activities';
import { createPortabilityActivities } from '@ensemus/workflows/portability-activities';
import { createOffboardingActivities } from '@ensemus/workflows/offboarding-activities';
import { createPaymentPlatformActivities } from '@ensemus/workflows/payment-activities';
import { createRetentionActivities } from '@ensemus/workflows/retention-activities';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { workflowIdFor } from '@ensemus/workflows/schemas';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { PORTABILITY_SECTIONS } from './portability-sections';

import { workerProductPorts } from './product-ports';
import { createSaasPorts } from './saas-ports';

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
  const nativeStore = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  });
  const store = withRawKnowledgeObjects({ database: db, store: nativeStore });
  const generatedObjects = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
    maxAttempts: 1,
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
  const sovereign = loadSovereignConfig();
  const ports = createSaasPorts(store);
  const saas = loadSaasConfig();
  const billingEnabled = saas.billingEnabled;
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: PLATFORM_TASK_QUEUE,
    workflowBundle: { codePath: path.join(here, 'workflow-bundle.cjs') },
    activities: {
      ...createActivities({ database: db, store: generatedObjects, probeWorkflow }),
      // Only what reads PostgreSQL. Anything holding a credential is on the connector queue.
      ...createExternalActionPlatformActivities({ database: db }),
      ...createClientOnboardingActivities({ database: db, agentRuns: createOnboardingAgentRuns() }),
      // M7 (ADR-031). None of these holds a credential, or calls anything outside PostgreSQL.
      ...createSimulationActivities({ database: db }),
      ...createProcessRunActivities({ database: db, ports: workerProductPorts(db) }),
      ...createObjectMigrationActivities({ database: db }),
      // Seals to a customer's public key and holds no private key (ADR-030 D6).
      ...createPortabilityActivities({
        database: db,
        store,
        exportDeps: {
          sections: PORTABILITY_SECTIONS,
          sourceRelease: sovereign.release,
          retentionHours: sovereign.exportRetentionHours,
        },
      }),
      // M8 (ADR-032). Its ports refuse until sibling milestones are wired in, in saas-ports.ts.
      ...createBillingActivities({
        database: db,
        usage: ports.usage,
        agents: ports.agents,
        billingEnabled,
      }),
      ...createCreditActivities({
        database: db,
        usage: ports.usage,
        agents: ports.agents,
        billingEnabled,
      }),
      ...createPaymentPlatformActivities(
        { database: db },
        {
          agents: ports.agents,
          ...(saas.billingOrganizationId
            ? { routing: { billingOrganizationId: saas.billingOrganizationId } }
            : {}),
        },
      ),
      ...createRetentionActivities({ database: db, sources: ports.retentionSources }),
      ...createOffboardingActivities({ database: db, ports: ports.offboarding }),
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
  generatedObjects.close();
  store.close();
  await close();
  await clientConnection.close();
  await connection.close();
}

main().catch((error: unknown) => {
  log.error('worker.crashed', { errorCode: errorCode(error) });
  process.exit(1);
});
