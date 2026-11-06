// Bundles worker entry points with esbuild, and prebuilds the workflow code, so production never
// runs a bundler. Temporal packages stay external because they load a native module.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode } from '@temporalio/worker';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const failureConverter = path.resolve(root, '../../packages/workflows/src/failure-converter.ts');
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [
    'src/main.ts',
    'src/dispatcher.ts',
    'src/migrate.ts',
    'src/healthcheck.ts',
    'src/redrive.ts',
  ].map((e) => path.join(root, e)),
  outdir: dist,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['@temporalio/*', 'pg-native'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
});

// Temporal loads this by path with require(), so it must be CommonJS.
await build({
  entryPoints: [failureConverter],
  outfile: path.join(dist, 'failure-converter.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['@temporalio/*'],
  logLevel: 'warning',
});

const { code } = await bundleWorkflowCode({
  workflowsPath: path.resolve(root, '../../packages/workflows/src/workflows.ts'),
  failureConverterPath: failureConverter,
});
writeFileSync(path.join(dist, 'workflow-bundle.cjs'), code);

cpSync(path.resolve(root, '../../packages/database/migrations'), path.join(root, 'migrations'), {
  recursive: true,
});
