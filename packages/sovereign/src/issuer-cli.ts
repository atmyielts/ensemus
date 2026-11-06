// The vendor's issuing tool as a program. workers/workflow/scripts/build-issuer.mjs bundles it to .local/,
// which no image build copies, and tests/unit/issuer-not-shipped.test.ts holds that no image reaches it.
// Everything it writes is owner-only and never replaces a file: a key or a signed document overwritten by a
// slip of the keyboard is hard to notice afterwards. Only the register grows.
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { runIssuerCommand } from './issuer';

const OWNER_ONLY = 0o600;

const status = await runIssuerCommand(process.argv.slice(2), {
  readFile: (path) => readFile(path),
  writeFile: (path, data) => writeFile(path, data, { flag: 'wx', mode: OWNER_ONLY }),
  appendFile: (path, data) => appendFile(path, data, { mode: OWNER_ONLY }),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  now: () => new Date(),
});
process.exit(status);
