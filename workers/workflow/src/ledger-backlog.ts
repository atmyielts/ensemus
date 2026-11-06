// Operator command: how many deletions have not reached the tombstone ledger yet. These are the ones
// that restoring a backup could not bring back (ADR-026).
//   node dist/ledger-backlog.js
// It prints counts and an age, and no content, because its role cannot read any.
import { readSecret } from '@ensemus/config';
import { eventBacklog, openDispatcherDatabase } from '@ensemus/database/dispatcher';
import { TOMBSTONE_RECORDED } from '@ensemus/domain/tombstone-ledger';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('ledger-backlog');

async function main() {
  const { db, close } = openDispatcherDatabase(readSecret('DATABASE_URL_DISPATCHER'));
  const { queued, dead, oldestSeconds } = await eventBacklog(db, TOMBSTONE_RECORDED);
  log.info('tombstone_ledger.backlog', { queued, dead, oldestSeconds });
  await close();
}

main().catch((error: unknown) => {
  log.error('tombstone_ledger.backlog_failed', { errorCode: errorCode(error) });
  process.exit(1);
});
