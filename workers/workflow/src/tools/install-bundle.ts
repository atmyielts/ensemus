// COMM-04, OPS-03, OPS-11: carries out `planInstall`, one printed step at a time, with images from the bundle's
// own archives. It never contacts a registry: every `docker` call is a load, an inspect, a tag or a Compose
// command that says `--pull never`, and a unit test holds that. `build-sovereign-tools.mjs` bundles this.
//   node install-bundle.mjs <folder> --trust-root <file> --state-dir <dir> [--dry-run]
//     [--operator <name>] [--backup-reference <text>] [--rollback] [--backup-restored]
//     [--license <file>] [--maintenance <file>]... [--confirm-outside-rights]
//     [--project <name>] [--env-file <file>]
// Exit 0 means done, 1 stopped or refused, 2 a bad argument. Nothing here can affect whether the version already
// running may go on running, and a refusal before `stop_services` leaves it exactly as it was.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dayOf, evaluateUpdateRight, type UpdateRightVerdict } from '@ensemus/domain/license';
import {
  BUNDLE_MANIFEST_FILE,
  isInsideFolder,
  KNOWN_ROLLBACK_CONSTRAINTS,
  loadOperatorTrustRoot,
  planInstall,
  verifyBundleDirectory,
  type InstallationRecord,
  type InstallPlanStep,
} from '@ensemus/sovereign/bundle';
import type { BundleManifest } from '@ensemus/sovereign/documents';
import type { TrustRoot } from '@ensemus/sovereign/trust-root';
import { verifyDocument } from '@ensemus/sovereign/verify';

export const INSTALLED_MANIFEST_FILE = 'installed-bundle-manifest.dsse.json';
export const INSTALLATION_RECORD_FILE = 'installation-record.jsonl';

/** Paths the overlay in infrastructure/compose/sovereign/README.md and build-bundle.mjs both rely on. */
const COMPOSE_BASE = 'compose/compose.yaml';
const COMPOSE_OVERLAY = 'compose/compose.sovereign.yaml';
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MAX_OPERATOR_TEXT = 200;

const USAGE =
  'Usage: install-bundle <folder> --trust-root <file> --state-dir <dir> [--dry-run] [--operator <name>] ' +
  '[--backup-reference <text>] [--rollback] [--backup-restored] [--license <file>] [--maintenance <file>] ' +
  '[--confirm-outside-rights] [--project <name>] [--env-file <file>]';

export type DockerResult = { status: number; stdout: string };

export type InstallIo = {
  docker(args: readonly string[], env: Readonly<Record<string, string>>): Promise<DockerResult>;
  out(line: string): void;
  err(line: string): void;
  now(): Date;
};

/** The one name an image gets after its digest has been checked, and the only one the overlay uses. */
export const releaseImageName = (name: string, version: string) =>
  `ensemus-sovereign/${name}:${version}`;

type Options = {
  folder: string;
  trustRoot: string;
  stateDir: string;
  dryRun: boolean;
  rollback: boolean;
  backupRestored: boolean;
  confirmOutsideRights: boolean;
  operator: string | undefined;
  backupReference: string | undefined;
  license: string | undefined;
  maintenance: readonly string[];
  project: string;
  envFile: string | undefined;
};

function parseOptions(argv: readonly string[]): Options | null {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        'trust-root': { type: 'string' },
        'state-dir': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        rollback: { type: 'boolean', default: false },
        'backup-restored': { type: 'boolean', default: false },
        'confirm-outside-rights': { type: 'boolean', default: false },
        operator: { type: 'string' },
        'backup-reference': { type: 'string' },
        license: { type: 'string' },
        maintenance: { type: 'string', multiple: true, default: [] },
        project: { type: 'string', default: 'ensemus' },
        'env-file': { type: 'string' },
      },
    });
    const [folder] = positionals;
    const trustRoot = values['trust-root'];
    const stateDir = values['state-dir'];
    if (positionals.length !== 1 || !folder || !trustRoot || !stateDir) return null;
    if (!PROJECT_NAME.test(values.project)) return null;
    return {
      folder: path.resolve(folder),
      trustRoot,
      stateDir,
      dryRun: values['dry-run'],
      rollback: values.rollback,
      backupRestored: values['backup-restored'],
      confirmOutsideRights: values['confirm-outside-rights'],
      operator: values.operator,
      backupReference: values['backup-reference'],
      license: values.license,
      maintenance: values.maintenance,
      project: values.project,
      envFile: values['env-file'],
    };
  } catch {
    return null;
  }
}

