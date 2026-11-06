#!/usr/bin/env node
// PLAT-16: runs the stack with outbound traffic blocked and counted. Any attempt fails the build.
//   node infrastructure/scripts/air-gap-gate.mjs            full gate
//   node infrastructure/scripts/air-gap-gate.mjs --control  proves a real attempt is detected
//   node infrastructure/scripts/air-gap-gate.mjs --outages  only the outage round, without the suite
//   node infrastructure/scripts/air-gap-gate.mjs --connectors  the connectors profile, with the test
//     relay inside the counted subnet: mail goes out to it, and still no packet may leave (ADR-027 D5)
import { File } from 'node:buffer';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  containersOffTheSubnet,
  expectedFile,
  expectedHealth,
  SUBNET,
  WATCHED_PREFIX,
  WEB_REPLICAS,
  wrongAnswer,
} from './air-gap-rules.mjs';

// The gate's firewall rule covers the default addresses, so a site's own prefix must not move the stack.
// Set, not deleted: Compose lets the environment beat a .env file, and with the variable gone a .env
// value would move the stack off the watched subnet. A check after each start proves it did not.
process.env.ENSEMUS_NETWORK_PREFIX = WATCHED_PREFIX;
// The same goes for how the gate reaches the stack. A site's own ENSEMUS_HOSTNAME must not move the
// proxy's only site off `localhost`, so requests can use that name, on the port the stack really
// published.
const PORT = process.env.ENSEMUS_HTTPS_PORT ?? '8443';
const ORIGIN = `https://localhost:${PORT}`;
process.env.ENSEMUS_HOSTNAME = 'localhost';
process.env.ENSEMUS_TRUSTED_PROXIES = '';
process.env.ENSEMUS_HTTPS_PORT = PORT;
process.env.ENSEMUS_BIND_ADDRESS = '127.0.0.1';
process.env.ENSEMUS_PUBLIC_URL = ORIGIN;
process.env.ENSEMUS_TEST_BASE = ORIGIN; // tests/helpers/forms.ts reads this when it loads.

const connectorsRound = process.argv.includes('--connectors');
if (connectorsRound) {
  // Every compose call below inherits these. The other rounds run with no profile, as they always did.
  process.env.COMPOSE_PROFILES = 'connectors';
  process.env.ENSEMUS_CONNECTORS_ENABLED = 'true';
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHAIN = 'DOCKER-USER';
// A pinned image that includes iptables. It needs host networking to reach the engine's firewall.
const TOOLS = 'nicolaka/netshoot:v0.14';
const composeFiles = [
  'infrastructure/compose/compose.yaml',
  'infrastructure/compose/compose.test.yaml',
  'infrastructure/compose/compose.airgap.yaml',
].flatMap((f) => ['-f', f]);

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
const compose = (...args) => run('docker', ['compose', ...composeFiles, ...args]);
const firewall = (...args) =>
  run('docker', ['run', '--rm', '--privileged', '--network', 'host', TOOLS, 'iptables', ...args]);

const RULE = ['-s', SUBNET, '!', '-d', SUBNET, '-m', 'conntrack', '--ctstate', 'NEW', '-j', 'DROP'];

function installRule() {
  firewall('-I', CHAIN, '1', ...RULE);
}
function removeRule() {
  try {
    firewall('-D', CHAIN, ...RULE);
  } catch {
    // Already gone.
  }
}
function attempts() {
  const listing = firewall('-L', CHAIN, '-v', '-n', '-x');
  const line = listing.split('\n').find((l) => l.includes('DROP') && l.includes(SUBNET));
  if (!line) throw new Error('Air-gap rule is missing, so this result cannot be trusted');
  return Number(line.trim().split(/\s+/)[0]);
}

// Records offending packets, so that a failure names its cause instead of only counting it.
function startCapture() {
  const lines = [];
  const child = spawn('docker', [
    'run',
    '--rm',
    '--name',
    'ensemus-airgap-capture',
    '--privileged',
    '--network',
    'host',
    TOOLS,
    'tcpdump',
    '-i',
    'any',
    '-nn',
    '-l',
    '-Q',
    'in',
    `src net ${SUBNET} and not dst net ${SUBNET}`,
  ]);
  child.stdout.on('data', (chunk) => lines.push(String(chunk)));
  child.on('error', () => undefined);
  return {
    async report() {
      const closed = new Promise((done) => child.on('close', done));
      spawnSync('docker', ['stop', '-t', '1', 'ensemus-airgap-capture']);
      // The synchronous calls above block the event loop, so output is only read while waiting here.
      await closed;
      const packets = lines.join('').split(/\r?\n/).filter(Boolean);
      if (!packets.length) return;
      console.log('Offending packets:');
      for (const line of [...new Set(packets.map((p) => p.replace(/^\S+\s+/, '')))].slice(0, 20)) {
        console.log(`  ${line.slice(0, 140)}`);
      }
      console.log('Container addresses:');
      const ids = compose('ps', '-aq').trim().split(/\s+/).filter(Boolean);
      for (const id of ids) {
        console.log(
          `  ${run('docker', [
            'inspect',
            id,
            '--format',
            '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
          ]).trim()}`,
        );
      }
    },
  };
}

function down() {
  try {
    compose('down', '-v', '--remove-orphans');
  } catch {
    // Nothing was running.
  }
}

/** A result that says zero attempts means nothing for a container the rule cannot see. */
function refuseUnlessOnTheWatchedSubnet() {
  const containers = compose('ps', '-q')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => {
      const [name = id, ...addresses] = run('docker', [
        'inspect',
        id,
        '--format',
        '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
      ])
        .trim()
        .split(/\s+/);
      return { name, addresses };
    });
  const problems = containersOffTheSubnet(containers);
  if (problems.length) {
    throw new Error(
      `The stack is not all on ${SUBNET}, so this cannot pass: ${problems.join('; ')}`,
    );
  }
}

