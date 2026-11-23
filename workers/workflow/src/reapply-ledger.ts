// Operator command, run after restoring a database backup and before anyone is let back in (ADR-026
// and the runbook). All it does itself is open the connections: reapply-command.ts is the command.
import { createObjectDeletionLifecycle } from '@ensemus/application/saas/object-deletion';
import { readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { assertLoginRole } from '@ensemus/database/service';
import { S3ObjectStore } from '@ensemus/storage';
import { errorCode } from '@ensemus/telemetry';
import { log, reapplyCommand } from './reapply-command';

async function main() {
  const { db, close } = openAppDatabase(readSecret('DATABASE_URL_APP'));
  try {
    await assertLoginRole(db, 'ensemus_worker');
    const store = new S3ObjectStore({
      endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
      bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
      accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
      secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
    });
    // A restored generated deletion uses the same claim, delete and absence check as the knowledge worker.
    return await reapplyCommand(process.argv.slice(2), {
      database: db,
      store,
      derivedArtifacts: createObjectDeletionLifecycle({ database: db, store }).derived,
    });
  } finally {
    await close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    log.error('tombstone_ledger.reapply_failed', { errorCode: errorCode(error) });
    process.exit(1);
  });
