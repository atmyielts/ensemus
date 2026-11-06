// The operator's command for a stop no tenant can set (ADR-028 FD-15), like setup-token:
//   docker compose run --rm --no-deps migrate node dist/halt-global.js engage global INCIDENT
//   ... engage provider openai_hosted INCIDENT
//   ... release <id>
//   ... list
// It reaches only the database, so it works with the network otherwise down. Stdout carries the switch's ID
// and nothing else, so a script can capture it. Anything that goes wrong goes to stderr, with a non-zero
// exit. Its row is the record: it has no tenant, so no tenant's audit log can hold it, and rows are kept.
import { readSecret } from '@ensemus/config';
import {
  engageOperatorSwitch,
  listOperatorSwitches,
  releaseOperatorSwitch,
} from '@ensemus/database/halt-operator';
import { PROVIDER_KINDS } from '@ensemus/domain/ai';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { parseHaltCommand, runHaltCommand } from './kill-switch';

const log = createLogger('halt-global', (line) => process.stderr.write(`${line}\n`));

const USAGE = [
  'Usage:',
  '  halt-global engage global <REASON_CODE>',
  `  halt-global engage provider <${PROVIDER_KINDS.join('|')}> <REASON_CODE>`,
  '  halt-global release <switch id>',
  '  halt-global list',
  '',
  'A reason code is capitals, digits and underscores, such as INCIDENT.',
  '',
].join('\n');

async function main() {
  const command = parseHaltCommand(process.argv.slice(2), PROVIDER_KINDS);
  if (!command) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const url = readSecret('DATABASE_URL_MIGRATOR');
  await runHaltCommand(
    command,
    {
      engage: (input) => engageOperatorSwitch(url, input),
      release: (switchId) => releaseOperatorSwitch(url, switchId),
      list: () => listOperatorSwitches(url),
    },
    (text) => process.stdout.write(text),
  );
}

main().catch((error: unknown) => {
  log.error('halt_global.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
