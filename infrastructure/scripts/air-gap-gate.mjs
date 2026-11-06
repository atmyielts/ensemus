#!/usr/bin/env node
// PLAT-16: runs the stack with outbound traffic blocked and counted. Any attempt fails the build.
//   node infrastructure/scripts/air-gap-gate.mjs            full gate
//   node infrastructure/scripts/air-gap-gate.mjs --control  proves a real attempt is detected
//   node infrastructure/scripts/air-gap-gate.mjs --outages  only the outage round, without the suite
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The gate's firewall rule covers the default addresses, so a site's own prefix must not move the stack.
delete process.env.ENSEMUS_NETWORK_PREFIX;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUBNET = '172.30.0.0/16';
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

// Stops each internal service in turn while the others keep working and requests keep arriving. A name
// that is not pinned leaves the network here, because Docker forwards a stopped container's name.
const OUTAGES = ['web-2', 'web', 'objects', 'valkey', 'temporal', 'postgres'];
const OUTAGE_SECONDS = 20;

function askProxy(headers) {
  return new Promise((done) => {
    const port = process.env.ENSEMUS_HTTPS_PORT ?? '8443';
    const request = httpsRequest(
      { host: '127.0.0.1', port, path: '/', headers, rejectUnauthorized: false, timeout: 3000 },
      (response) => {
        response.resume();
        response.on('end', done);
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', done);
    request.end();
  });
}

async function exerciseOutages() {
  for (const service of OUTAGES) {
    console.log(`Outage: stopping ${service} for ${OUTAGE_SECONDS} seconds...`);
    compose('stop', service);
    for (let elapsed = 0; elapsed < OUTAGE_SECONDS; elapsed += 2) {
      await Promise.all([askProxy({}), askProxy({ 'X-Ensemus-Test-Replica': '2' })]);
      await new Promise((done) => setTimeout(done, 2000));
    }
    compose('up', '-d', '--wait', '--wait-timeout', '300');
  }
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
    await exerciseOutages();
    const seen = attempts() - before;
    console.log(`Outbound attempts during the run: ${seen}`);
    await capture.report();
    if (seen > 0) {
      console.error('FAILED: something tried to reach the outside network.');
      failed = true;
    } else if (!failed) {
      console.log('OK: the stack ran offline with zero outbound attempts.');
    }
  }
} finally {
  spawnSync('docker', ['rm', '-f', 'ensemus-airgap-capture']);
  removeRule();
  if (!process.argv.includes('--keep')) down();
}
process.exit(failed ? 1 : 0);
