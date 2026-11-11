#!/usr/bin/env node
// FOUND-01, ADR-037 D2: scans the SBOMs build-release.mjs made, so the thing scanned is the thing the
// release lists, and a scan cannot pass on an image that did not reach the release.
//   node infrastructure/scripts/scan-images.mjs
// Needs Docker and network for Grype's database, a fresh download on each image because the container is
// removed afterwards. So it runs in CI and run-all-gates.sh only, and stays outside the air-gap gate.
// Every decision is in scan-rules.mjs. Grype's own exit code only says whether it ran, not what it found.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateScans, readGrypeRun, sbomProblems } from './scan-rules.mjs';
import { GRYPE } from './tool-images.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, '.local', 'release');
const exceptionsFile = join(root, 'infrastructure', 'security', 'image-scan-exceptions.json');
const NAMES = ['web', 'worker'];
const MAX_MINUTES = 15;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function runGrype(name) {
  return spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-e',
      'GRYPE_CHECK_FOR_APP_UPDATE=false',
      '-v',
      `${out.replaceAll('\\', '/')}:/sbom:ro`,
      GRYPE.image,
      `sbom:/sbom/sbom-${name}.spdx.json`,
      '-o',
      'json',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      timeout: MAX_MINUTES * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function scan(name) {
  const file = join(out, `sbom-${name}.spdx.json`);
  if (!existsSync(file)) {
    return {
      report: null,
      problems: [`.local/release/sbom-${name}.spdx.json is missing. Run build-release.mjs first`],
      sbom: null,
    };
  }
  const text = readFileSync(file, 'utf8');
  const sbom = sha256(text);
  const problems = sbomProblems(name, text);
  if (problems.length > 0) return { report: null, problems, sbom };
  return { ...readGrypeRun(name, runGrype(name)), sbom };
}

function readExceptionsFile() {
  try {
    return JSON.parse(readFileSync(exceptionsFile, 'utf8'));
  } catch {
    // Null fails evaluateScans as a file with no list, so a broken file can never mean no exceptions.
    return null;
  }
}

mkdirSync(out, { recursive: true });
const scans = Object.fromEntries(NAMES.map((name) => [name, scan(name)]));
const { images, problems: exceptionProblems } = evaluateScans(
  scans,
  readExceptionsFile(),
  new Date(),
);

let failing = 0;
let listed = 0;
let problems = exceptionProblems.length;
for (const name of NAMES) {
  const verdict = images[name];
  const { report, sbom } = scans[name];
  // Written even when the scan could not happen, so CI's copy of this file never shows an older run.
  writeFileSync(
    join(out, `scan-${name}.json`),
    `${JSON.stringify(
      {
        image: name,
        sbom_sha256: sbom,
        scanner: report?.descriptor?.name
          ? { name: report.descriptor.name, version: report.descriptor.version }
          : null,
        database: report?.descriptor?.db ?? null,
        distro: report?.distro ?? null,
        failing: verdict.failing,
        listed: verdict.listed,
        problems: verdict.problems,
        exception_problems: exceptionProblems,
      },
      null,
      2,
    )}\n`,
  );
  failing += verdict.failing.length;
  listed += verdict.listed.length;
  problems += verdict.problems.length;
  for (const finding of verdict.failing) {
    const fix = finding.fixedIn.length > 0 ? `fixed in ${finding.fixedIn.join(', ')}` : 'no fix';
    console.error(
      `FAILING ${name}: ${finding.id} ${finding.severity} ${finding.package} ${finding.version}, ${fix}`,
    );
  }
  for (const problem of verdict.problems) console.error(`PROBLEM ${name}: ${problem}`);
}
for (const problem of exceptionProblems) console.error(`PROBLEM: ${problem}`);

console.log(`Image scan: ${failing} failing, ${listed} listed`);
if (problems > 0) console.log(`Image scan: ${problems} problems, so this result fails`);
process.exit(failing > 0 || problems > 0 ? 1 : 0);
