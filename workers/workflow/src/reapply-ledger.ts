// Operator command, run after restoring a database backup and before anyone is let back in (ADR-026
// and the runbook). It puts back every deletion the tombstone ledger knows about, and running it again
// changes nothing. It prints counts and no names, and exits non-zero if anything is left to do.
//   node dist/reapply-ledger.js
import { reapplyTombstoneLedger } from '@ensemus/application';
import { readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('reapply-ledger');

async function main() {
  const { db, close } = openAppDatabase(readSecret('DATABASE_URL_APP'));
  const store = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  });
  const result = await reapplyTombstoneLedger(db, store, createServiceContext, (error) =>
    log.warn('tombstone_ledger.entry_failed', { errorCode: errorCode(error) }),
  );
  log.info('tombstone_ledger.reapplied', result);
  await close();
  if (result.failed > 0 || result.invalid > 0) process.exit(1);
}

main().catch((error: unknown) => {
  log.error('tombstone_ledger.reapply_failed', { errorCode: errorCode(error) });
  process.exit(1);
});
