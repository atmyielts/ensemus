#!/usr/bin/env node
// COMM-06: runs one release in all three modes, and says whether they behave alike.
//   node infrastructure/scripts/parity-gate.mjs            fails if anything contradicts parity
//   node infrastructure/scripts/parity-gate.mjs --release  also fails if parity has not been shown
// The same images run every round: the mode is configuration (ADR-010), and that is part of what this
// checks. The Sovereign round has outside names unreachable, using the air-gap overlay. It does not count
// outbound packets, which is the air-gap gate's job, so this does not stand in for that gate.
//
// This has not run yet. See docs/06-delivery/m9p-slices.md for what it still needs.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const results = join(root, '.local', 'parity');
const release = process.argv.includes('--release');

const importTs = (path) => import(pathToFileURL(join(root, path)).href);
const { COMMERCIAL_MODES, compareReports, describeOutcome } =
  await importTs('tests/parity/rules.ts');
const { PARITY_CATALOG } = await importTs('tests/parity/catalog.ts');

const BASE_FILES = [
  'infrastructure/compose/compose.yaml',
  'infrastructure/compose/compose.test.yaml',
];
const AIRGAP_FILE = 'infrastructure/compose/compose.airgap.yaml';

const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
  });

const composeArgs = (blackholed) =>
  [...BASE_FILES, ...(blackholed ? [AIRGAP_FILE] : [])].flatMap((file) => ['-f', file]);

const down = () => {
  try {
    run('docker', ['compose', ...composeArgs(true), 'down', '-v', '--remove-orphans']);
  } catch {
    // Nothing was running.
  }
};

/** The image a service's container really runs, not the tag it was asked to start from. */
function imageOf(service, blackholed, env) {
  const id = run(
    'docker',
    ['compose', ...composeArgs(blackholed), 'ps', '-q', service],
    env,
  ).trim();
  if (!id) throw new Error(`${service} is not running`);
  return run('docker', ['inspect', id, '--format', '{{.Image}}']).trim();
}

function roundFor(mode, commit, dirty) {
  const blackholed = mode === 'sovereign';
  const env = {
    ENSEMUS_MODE: mode,
    ENSEMUS_PARITY_MODE: mode,
    ...(blackholed ? { ENSEMUS_COMPOSE_AIRGAP: '1' } : {}),
  };
  down();
  console.log(`Starting the stack as ${mode}...`);
  run(
    'docker',
    ['compose', ...composeArgs(blackholed), 'up', '-d', '--wait', '--wait-timeout', '300'],
    env,
  );
  const images = {
    web: imageOf('web', blackholed, env),
    worker: imageOf('worker', blackholed, env),
  };
  const startedAt = new Date().toISOString();
  const suite = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'parity'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  const dir = join(results, mode);
  mkdirSync(dir, { recursive: true });
  const scenarios = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  const report = {
    schema: 1,
    mode,
    commit,
    dirty,
    images,
    network: blackholed ? 'blackholed' : 'open',
    startedAt,
    scenarios,
  };
  writeFileSync(join(results, `report-${mode}.json`), `${JSON.stringify(report, null, 2)}\n`);
  // A failed scenario is in the report. A suite that broke before running one is not, and would otherwise
  // read as "did not run", which is too kind for a harness that says it found the wrong mode.
  const failed = scenarios.some((result) => result.outcome === 'fail');
  return { report, suiteBroke: suite.status !== 0 && !failed };
}

let exitCode = 0;
try {
  rmSync(results, { recursive: true, force: true });
  mkdirSync(results, { recursive: true });
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  const dirty = run('git', ['status', '--porcelain']).trim().length > 0;
  down();
  console.log('Building images, once, for every round...');
  run('docker', ['compose', ...composeArgs(false), 'build']);

  const reports = [];
  for (const mode of COMMERCIAL_MODES) {
    const { report, suiteBroke } = roundFor(mode, commit, dirty);
    reports.push(report);
    if (suiteBroke) {
      console.error(`FAILED: the parity suite did not finish in ${mode}.`);
      exitCode = 1;
    }
  }

  const outcome = compareReports(reports, PARITY_CATALOG);
  writeFileSync(join(results, 'outcome.json'), `${JSON.stringify(outcome, null, 2)}\n`);
  console.log(describeOutcome(outcome));
  if (outcome.verdict === 'failed') exitCode = 1;
  if (outcome.verdict === 'not_proven' && release) {
    console.error('FAILED: a release needs parity shown, and it has not been.');
    exitCode = 1;
  }
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  down();
}
process.exit(exitCode);
