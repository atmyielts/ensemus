#!/usr/bin/env node
// WORK-07, ADR-024: an approval paused by one release is decided on the next. Builds the images of a
// base commit, runs that stack, opens a plan through that release's own pages, upgrades to the images
// of this checkout with their migrations, approves, and checks the run carries on to checking and that
// a person can finish it. Replay proves the code still fits a history. Only this proves the real thing.
//   node infrastructure/scripts/upgrade-gate.mjs                 from the merge-base with main
//   node infrastructure/scripts/upgrade-gate.mjs --from <ref>    from any commit that can run a plan
//   node infrastructure/scripts/upgrade-gate.mjs --keep          leaves the stack up to look at
// It runs as its own Compose project on its own port, so it does not disturb the ensemus stack, and it
// removes the project, its images and its worktree afterwards, including what a failed run left.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertDiskHeadroom } from './disk-headroom.mjs';
import { cleanupUpgradeScratch } from './upgrade-cleanup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT = 'ensemus-upgrade';
const PORT = process.env.ENSEMUS_UPGRADE_PORT ?? '18443';
const BASE_URL = `https://localhost:${PORT}`;
const RUN_TIMEOUT_MS = 90_000;
// Every image either release built, so the clean-up can remove them all.
const BUILT_IMAGES = new Set();
const WORK_PAGE = 'apps/web/src/app/o/[organizationId]/work/[workUnitId]/page.tsx';
// Its oldest release: earlier runs have to drain first (see "Upgrades and rollback" in the runbook).
const RUN_ID_MIGRATION = '0004_work_integrity';

const argument = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const keep = process.argv.includes('--keep');

const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** What a base has to be able to do. Anything else is a wrong --from, not an upgrade failure. */
function reasonToRefuse(commit) {
  const show = (path) => {
    const result = spawnSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout : null;
  };
  if (!show('infrastructure/compose/compose.yaml')) return 'it has no stack to run';
  if (!show(WORK_PAGE)?.includes('Run the plan')) return 'it has no page that can run a plan';
  if (!show('packages/database/migrations/meta/_journal.json')?.includes(RUN_ID_MIGRATION)) {
    return `it is older than ${RUN_ID_MIGRATION}, and the runbook has such runs drain before upgrading`;
  }
  return null;
}

const commitOf = (ref) => git('rev-parse', '--verify', `${ref}^{commit}`);

function chooseBase() {
  const given = argument('--from');
  const commit = commitOf(given ?? git('merge-base', 'HEAD', 'main'));
  const refused = reasonToRefuse(commit);
  if (refused) {
    console.error(
      `Cannot upgrade from ${commit.slice(0, 7)}${given ? '' : ' (the merge-base with main)'}: ` +
        `${refused}. Pass --from with a commit that can run a plan.`,
    );
    process.exit(2);
  }
  return commit;
}

/** `ensemus/web:local` -> `web`: the name a release's own tag is made from. */
const imageName = (image) =>
  image
    .replace(/@.*$/, '')
    .replace(/:[^/]*$/, '')
    .split('/')
    .pop();

/**
 * Every service of one release's Compose file that runs an image the release builds itself, in every
 * profile: those with a build, and any (a replica, say) that reuses one of their images without one.
 * Read from Compose rather than listed here, so a worker added later can neither be pulled from a
 * registry nor be left running the other release.
 */
