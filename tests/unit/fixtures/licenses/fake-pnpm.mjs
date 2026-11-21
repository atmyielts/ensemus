// Stands in for pnpm when a test runs the inventory script, so a failing pnpm can be shown to fail the
// run. The test puts it first on PATH. Nothing shipped knows about it.
import { readFileSync } from 'node:fs';

const mode = process.env.FAKE_PNPM_MODE;
const filter = process.argv[process.argv.indexOf('--filter') + 1];

if (mode === 'fail') {
  console.error('fake pnpm: ERR_PNPM_FIXTURE, nothing is installed');
  process.exit(3);
}
if (mode === 'garbage') console.log('No licenses in packages found');
if (mode === 'empty') console.log('{}');
if (mode === 'listing') {
  console.log(JSON.stringify(JSON.parse(readFileSync(process.env.FAKE_PNPM_LISTING, 'utf8'))[filter]));
}