// Stops each internal service in turn while the others keep working and requests keep arriving. A name
// that is not pinned leaves the network here, because Docker forwards a stopped container's name, but
// only if something uses the name while its service is stopped. So every request has to get the answer
// that shows it did. Postgres and temporal also have the worker and dispatcher as clients all the time.
// Valkey has no client yet (ADR-025 D9), so its round can only show that nothing else breaks.
const OUTAGES = ['web-2', 'web', 'objects', 'valkey', 'temporal', 'postgres'];
const OUTAGE_SECONDS = 20;
const HEALTH = '/api/health/ready';
// The longest a request may take: the store's client tries 3 times, with 5 seconds to connect each.
const ANSWER_MS = 45_000;
const BACK_WITHIN_MS = 120_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function exerciseOutages() {
  const forms = await import(pathToFileURL(join(root, 'tests/helpers/forms.ts')).href);

  /** One request through the proxy, to one replica. Anything but a response is status 0. */
  const ask = (replica, path, jar) => {
    const answer = forms
      .onReplica(replica, () => forms.visit(path, jar))
      .then(async (response) => {
        await response.arrayBuffer();
        return { status: response.status, servedBy: response.headers.get('x-ensemus-served-by') };
      })
      .catch(() => ({ status: 0, servedBy: null }));
    const late = sleep(ANSWER_MS).then(() => ({ status: 0, servedBy: null }));
    return Promise.race([answer, late]);
  };

  // Something stored, to read back through each replica: a signed-in read is what reaches the store.
  const owner = await forms.signUp('Outage Owner');
  const organization = await forms.createOrganization(owner, `Outage ${randomUUID()}`);
  const created = await forms.submit(`/o/${organization}/work/new`, owner.jar, /name="title"/, {
    classification: 'internal',
    title: `Through an outage ${randomUUID()}`,
  });
  const page = created.headers.get('location');
  if (!page) throw new Error(`Work not created: status ${created.status}`);
  await forms.submit(page, owner.jar, /name="file"/, {
    file: new File(['Kept through an outage.'], 'outage.txt', { type: 'text/plain' }),
  });
  const file = /href="([^"]+\/files\/[0-9a-f-]{36})">outage\.txt</.exec(
    (await forms.read(page, owner.jar)).html,
  )?.[1];
  if (!file) throw new Error('The file for the outage round was not stored');

  const healthProblem = async (stopped, replica) =>
    wrongAnswer(await ask(replica, HEALTH), expectedHealth(stopped, replica));
  const fileProblem = async (stopped, replica) =>
    wrongAnswer(await ask(replica, file, owner.jar), expectedFile(stopped, replica));

  /** Before any outage, both routes must really answer. Otherwise a round proves nothing. */
  async function bothReplicasAnswering(before) {
    const deadline = Date.now() + BACK_WITHIN_MS;
    for (;;) {
      const problems = (
        await Promise.all(
          WEB_REPLICAS.flatMap((replica) => [
            healthProblem(undefined, replica).then((p) => p && `${replica} health: ${p}`),
            fileProblem(undefined, replica).then((p) => p && `${replica} file: ${p}`),
          ]),
        )
      ).filter(Boolean);
      if (problems.length === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`Before stopping ${before}: ${problems.join('; ')}`);
      }
      await sleep(2000);
    }
  }

  const wrong = new Set();
  for (const service of OUTAGES) {
    await bothReplicasAnswering(service);
    console.log(`Outage: stopping ${service} for ${OUTAGE_SECONDS} seconds...`);
    compose('stop', service);
    const deadline = Date.now() + OUTAGE_SECONDS * 1000;
    let exchanges = 0;
    while (Date.now() < deadline) {
      const asked = WEB_REPLICAS.flatMap((replica) => {
        const note = (what) => (problem) => {
          if (problem) wrong.add(`${service} stopped, ${replica} ${what}: ${problem}`);
        };
        return [
          healthProblem(service, replica).then(note('health')),
          // Only people's files use the store's name from web, so this is the round to ask for one.
          ...(service === 'objects' ? [fileProblem(service, replica).then(note('file'))] : []),
        ];
      });
      await Promise.all(asked);
      exchanges += asked.length;
      await sleep(2000);
    }
    console.log(`  ${exchanges} requests answered as this outage should.`);
    compose('up', '-d', '--wait', '--wait-timeout', '300');
  }
  await bothReplicasAnswering('nothing, at the end of the rounds');
  return [...wrong];
}

