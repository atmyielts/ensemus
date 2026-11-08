import { readFileSync, openSync, closeSync, writeFileSync, fsyncSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { profiles, scenarios } from './profiles.mjs';
import { runProfile, validateProfile, validateTarget } from './harness.mjs';

export function parseCommand(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: Object.fromEntries(
      [
        'profile',
        'base-url',
        'out',
        'fixture-file',
        'context-file',
        'profile-file',
        'scenario',
        'controls',
      ].map((name) => [name, { type: 'string', multiple: true }]),
    ),
  });
  if (Object.values(values).some((value) => value.length !== 1 || !value[0]))
    throw new Error('ARGUMENT_INVALID');
  const input = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value[0]]));
  if (
    !input['base-url'] ||
    !input.out ||
    !input['fixture-file'] ||
    !input['context-file'] ||
    !input.profile ||
    !Object.hasOwn(profiles, input.profile) ||
    (input.scenario && !Object.hasOwn(scenarios, input.scenario))
  )
    throw new Error('EXPLICIT_TARGET_AND_FIXTURE_REQUIRED');
  return input;
}
function readJson(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024)
    throw new Error('INPUT_FILE_INVALID');
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('INPUT_FILE_INVALID');
  return JSON.parse(text);
}
export async function main(args) {
  const input = parseCommand(args),
    base = profiles[input.profile],
    profile = validateProfile({
      ...base,
      ...(input['profile-file'] ? readJson(input['profile-file']) : {}),
      ...(input.scenario ? { scenario: input.scenario } : {}),
    });
  const fixture = readJson(input['fixture-file']),
    context = readJson(input['context-file']);
  if (
    fixture.kind !== 'ensemus-generated-load-fixture-v1' ||
    fixture.generated !== true ||
    fixture.complete !== true
  )
    throw new Error('GENERATED_FIXTURE_REQUIRED');
  validateTarget(profile, {
    baseUrl: input['base-url'],
    tenants: fixture.tenants,
    generated: true,
    context,
  });
  let controls;
  if (input.controls) {
    if (!input.controls.endsWith('.mjs')) throw new Error('CONTROLS_MODULE_INVALID');
    controls = await import(pathToFileURL(resolve(input.controls)).href);
  }
  // Reserve the output before starting any requests or controlled faults. Never overwrite evidence.
  const descriptor = openSync(input.out, 'wx', 0o600);
  try {
    const report = await runProfile(profile, {
      baseUrl: input['base-url'],
      tenants: fixture.tenants,
      generated: true,
      context,
      ...(controls
        ? {
            controls,
            ...(typeof controls.readVerifiedOutcomeCost === 'function'
              ? { readVerifiedOutcomeCost: controls.readVerifiedOutcomeCost }
              : {}),
          }
        : {}),
    });
    writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    return report.web.errorRate === 0 && report.scenario.verification !== 'failed' ? 0 : 1;
  } finally {
    closeSync(descriptor);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('LOAD_RUN_REFUSED_OR_FAILED\n');
      process.exitCode = 2;
    });
}
