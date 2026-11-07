// Operator command for signed documents (COMM-03). All it does itself is know how to open the database,
// which only `install` ever asks for, so `verify` runs on a first boot with no settings at all.
// sovereign-license-command.ts is the command, and says what each exit status means.
import { readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { licenseCommand } from './sovereign-license-command';

const log = createLogger('sovereign-license');
const COULD_NOT_FINISH = 3;

licenseCommand(process.argv.slice(2), {
  openDatabase: () => openAppDatabase(readSecret('DATABASE_URL_APP')),
})
  .then((code) => {
    // Not process.exit, so a result written to a pipe is not cut short.
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    log.error('license.command_failed', { errorCode: errorCode(error) });
    process.exitCode = COULD_NOT_FINISH;
  });
