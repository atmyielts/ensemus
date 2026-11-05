// The one migration job. Replicas never migrate themselves (see ADR-024 D4 and the deployment doc).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@ensemus/config';
import { runMigrations } from '@ensemus/database/migrate';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('migrate');
const here = path.dirname(fileURLToPath(import.meta.url));

runMigrations(readSecret('DATABASE_URL_MIGRATOR'), path.join(here, '..', 'migrations'))
  .then(() => log.info('migrate.done'))
  .catch((error: unknown) => {
    log.error('migrate.failed', { errorCode: errorCode(error) });
    process.exit(1);
  });
