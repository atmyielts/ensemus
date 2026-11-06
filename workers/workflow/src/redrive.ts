// Operator command: puts dead outbox events back in the queue, once whatever killed them is fixed.
//   node dist/redrive.js [organization-id]
// It prints a count, and no event content, because its role cannot read any.
import { readSecret } from '@ensemus/config';
import { openDispatcherDatabase, redriveDeadEvents } from '@ensemus/database/dispatcher';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('redrive');

async function main() {
  const organizationId = process.argv[2];
  const { db, close } = openDispatcherDatabase(readSecret('DATABASE_URL_DISPATCHER'));
  const count = await redriveDeadEvents(db, organizationId ? { organizationId } : {});
  log.info('outbox.redriven', { count });
  await close();
}

main().catch((error: unknown) => {
  log.error('outbox.redrive_failed', { errorCode: errorCode(error) });
  process.exit(1);
});