const isMissingFile = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/**
 * What is running now, from the signed manifest kept when it was installed. Never a guess: a missing manifest
 * beside a record that says something is installed would otherwise read as a first install, and let any old
 * bundle in with nothing to compare it against.
 */
async function readInstalled(
  stateDir: string,
  root: TrustRoot,
): Promise<{ ok: true; manifest: BundleManifest | null } | { ok: false; code: string }> {
  const text = await readIfPresent(path.join(stateDir, INSTALLED_MANIFEST_FILE));
  if (text === null) {
    const record = await readIfPresent(path.join(stateDir, INSTALLATION_RECORD_FILE));
    if (record !== null && record.trim() !== '') {
      return { ok: false, code: 'INSTALLED_STATE_MISSING' };
    }
    return { ok: true, manifest: null };
  }
  const verdict = verifyDocument('bundle', text, root);
  if (!verdict.ok) return { ok: false, code: 'INSTALLED_MANIFEST_REFUSED' };
  return { ok: true, manifest: verdict.document };
}

type Rights = { verdict: UpdateRightVerdict | null; licenseId: string | null };

/**
 * Update rights, from signed documents and nothing else (ADR-030 D4, D5). A license that does not verify counts
 * as none and says so, because no damaged file may stop a security fix reaching someone. A maintenance statement
 * or policy that does not verify, or is about another license, is left out, which can only narrow what is
 * covered and so is safe to do in the customer's own tool.
 */
async function readRights(
  options: Options,
  manifest: BundleManifest,
  root: TrustRoot,
  io: InstallIo,
): Promise<Rights> {
  if (!options.license) return { verdict: null, licenseId: null };
  const licenseText = await readIfPresent(options.license);
  const license = licenseText === null ? null : verifyDocument('license', licenseText, root);
  if (!license?.ok) {
    io.err('The license could not be verified, so this install goes on as if there were none.');
    return { verdict: null, licenseId: null };
  }

  const agreements = [];
  for (const file of options.maintenance) {
    const text = await readIfPresent(file);
    const statement = text === null ? null : verifyDocument('maintenance', text, root);
    if (statement?.ok && statement.document.license_id === license.document.license_id) {
      agreements.push(statement.document);
    } else {
      io.err('A maintenance statement was left out: it could not be verified for this license.');
    }
  }

  // The support policy travels in the bundle, signed in its own right, and can only add to the license.
  const policies = [];
  for (const file of manifest.files.filter((entry) => entry.role === 'support_policy')) {
    const text = await readFile(path.join(options.folder, ...file.path.split('/')), 'utf8');
    const policy = verifyDocument('support_policy', text, root);
    if (policy.ok) policies.push(policy.document);
    else io.err(`A support policy in the bundle was left out: code=${policy.code}`);
  }

  const verdict = evaluateUpdateRight({
    license: license.document,
    agreements,
    policies,
    release: manifest.release,
    today: dayOf(io.now()),
  });
  return { verdict, licenseId: license.document.license_id };
}

function printConstraints(codes: readonly string[], io: InstallIo) {
  if (codes.length === 0) {
    io.out('Rollback limits listed by the manifest: none known. That is not a promise of none.');
    return;
  }
  io.out('Rollback limits listed by the manifest:');
  const known: Readonly<Record<string, string>> = KNOWN_ROLLBACK_CONSTRAINTS;
  for (const code of codes) {
    io.out(`  ${code}: ${known[code] ?? 'Not known to this tool. See that release’s guide.'}`);
  }
}

const describeStep = (step: InstallPlanStep) => {
  switch (step.kind) {
    case 'load_image':
      return `load_image ${step.name} from ${step.file}`;
    case 'check_image_digest':
      return `check_image_digest ${step.name} is ${step.digest}`;
    default:
      return step.kind;
  }
};

type Stop = { code: string; advice?: string };

