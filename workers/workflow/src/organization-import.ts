// Operator command that reads an organization archive into a new, empty organization (ADR-030 D8). All it does
// itself is open the connections: organization-import-command.ts is the command. The private key is only ever
// read from the file named on the command line, so it reaches no environment, no Temporal and no table.
import { readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { organizationImportCommand } from './organization-import-command';
import { PORTABILITY_SECTIONS } from './portability-sections';

const log = createLogger('organization-import');

async function main() {
  const { db, close } = openAppDatabase(readSecret('DATABASE_URL_APP'));
  const store = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
    // The immutable file ledger owns admission; an ambiguous put must not be resent by the SDK.
    maxAttempts: 1,
  });
  const code = await organizationImportCommand(process.argv.slice(2), {
    database: db,
    store,
    sections: PORTABILITY_SECTIONS,
    io: {
      out: (line) => void process.stdout.write(`${line}\n`),
      err: (line) => void process.stderr.write(line),
    },
  });
  await close();
  process.exit(code);
}

main().catch((error: unknown) => {
  log.error('organization_import.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
