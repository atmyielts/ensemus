// The one setup job. Replicas never migrate themselves (see ADR-024 D4 and the deployment doc).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@ensemus/config';
import { runMigrations } from '@ensemus/database/migrate';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('migrate');
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await runMigrations(readSecret('DATABASE_URL_MIGRATOR'), path.join(here, '..', 'migrations'));
  await new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  }).ensureBucket();
  log.info('migrate.done');
}

main().catch((error: unknown) => {
  log.error('migrate.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