/** Compose prints one JSON object per line, and older versions print one array. */
function parseComposePs(stdout: string): Record<string, unknown>[] | null {
  const text = stdout.trim();
  if (text === '') return [];
  try {
    if (text.startsWith('[')) return JSON.parse(text) as Record<string, unknown>[];
    return text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Carries out the steps in order. Each one either passes or stops the whole run, and what a stop tells the
 * operator depends on how far things got, since that decides what getting back to where they were takes.
 */
async function carryOut(
  steps: readonly InstallPlanStep[],
  context: {
    options: Options;
    manifest: BundleManifest;
    direction: 'install' | 'upgrade' | 'rollback';
    rights: Rights;
    io: InstallIo;
  },
): Promise<number> {
  const { options, manifest, direction, rights, io } = context;
  const { version } = manifest.release;
  const env = { ENSEMUS_RELEASE: version };
  const compose = (...rest: string[]) =>
    io.docker(
      [
        'compose',
        '-p',
        options.project,
        ...(options.envFile ? ['--env-file', options.envFile] : []),
        '-f',
        path.join(options.folder, ...COMPOSE_BASE.split('/')),
        '-f',
        path.join(options.folder, ...COMPOSE_OVERLAY.split('/')),
        ...rest,
      ],
      env,
    );

  const progress = { stage: 'untouched' as 'untouched' | 'stopped' | 'migrating' };
  const loaded = new Map<string, readonly string[]>();

  const carryOutStep = async (step: InstallPlanStep): Promise<Stop | null> => {
    switch (step.kind) {
      case 'verify_bundle':
        // Already done, since the plan is built from what it verified. Named so the printed list is complete.
        io.out('  verified against the trust root given');
        return null;

      case 'confirm_outside_rights':
        if (!options.confirmOutsideRights) {
          return {
            code: 'OUTSIDE_RIGHTS_NOT_CONFIRMED',
            advice:
              'This release is outside what the license covers. Pass --confirm-outside-rights to go on, which is recorded.',
          };
        }
        io.out('  confirmed: this release is outside what the license covers');
        return null;

      case 'require_backup':
        if (!options.backupReference || options.backupReference.length > MAX_OPERATOR_TEXT) {
          return {
            code: 'BACKUP_REQUIRED',
            advice: 'Take a backup first, then name it with --backup-reference.',
          };
        }
        io.out(
          `  backup named: ${options.backupReference}. This tool cannot check that it exists or restores, so that part is yours.`,
        );
        return null;

      case 'load_image': {
        const result = await io.docker(
          ['load', '-i', path.join(options.folder, ...step.file.split('/'))],
          env,
        );
        if (result.status !== 0) return { code: 'IMAGE_LOAD_FAILED' };
        const references = [...result.stdout.matchAll(/^Loaded image(?: ID)?: (\S+)\s*$/gm)].map(
          (match) => match[1] as string,
        );
        loaded.set(step.name, references);
        return null;
      }

      case 'check_image_digest': {
        const references = loaded.get(step.name) ?? [];
        if (references.length === 0) return { code: 'IMAGE_NOT_CONFIRMED' };
        // Every image the archive brought has to be the signed one, so nothing can come in beside it.
        for (const reference of references) {
          const result = await io.docker(
            ['image', 'inspect', '--format', '{{.Id}}', reference],
            env,
          );
          const id = result.stdout.trim();
          if (result.status !== 0) return { code: 'IMAGE_NOT_CONFIRMED' };
          if (id !== step.digest) {
            return {
              code: 'IMAGE_DIGEST_DIFFERS',
              advice: `${step.name}: the manifest says ${step.digest}, and the archive loaded ${id}.`,
            };
          }
        }
        const named = await io.docker(
          ['tag', step.digest, releaseImageName(step.name, version)],
          env,
        );
        return named.status === 0 ? null : { code: 'IMAGE_NOT_CONFIRMED' };
      }

      case 'stop_services': {
        progress.stage = 'stopped';
        const result = await compose('stop');
        return result.status === 0 ? null : { code: 'STOP_FAILED' };
      }

      case 'restore_backup':
        if (!options.backupRestored) {
          return {
            code: 'RESTORE_REQUIRED',
            advice:
              `Services are stopped and no migration has run. Restore ${options.backupReference ?? 'the backup'} now, as ` +
              'backup-and-restore.md says, then run this again with --backup-restored. A rollback cannot be done without it: no migration is undone.',
          };
        }
        io.out(
          '  the operator says the backup was restored. This tool cannot check that, and starting an older version on a newer database is what it exists to avoid.',
        );
        return null;

      case 'run_migrations': {
        progress.stage = 'migrating';
        const result = await compose('run', '--rm', '--pull', 'never', 'migrate');
        return result.status === 0 ? null : { code: 'MIGRATIONS_FAILED' };
      }

      case 'start_services': {
        const result = await compose(
          'up',
          '--detach',
          '--wait',
          '--no-build',
          '--pull',
          'never',
          '--remove-orphans',
        );
        return result.status === 0 ? null : { code: 'START_FAILED' };
      }

      case 'smoke_test':
        return smokeTest(manifest, await compose('ps', '--format', 'json'), io, env);

      case 'record_installation': {
        await recordInstallation(options, manifest, direction, rights, io);
        io.out(`  recorded in ${path.join(options.stateDir, INSTALLATION_RECORD_FILE)}`);
        return null;
      }
    }
  };

  for (const step of steps) {
    io.out(`step: ${describeStep(step)}`);
    const stop = await carryOutStep(step);
    if (!stop) continue;
    io.err(`stopped code=${stop.code} at=${step.kind}`);
    if (stop.advice) io.err(stop.advice);
    if (progress.stage === 'untouched') io.err('The running version was not touched.');
    if (progress.stage === 'stopped' && stop.code !== 'RESTORE_REQUIRED') {
      io.err('Services are stopped, and no migration has run. Nothing has been recorded.');
    }
    if (progress.stage === 'migrating') {
      io.err(
        `Migrations may have run, and nothing undoes them. Before running any older version, restore ${options.backupReference ?? 'your backup'}. Nothing has been recorded.`,
      );
    }
    return 1;
  }
  io.out(`done direction=${direction} version=${version}`);
  return 0;
}

/**
 * The stack as Compose reports it. `up --wait` has already waited for health, so what this adds is that each
 * running container really is what was verified, since a tag can be moved and a stray service would otherwise
 * run unnoticed. What the product does once it is up is for the rehearsal and the acceptance test to prove.
 */
async function smokeTest(
  manifest: BundleManifest,
  ps: DockerResult,
  io: InstallIo,
  env: Readonly<Record<string, string>>,
): Promise<Stop | null> {
  const failed = (advice: string): Stop => ({ code: 'SMOKE_TEST_FAILED', advice });
  if (ps.status !== 0) return failed('Could not list what is running.');
  const rows = parseComposePs(ps.stdout);
  if (!rows) return failed('Could not read what Compose reported.');

  const digestOf = new Map(
    manifest.images.map((image) => [
      releaseImageName(image.name, manifest.release.version),
      image.digest,
    ]),
  );
  const services = new Set<string>();
  for (const row of rows) {
    const service = String(row.Service);
    services.add(service);
    if (row.State !== 'running') return failed(`${service} is not running.`);
    if (row.Health !== undefined && row.Health !== '' && row.Health !== 'healthy') {
      return failed(`${service} is not healthy.`);
    }
    const expected = digestOf.get(String(row.Image));
    if (!expected) return failed(`${service} is not running an image from this bundle.`);
    const actual = await io.docker(['inspect', '--format', '{{.Image}}', String(row.ID)], env);
    if (actual.status !== 0 || actual.stdout.trim() !== expected) {
      return failed(`${service} is not running the image the manifest signed.`);
    }
  }
  for (const required of ['web', 'worker']) {
    if (manifest.images.some((image) => image.name === required) && !services.has(required)) {
      return failed(`${required} is not running.`);
    }
  }
  if (services.size === 0) return failed('Nothing is running.');
  io.out(`  ${String(services.size)} services running, each from an image this bundle signed`);
  return null;
}

/** One appended line, then the manifest that says what is installed now, swapped in whole. */
async function recordInstallation(
  options: Options,
  manifest: BundleManifest,
  direction: 'install' | 'upgrade' | 'rollback',
  rights: Rights,
  io: InstallIo,
) {
  const record: InstallationRecord = {
    recorded_at: io.now().toISOString(),
    direction,
    bundle_id: manifest.bundle_id,
    version: manifest.release.version,
    images: manifest.images.map(({ name, digest }) => ({ name, digest })),
    license_id: rights.licenseId,
    update_right: !rights.verdict
      ? 'no_license'
      : rights.verdict.covered
        ? 'covered'
        : 'outside_rights_confirmed',
    operator: options.operator ?? '',
    backup_reference: options.backupReference ?? '',
  };
  await mkdir(options.stateDir, { recursive: true });
  await appendFile(
    path.join(options.stateDir, INSTALLATION_RECORD_FILE),
    `${JSON.stringify(record)}\n`,
  );
  const signed = await readFile(path.join(options.folder, BUNDLE_MANIFEST_FILE), 'utf8');
  const target = path.join(options.stateDir, INSTALLED_MANIFEST_FILE);
  await writeFile(`${target}.new`, signed);
  await rename(`${target}.new`, target);
}

export async function runInstallBundle(argv: readonly string[], io: InstallIo): Promise<number> {
  const options = parseOptions(argv);
  if (!options) {
    io.err(USAGE);
    return 2;
  }
  const refuse = (code: string) => {
    io.err(`stopped code=${code}`);
    return 1;
  };

  // Before anything else, so a real run never gets part way and then asks who is doing this.
  if (!options.dryRun && (!options.operator || options.operator.length > MAX_OPERATOR_TEXT)) {
    io.err('A real run needs --operator, naming who is doing this, in up to 200 characters.');
    return 2;
  }
  if (await isInsideFolder(options.stateDir, options.folder)) return refuse('STATE_INSIDE_BUNDLE');

  const trust = await loadOperatorTrustRoot(options.trustRoot, options.folder);
  if (!trust.ok) return refuse(trust.code);

  const verdict = await verifyBundleDirectory(options.folder, trust.root);
  if (!verdict.ok) {
    return refuse(
      [
        verdict.code,
        ...(verdict.reason ? [`reason=${verdict.reason}`] : []),
        ...(verdict.path ? [`path=${verdict.path}`] : []),
      ].join(' '),
    );
  }
  const { manifest } = verdict;
  if (verdict.testKey) {
    io.out('Signed with a generated test key. This bundle is for rehearsal, and nothing else.');
  }

  const roles = new Map(manifest.files.map((file) => [file.path, file.role]));
  if (roles.get(COMPOSE_BASE) !== 'compose' || roles.get(COMPOSE_OVERLAY) !== 'compose') {
    return refuse('COMPOSE_FILES_NOT_LISTED');
  }

  const installed = await readInstalled(options.stateDir, trust.root);
  if (!installed.ok) return refuse(installed.code);

  const rights = await readRights(options, manifest, trust.root, io);
  const plan = planInstall({
    manifest,
    installed: installed.manifest && {
      version: installed.manifest.release.version,
      rollback_to: installed.manifest.compatibility.rollback_to,
    },
    rollbackRequested: options.rollback,
    onInstall: rights.verdict?.onInstall ?? null,
  });
  if (!plan.ok) return refuse(plan.code);
  // The operator asked to go back and this would go forward. Whichever they meant, they should look again.
  if (options.rollback && plan.direction !== 'rollback') return refuse('NOT_A_ROLLBACK');

  io.out(
    `plan direction=${plan.direction} version=${manifest.release.version} installed=${installed.manifest?.release.version ?? 'none'}`,
  );
  // Going back, the limits are those of the version going away. Going forward, the operator has to have these
  // before upgrading, which the runbook requires, since they decide whether coming back is possible.
  printConstraints(
    plan.direction === 'rollback' && installed.manifest
      ? installed.manifest.compatibility.rollback_constraints
      : manifest.compatibility.rollback_constraints,
    io,
  );

  if (options.dryRun) {
    for (const step of plan.steps) io.out(`step: ${describeStep(step)}`);
    io.out('Dry run: no Docker was called, and nothing was written.');
    return 0;
  }
  return carryOut(plan.steps, {
    options,
    manifest,
    direction: plan.direction,
    rights,
    io,
  });
}

/** The real Docker. Its progress goes straight to the operator, and only stdout comes back to be read. */
const runDocker: InstallIo['docker'] = (args, env) =>
  new Promise((resolve) => {
    const child = spawn('docker', [...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => {
      resolve({ status: 127, stdout: '' });
    });
    child.on('close', (status) => {
      resolve({ status: status ?? 1, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });

const invokedDirectly = () => {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(realpathSync(entry)).href === import.meta.url;
};

if (invokedDirectly()) {
  process.exitCode = await runInstallBundle(process.argv.slice(2), {
    docker: runDocker,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date(),
  }).catch((error: unknown) => {
    process.stderr.write(`failed code=${(error as NodeJS.ErrnoException).code ?? 'UNEXPECTED'}\n`);
    return 1;
  });
}
