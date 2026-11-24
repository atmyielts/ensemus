// One command for a measurement against a local stack (OPS-01): seeds a generated fixture through the real forms,
// records this machine as the measurement context, and runs the profile. It is seed-fixture.mjs and run.mjs in
// sequence, with nothing of its own in between, so everything they refuse it refuses too.
//
//   node tests/load/local.mjs --profile <small|medium|growing|multiTenantAggregate>
//     --base-url https://localhost:8443 --dir <new private folder> [--profile-file <json>] [--release <ref>]
//
// Loopback only: a local stack is the only target this will seed, because seeding creates accounts. The folder
// must not exist; it is made private and gets the fixture (which holds session cookies, so never commit or attach
// it), the context and the report. Nothing here was run by the source work that added it.
import { mkdirSync, openSync, closeSync, writeSync, fsyncSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';
import { profiles } from './profiles.mjs';

const REF = /^[A-Za-z0-9._:-]{1,120}$/;

/** A machine reference the report accepts: unsafe characters become a dash, and nothing is left empty. */
export function machineRef(value) {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return cleaned || 'unknown';
}

export function parseLocalCommand(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      profile: { type: 'string' },
      'base-url': { type: 'string' },
      dir: { type: 'string' },
      'profile-file': { type: 'string' },
      release: { type: 'string' },
    },
  });
  if (!values.profile || !Object.hasOwn(profiles, values.profile))
    throw new Error('PROFILE_REQUIRED');
  if (!values.dir) throw new Error('DIR_REQUIRED');
  if (!values['base-url']) throw new Error('LOOPBACK_TEST_TARGET_REQUIRED');
  let url;
  try {
    url = new URL(values['base-url']);
  } catch {
    throw new Error('LOOPBACK_TEST_TARGET_REQUIRED');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('LOOPBACK_TEST_TARGET_REQUIRED');
  const release = values.release ?? process.env.ENSEMUS_RELEASE ?? 'local';
  if (!REF.test(release)) throw new Error('RELEASE_REF_INVALID');
  return {
    profile: values.profile,
    baseUrl: url.origin,
    dir: values.dir,
    profileFile: values['profile-file'],
    release,
  };
}

/** What run.mjs needs to know about where it ran, read from this machine and from nothing else. */
export function hostContext(host, release) {
  const cpus = Array.isArray(host.cpus) ? host.cpus : [];
  return {
    environmentRef: 'local-stack',
    release,
    networkLocality: 'loopback',
    hardware: {
      cpuModelRef: machineRef(cpus[0]?.model),
      logicalCpus: Math.max(1, cpus.length),
      memoryBytes: Math.max(1, Math.floor(Number(host.totalmem) || 1)),
      osRef: machineRef(`${host.platform}-${host.arch}-${host.release}`),
    },
  };
}

function writePrivate(path, value) {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 0, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function main(args) {
  const input = parseLocalCommand(args);
  // Refuses a folder that exists, so earlier evidence is never mixed with this run's.
  mkdirSync(dirname(resolve(input.dir)), { recursive: true });
  mkdirSync(input.dir, { recursive: false, mode: 0o700 });
  const fixture = join(input.dir, 'fixture.json');
  const context = join(input.dir, 'context.json');
  const report = join(input.dir, 'report.json');
  writePrivate(
    context,
    hostContext(
      {
        cpus: os.cpus(),
        totalmem: os.totalmem(),
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
      },
      input.release,
    ),
  );
  const profileFile = input.profileFile ? ['--profile-file', input.profileFile] : [];
  const seed = await import('./seed-fixture.mjs');
  await seed.main([
    '--profile',
    input.profile,
    '--base-url',
    input.baseUrl,
    '--out',
    fixture,
    ...profileFile,
  ]);
  const run = await import('./run.mjs');
  return run.main([
    '--profile',
    input.profile,
    '--base-url',
    input.baseUrl,
    '--fixture-file',
    fixture,
    '--context-file',
    context,
    '--out',
    report,
    ...profileFile,
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('LOCAL_LOAD_REFUSED_OR_FAILED\n');
      process.exitCode = 2;
    });
