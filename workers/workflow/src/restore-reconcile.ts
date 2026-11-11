// Operator command, run after a restore and before anyone is let back in (ADR-030 D11). All it does itself is
// open the connections: restore-reconcile-command.ts is the command.
import { withRawKnowledgeObjects } from '@ensemus/application/knowledge/raw-objects';
import { createObjectDeletionLifecycle } from '@ensemus/application/saas/object-deletion';
import { ConfigError, readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { openAgentDatabase } from '@ensemus/database/agent';
import { listOrganizationIds, openDispatcherDatabase } from '@ensemus/database/dispatcher';
import { S3ObjectStore } from '@ensemus/storage';
import { errorCode } from '@ensemus/telemetry';
import { workflowIdFor } from '@ensemus/workflows/schemas';
import { Client } from '@temporalio/client';
import { createLifecycleRestoreContributors } from './restore-contributors';
import { createRunProbe, log, restoreReconcileCommand } from './restore-reconcile-command';
import { openDispatcherConnection } from './temporal-connection';

/** One slow answer about one run may not hold up the rest. The same limit as main.ts. */
const PROBE_DEADLINE_MS = 5_000;

/**
 * The agent role, when the operator gave this command its URL. Only that role may fence a run's inputs, purge
 * a transcript or release a run's holds, so without it both M4 contributors stay unbound and report
 * attention. Any other configuration error still stops the command.
 */
function openAgentRoleIfGiven() {
  try {
    return openAgentDatabase(readSecret('DATABASE_URL_AGENT'), { max: 2 });
  } catch (error) {
    if (error instanceof ConfigError && !process.env.DATABASE_URL_AGENT_FILE) return undefined;
    throw error;
  }
}

async function main() {
  const { db, close } = openAppDatabase(readSecret('DATABASE_URL_APP'));
  // Only for the list of tenants, which event metadata alone can answer.
  const dispatcher = openDispatcherDatabase(readSecret('DATABASE_URL_DISPATCHER'));
  const store = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  });
  // Lazy, so a Temporal that is down makes every answer `unknown` and the rest of the report still runs.
  // It reads only whether a run is open, so it needs no payload codec, and holds no worker of any kind.
  const connection = openDispatcherConnection(process.env.TEMPORAL_ADDRESS ?? 'temporal:7233');
  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  });
  const probeRun = createRunProbe((input) =>
    connection.withDeadline(Date.now() + PROBE_DEADLINE_MS, () =>
      client.workflow.getHandle(workflowIdFor(input), input.runId).describe(),
    ),
  );
  const agent = openAgentRoleIfGiven();
  const code = await restoreReconcileCommand(process.argv.slice(2), {
    database: db,
    store,
    listOrganizations: () => listOrganizationIds(dispatcher.db),
    probeRun,
    contributors: createLifecycleRestoreContributors(store, {
      ...(agent ? { agentDatabase: agent.db } : {}),
      probeRun,
      // The raw knowledge port, as the knowledge worker composes it, so a writer is settled on native proof.
      knowledgeStore: withRawKnowledgeObjects({ database: db, store }),
    }),
    // The production generated-file lifecycle (0508), as the knowledge worker composes it.
    derivedArtifacts: createObjectDeletionLifecycle({ database: db, store }).derived,
  });
  await close();
  await agent?.close();
  await dispatcher.close();
  await connection.close();
  process.exit(code);
}

main().catch((error: unknown) => {
  log.error('restore_reconcile.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
