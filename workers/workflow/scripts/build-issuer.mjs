// Bundles the vendor's issuing tool to .local/issuer/issuer.mjs. This is not part of any image: `.local` is
// in .dockerignore and .gitignore, scripts/build.mjs has no entry for it, and no Dockerfile runs this script,
// which tests/unit/issuer-not-shipped.test.ts checks (ADR-030 D3).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outfile = path.join(repository, '.local', 'issuer', 'issuer.mjs');
mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(repository, 'packages/sovereign/src/issuer-cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  logLevel: 'warning',
});

process.stdout.write(`Built ${path.relative(repository, outfile)}\n`);
