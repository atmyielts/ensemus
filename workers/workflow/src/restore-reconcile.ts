// Operator command, run after a restore and before anyone is let back in (ADR-030 D11). All it does itself is
// open the connections: restore-reconcile-command.ts is the command.
import { createObjectDeletionLifecycle } from '@ensemus/application/saas/object-deletion';
import { readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
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
  const code = await restoreReconcileCommand(process.argv.slice(2), {
    database: db,
    store,
    listOrganizations: () => listOrganizationIds(dispatcher.db),
    probeRun: createRunProbe((input) =>
      connection.withDeadline(Date.now() + PROBE_DEADLINE_MS, () =>
        client.workflow.getHandle(workflowIdFor(input), input.runId).describe(),
      ),
    ),
    contributors: createLifecycleRestoreContributors(store),
    // The production generated-file lifecycle (0508), as the knowledge worker composes it.
    derivedArtifacts: createObjectDeletionLifecycle({ database: db, store }).derived,
  });
  await close();
  await dispatcher.close();
  await connection.close();
  process.exit(code);
}

main().catch((error: unknown) => {
  log.error('restore_reconcile.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
