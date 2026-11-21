#!/usr/bin/env node
// FOUND-01, ADR-037 D1: nothing that goes into a build may move under us. Walks the real files and holds
// them to pin-rules.mjs. It needs no Docker and no network, so it blocks in CI today.
//   node infrastructure/scripts/check-pins.mjs
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  composeProblems,
  dockerfileProblems,
  manifestProblems,
  scriptImageProblems,
  toolImageProblems,
  versionFileProblems,
  workflowProblems,
} from './pin-rules.mjs';

/** Dependencies, build output and local state. docs/ holds reference copies that nothing builds from. */
const NOT_OURS = new Set([
  '.claude',
  '.git',
  '.local',
  '.next',
  '.serena',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'docs',
  'generated',
  'node_modules',
  'out',
]);

function* filesUnder(root, folder = root) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (!NOT_OURS.has(entry.name)) yield* filesUnder(root, path);
    } else if (entry.isFile()) {
      yield relative(root, path).split(sep).join('/');
    }
  }
}

function kindOf(path) {
  const name = basename(path);
  if (/^Dockerfile(\..+)?$|\.Dockerfile$/.test(name)) return 'Dockerfile';
  if (/^(docker-)?compose(\..+)?\.ya?ml$/.test(name)) return 'Compose file';
  if (/^\.github\/workflows\/.+\.ya?ml$/.test(path)) return 'workflow';
  if (name === 'package.json') return 'manifest';
  if (/\.(mjs|cjs|js|sh)$/.test(name)) return 'script';
  // tests/unit holds the made-up images these rules are tested on. The rest can run real containers.
  if (name.endsWith('.ts') && path.startsWith('tests/') && !path.startsWith('tests/unit/')) {
    return 'script';
  }
  return null;
}

const readIfThere = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

/** Reads every file these rules cover under `root`, and answers what they found. */
export async function checkRepository(root) {
  const problems = [];
  const counts = { Dockerfile: 0, 'Compose file': 0, workflow: 0, manifest: 0, script: 0 };

  for (const path of filesUnder(root)) {
    const kind = kindOf(path);
    if (!kind) continue;
    counts[kind] += 1;
    const text = readFileSync(join(root, path), 'utf8');
    if (kind === 'Dockerfile') problems.push(...dockerfileProblems(path, text));
    else if (kind === 'Compose file') problems.push(...composeProblems(path, text));
    else if (kind === 'workflow') problems.push(...workflowProblems(path, text));
    else if (kind === 'script') problems.push(...scriptImageProblems(path, text));
    else {
      try {
        problems.push(...manifestProblems(path, JSON.parse(text)));
      } catch {
        problems.push(`${path}: is not valid JSON`);
      }
    }
  }
  // A folder that moved must not read as a pass because nothing was found to check.
  for (const [kind, count] of Object.entries(counts)) {
    if (count === 0) problems.push(`no ${kind} was found under ${root}, so none was checked`);
  }

  const toolImages = join(root, 'infrastructure/scripts/tool-images.mjs');
  if (existsSync(toolImages)) {
    problems.push(...toolImageProblems(await import(pathToFileURL(toolImages).href)));
  } else {
    problems.push('infrastructure/scripts/tool-images.mjs: is missing');
  }

  let packageManager;
  try {
    packageManager = JSON.parse(readIfThere(join(root, 'package.json')) ?? '{}').packageManager;
  } catch {
    // The manifest rule above has already said it is not valid JSON.
  }
  const nvmrc = readIfThere(join(root, '.nvmrc'));
  problems.push(...versionFileProblems({ nvmrc, packageManager }));

  const fileCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return { checked: fileCount + 2, problems };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { checked, problems } = await checkRepository(root);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`Pins: ${problems.length} problem(s), ${checked} checked`);
    process.exitCode = 1;
    return;
  }
  console.log(`Pins: OK, ${checked} checked`);
}

// tests/unit/pin-rules.test.ts runs this file too, because a guard that never matched would pass silently.
const entry = process.argv[1];
if (entry && existsSync(entry) && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  await main();
}