const control = process.argv.includes('--control');
const outagesOnly = process.argv.includes('--outages');
let failed = false;

try {
  run('docker', ['pull', '-q', TOOLS]);
  down();
  console.log('Building images...');
  compose('build');
  // Count from before the first container starts. Version checks and similar calls often fire
  // during startup, and a rule installed afterwards would never see them.
  installRule();
  const before = attempts();
  const capture = startCapture();
  await new Promise((done) => setTimeout(done, 3000)); // Let the capture start.
  console.log('Starting the stack with outbound traffic blocked...');
  compose('up', '-d', '--wait', '--wait-timeout', '300');
  refuseUnlessOnTheWatchedSubnet();

  if (control) {
    // The rule must see a direct connection and an outside DNS lookup from inside a container.
    spawnSync(
      'docker',
      [
        ...['compose', ...composeFiles],
        'exec',
        '-T',
        'web',
        'node',
        '-e',
        `require('net').connect({host:'1.1.1.1',port:443,timeout:3000}).on('error',()=>{}).on('timeout',function(){this.destroy()});
       require('dns').lookup('example.com',()=>{});setTimeout(()=>process.exit(0),6000)`,
      ],
      { cwd: root },
    );
    const seen = attempts() - before;
    console.log(`Control: ${seen} outbound packet(s) detected from a deliberate attempt.`);
    await capture.report();
    if (seen === 0) {
      console.error('FAILED: the gate did not detect a deliberate outbound attempt.');
      failed = true;
    } else {
      console.log('OK: the gate can see outbound attempts.');
    }
  } else if (connectorsRound) {
    console.log('Sending mail through the test relay with outbound traffic blocked...');
    const tests = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', '--project', 'stack', 'tests/stack/slice-2.test.ts'],
      {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: { ...process.env, ENSEMUS_COMPOSE_AIRGAP: '1' },
      },
    );
    if (tests.status !== 0) {
      console.error('FAILED: the connectors tests did not pass while offline.');
      failed = true;
    }
    // Zero packets would prove nothing about a path that was never used.
    const controlPort = process.env.ENSEMUS_TEST_SMTP_CONTROL_PORT ?? '58025';
    const stats = await fetch(`http://127.0.0.1:${controlPort}/stats`).then((r) => r.json());
    console.log(`Messages the test relay took: ${stats.received}`);
    if (!(stats.received > 0)) {
      console.error('FAILED: no mail reached the test relay, so this round proved nothing.');
      failed = true;
    }
    const seen = attempts() - before;
    console.log(`Outbound attempts during the run: ${seen}`);
    await capture.report();
    if (seen > 0) {
      console.error('FAILED: something other than the relay was reached.');
      failed = true;
    } else if (!failed) {
      console.log('OK: mail reached the relay, and nothing else was contacted.');
    }
  } else {
    if (!outagesOnly) {
      console.log('Running the stack test suite with outbound traffic blocked...');
      const tests = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'stack'], {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: { ...process.env, ENSEMUS_COMPOSE_AIRGAP: '1' },
      });
      if (tests.status !== 0) {
        console.error('FAILED: stack tests did not pass while offline.');
        failed = true;
      }
    }
    const wrongAnswers = await exerciseOutages();
    refuseUnlessOnTheWatchedSubnet();
    const seen = attempts() - before;
    console.log(`Outbound attempts during the run: ${seen}`);
    await capture.report();
    if (wrongAnswers.length) {
      console.error(
        'FAILED: during the outages, requests did not get the answer that proves them:',
      );
      for (const problem of wrongAnswers.slice(0, 20)) console.error(`  ${problem}`);
      failed = true;
    }
    if (seen > 0) {
      console.error('FAILED: something tried to reach the outside network.');
      failed = true;
    } else if (!failed) {
      console.log('OK: the stack ran offline with zero outbound attempts.');
    }
  }
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  failed = true;
} finally {
  spawnSync('docker', ['rm', '-f', 'ensemus-airgap-capture']);
  removeRule();
  if (!process.argv.includes('--keep')) down();
}
process.exit(failed ? 1 : 0);