function locallyBuilt(composeFile, options) {
  const compose = (...args) =>
    execFileSync('docker', ['compose', '-f', composeFile, ...args], {
      ...options,
      // Profiles are named one by one: COMPOSE_PROFILES would otherwise narrow or widen the list.
      env: { ...options.env, COMPOSE_PROFILES: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const profiles = compose('config', '--profiles')
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
    .flatMap((name) => ['--profile', name]);
  const config = JSON.parse(compose(...profiles, 'config', '--format', 'json'));
  const services = Object.entries(config.services ?? {});
  const builtImages = new Set(
    services.filter(([, service]) => service.build).map(([name, service]) => service.image ?? name),
  );
  return Object.fromEntries(
    services
      .filter(([, service]) => service.build || builtImages.has(service.image))
      .map(([name, service]) => [name, imageName(service.image ?? name)]),
  );
}

/** One release's stack: its own compose file, under one project, tagged so nothing is overwritten. */
function stack(label, tree, scratch) {
  const override = join(scratch, `images-${label}.yaml`);
  const composeFile = join(tree, 'infrastructure/compose/compose.yaml');
  const files = ['-f', composeFile, '-f', override];
  const options = (stdio) => ({
    cwd: tree,
    encoding: 'utf8',
    stdio,
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      ENSEMUS_HTTPS_PORT: PORT,
      // Its own addresses, so it can run while the air-gap gate's stack is still up.
      ENSEMUS_NETWORK_PREFIX: '172.29',
      ENSEMUS_HOSTNAME: 'localhost',
      ENSEMUS_TRUSTED_PROXIES: '',
      ENSEMUS_PUBLIC_URL: BASE_URL,
      ENSEMUS_ALLOW_SIGNUP: 'true',
      // Every additional worker/replica in the current Compose file must use this release too.
      ENSEMUS_WEB_IMAGE: `ensemus-upgrade/web:${label}`,
      ENSEMUS_WORKER_IMAGE: `ensemus-upgrade/worker:${label}`,
    },
  });
  const command = ['compose', '-p', PROJECT, ...files];
  // Written on first use, because the base release's tree does not exist until its worktree is added.
  let images;
  const prepared = () => {
    if (!images) {
      images = locallyBuilt(composeFile, options('ignore'));
      if (!images.web || !images.worker) {
        throw new Error(`No locally built web and worker services in ${composeFile}`);
      }
      const services = Object.entries(images).map(([service, image]) => {
        BUILT_IMAGES.add(`ensemus-upgrade/${image}:${label}`);
        return `  ${service}: { image: 'ensemus-upgrade/${image}:${label}' }`;
      });
      writeFileSync(override, `services:\n${services.join('\n')}\n`);
    }
    return images;
  };
  const docker = (args) => {
    prepared();
    return ['docker', [...command, ...args]];
  };
  return {
    /** Each service that runs a locally built image, and that image's name. */
    images: prepared,
    /** Output goes to the console, for the steps that take minutes. */
    run: (...args) => execFileSync(...docker(args), options('inherit')),
    capture: (...args) => execFileSync(...docker(args), options(['ignore', 'pipe', 'pipe'])),
    quiet: (...args) => {
      try {
        return spawnSync(...docker(args), options('ignore'));
      } catch {
        // Its Compose file could not be read. Whatever runs under the project still has to go.
        return spawnSync('docker', ['compose', '-p', PROJECT, ...args], options('ignore'));
      }
    },
  };
}

const step = (message) => console.log(`\n== ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, check) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let problem = 'it never happened';
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      problem = String(error);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}: ${problem}`);
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

async function main() {
  assertDiskHeadroom([root, tmpdir()]);
  const baseCommit = chooseBase();
  const current = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain') !== '';
  console.log(
    `Upgrading ${baseCommit.slice(0, 7)} -> ${current.slice(0, 7)}${dirty ? ' with local changes' : ''}`,
  );

  // Secrets stay the same across an upgrade, as they do on a real installation.
  execFileSync(process.execPath, ['infrastructure/scripts/generate-test-secrets.mjs'], {
    cwd: root,
    stdio: 'inherit',
  });

  const scratchParent = realpathSync.native(tmpdir());
  const scratch = mkdtempSync(join(scratchParent, 'ensemus-upgrade-'));
  const tree = join(scratch, 'base');
  const before = stack('base', tree, scratch);
  const after = stack('current', root, scratch);

  const cleanUp = () => {
    after.quiet('down', '-v', '--remove-orphans');
    for (const image of BUILT_IMAGES) {
      spawnSync('docker', ['image', 'rm', '-f', image], { stdio: 'ignore' });
    }
    cleanupUpgradeScratch({
      scratchParent,
      scratch,
      tree,
      removeWorktree: (verifiedTree) =>
        spawnSync('git', ['worktree', 'remove', verifiedTree], { cwd: root, stdio: 'ignore' })
          .status === 0,
    });
  };

  let failed = false;
  try {
    after.quiet('down', '-v', '--remove-orphans'); // Whatever an interrupted run left.
    step(`Building the images of ${baseCommit.slice(0, 7)}, in a worktree outside the repository`);
    git('worktree', 'add', '--detach', tree, baseCommit);
    cpSync(join(root, '.local', 'secrets'), join(tree, '.local', 'secrets'), { recursive: true });
    before.run('build');
    step('Building the images of this checkout');
    assertDiskHeadroom([root, scratch]);
    after.run('build');

    step('Starting the base release');
    before.run('up', '-d', '--wait', '--wait-timeout', '300');

    // Only now, because it reads the address when it loads.
    process.env.ENSEMUS_TEST_BASE = BASE_URL;
    const forms = await import(pathToFileURL(join(root, 'tests/helpers/forms.ts')).href);
    await until('the base release to answer', async () => {
      const response = await forms.visit('/api/health/ready');
      return response.status === 200;
    });

    const sql = (statement) =>
      after
        .capture(
          'exec',
          '-T',
          'postgres',
          'psql',
          '-U',
          'postgres',
          '-d',
          'ensemus',
          '-v',
          'ON_ERROR_STOP=1',
          '-tAc',
          statement,
        )
        .trim();
    const statusOn = (html) =>
      /<dt>Status<\/dt><dd><span class="badge[^"]*">([^<]+)</.exec(html)?.[1];
    const migrationsApplied = () =>
      Number(sql('select count(*) from drizzle.__drizzle_migrations'));

    step('Opening a plan through the base release, as far as its paused approval');
    const owner = await forms.signUp('Olive Owner');
    const organization = await forms.createOrganization(owner, `Upgrade ${randomUUID()}`);
    const reviewer = await forms.signUp('Remy Reviewer');
    // How someone joins has changed between releases, and it is not what this gate is about.
    const reviewerMembership = sql(
      `insert into org.memberships (organization_id, user_id, role, status)
       select '${organization}', id, 'member', 'active' from identity.users
       where email = '${reviewer.email}' returning id`,
    )
      .split('\n')[0]
      .trim();

    const title = `Across a release ${randomUUID()}`;
    const created = await forms.submit(`/o/${organization}/work/new`, owner.jar, /name="title"/, {
      classification: 'internal',
      title,
      executionPlan: 'checklist',
      criteria: ['reviewer_approved'],
    });
    const id = /\/work\/([0-9a-f-]{36})$/.exec(created.headers.get('location') ?? '')?.[1];
    if (!id) throw new Error(`Work not created: ${created.status}`);
    const page = `/o/${organization}/work/${id}`;
    await forms.submit(page, owner.jar, (form) => form.hidden.get('to') === 'ready');
    await forms.submit(page, owner.jar, /Run the plan/, {
      reviewerMembershipId: reviewerMembership,
    });
    await until('the base release to pause for the review', async () => {
      const { html } = await forms.read(page, owner.jar);
      return statusOn(html) === 'Waiting for approval';
    });
    const paused = sql(
      `select w.run_id, a.id, a.action_hash, w.version from work.work_units w
       join work.approvals a on a.work_unit_id = w.id where w.id = '${id}'`,
    );
    const [runId, approvalId] = paused.split('|');
    if (!runId || !approvalId) throw new Error(`Nothing is paused: ${paused}`);
    const migrationsBefore = migrationsApplied();
    console.log(`Paused on run ${runId}, with ${migrationsBefore} migrations applied.`);

    step('Upgrading to this checkout, with its migrations, while the approval waits');
    after.run('up', '-d', '--wait', '--wait-timeout', '300');
    const migrationsAfter = migrationsApplied();
    console.log(`${migrationsAfter} migrations applied after the upgrade.`);
    // Every container still up that runs a locally built image runs this release's. One-shot jobs such
    // as migrate have exited, and services in profiles nobody enabled are not there.
    const running = new Set(after.capture('ps', '--services').trim().split('\n'));
    for (const service of ['web', 'worker', 'dispatcher']) {
      if (!running.has(service)) throw new Error(`${service} is not running after the upgrade`);
    }
    for (const [service, image] of Object.entries(after.images())) {
      if (!running.has(service)) continue;
      const container = after.capture('ps', '-q', service).trim();
      const actual = execFileSync(
        'docker',
        ['inspect', container, '--format', '{{.Config.Image}}'],
        { encoding: 'utf8' },
      ).trim();
      expectEqual(actual, `ensemus-upgrade/${image}:current`, `${service} image`);
    }
    await until('the upgraded release to answer', async () => {
      const response = await forms.visit('/api/health/ready');
      return response.status === 200;
    });

    step('Deciding on the new release what the old release asked');
    const waiting = await forms.read(page, owner.jar);
    expectEqual(statusOn(waiting.html), 'Waiting for approval', 'Status after the upgrade');
    const inList = await forms.read(`/o/${organization}/approvals`, reviewer.jar);
    if (!inList.html.includes(title)) throw new Error('The reviewer no longer has the approval');
    const approval = `/o/${organization}/approvals/${approvalId}`;
    const decided = await forms.submit(
      approval,
      reviewer.jar,
      (form) => form.hidden.get('decision') === 'approve',
    );
    expectEqual(decided.status, 303, 'The decision');

    step('Waiting for the run the old release started to carry on');
    await until('the run to reach checking', async () => {
      const { html } = await forms.read(page, owner.jar);
      return statusOn(html) === 'Checking';
    });
    // Only that run can have moved it: nothing else sends work for checking, and that step only acts
    // for the run holding the work. The same one review, and no second checklist, so nothing restarted.
    const moved = sql(
      `select a.run_id, a.status,
              (select count(*) from work.approvals o where o.work_unit_id = a.work_unit_id),
              (select count(*) from work.work_artifacts f where f.work_unit_id = a.work_unit_id)
       from work.approvals a where a.id = '${approvalId}'`,
    );
    expectEqual(moved, `${runId}|approved|1|1`, 'Run, review and files after the upgrade');

    step('Finishing it, as a person');
    const finished = await forms.submit(
      page,
      owner.jar,
      (form) => form.hidden.get('to') === 'completed',
    );
    expectEqual(finished.status, 303, 'Marking it done');
    const done = await forms.read(page, owner.jar);
    expectEqual(statusOn(done.html), 'Done', 'Status at the end');

    console.log(
      `\nOK: an approval paused on ${baseCommit.slice(0, 7)} was decided after upgrading to ` +
        `${current.slice(0, 7)}${dirty ? ' with local changes' : ''}, across ` +
        `${migrationsAfter - migrationsBefore} migration(s), and the work reached Done.`,
    );
  } catch (error) {
    failed = true;
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
    after.run('logs', '--tail', '40', 'web', 'worker', 'dispatcher', 'migrate');
    // migrate logs only an error code. PostgreSQL logs the message and the statement that failed.
    after.run('logs', '--tail', '60', 'postgres');
  } finally {
    if (keep) {
      console.log(`Left running as project ${PROJECT}, with the worktree at ${tree}.`);
    } else {
      step('Removing what this run made');
      cleanUp();
    }
  }
  process.exit(failed ? 1 : 0);
}

await main();
