// Bundles every file in src/tools/ into one standalone file in dist/tools/, so an operator needs only Node on a
// machine with nothing else on it. Other slices' tools are picked up by being in the folder.
//   node workers/workflow/scripts/build-sovereign-tools.mjs
// It fails rather than ship a tool that can reach a network, or the vendor's signing code (ADR-030 D3, D4).
import { readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = path.join(root, 'src', 'tools');

/** Node's own modules that talk to a network. Lint and tests/unit/bundle-tools-offline.test.ts say the same. */
export const NETWORK_BUILTINS = ['net', 'tls', 'http', 'https', 'http2', 'dns', 'dgram', 'cluster'];
/** Only the install tool starts anything, and what it starts is Docker, with arguments a unit test checks. */
const MAY_START_PROCESSES = new Set(['install-bundle.mjs']);

/** What in this build's result must not ship. A list of problems, so a test can hand it a bad result. */
export function shippingProblems(metafile) {
  const problems = [];
  for (const input of Object.keys(metafile.inputs)) {
    const file = input.replaceAll('\\', '/');
    if (/packages\/sovereign\/src\/(issuer|issuer-cli|testing)\.ts$/.test(file)) {
      problems.push(`${file} is vendor or test code, which never ships`);
    }
    const workspacePackage = /packages\/([a-z0-9-]+)\/src\//.exec(file)?.[1];
    if (workspacePackage && !['sovereign', 'domain'].includes(workspacePackage)) {
      problems.push(`${file} is outside what a standalone tool may reach`);
    }
  }
  for (const [output, { imports }] of Object.entries(metafile.outputs)) {
    const name = path.basename(output);
    for (const { path: imported, external } of imports) {
      if (!external) continue;
      const bare = imported.replace(/^node:/, '');
      if (!isBuiltin(imported)) problems.push(`${name} needs ${imported} at run time`);
      if (NETWORK_BUILTINS.includes(bare.split('/')[0])) {
        problems.push(`${name} imports ${imported}, which can reach a network`);
      }
      if (bare === 'child_process' && !MAY_START_PROCESSES.has(name)) {
        problems.push(`${name} imports ${imported}, and only the install tool starts anything`);
      }
    }
  }
  return problems;
}

export async function buildSovereignTools({ outdir = path.join(root, 'dist', 'tools') } = {}) {
  const entryPoints = readdirSync(toolsDir)
    .filter((name) => name.endsWith('.ts') && !/\.(test|d)\.ts$/.test(name))
    .map((name) => path.join(toolsDir, name));
  if (entryPoints.length === 0) throw new Error('No tools found to build');

  const { metafile } = await build({
    entryPoints,
    outdir,
    outbase: toolsDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    metafile: true,
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'warning',
  });

  const problems = shippingProblems(metafile);
  if (problems.length > 0) {
    throw new Error(`Refusing these tools:\n${problems.join('\n')}`);
  }
  return Object.keys(metafile.outputs).map((output) => path.basename(output));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await buildSovereignTools();
  console.log(`Built: ${built.join(', ')}`);
}
