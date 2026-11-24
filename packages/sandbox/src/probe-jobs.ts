import type { IsolationCheck } from '@ensemus/domain/sandbox';

const boot = [
  "'use strict';",
  "if (!process.versions.node.startsWith('24.')) process.exit(2);",
  "const fs = require('node:fs');",
].join('\n');

const status = "fs.readFileSync('/proc/self/status', 'utf8')";
const inspection: Partial<Record<IsolationCheck, string>> = {
  no_outbound_network: [
    "const socket = require('node:net').connect({ port: 9, host: '198.18.0.1' });",
    "socket.once('connect', () => done(false));",
    "socket.once('error', error => done(['EPERM', 'EACCES', 'ENETUNREACH', 'EHOSTUNREACH', 'EAFNOSUPPORT'].includes(error.code)));",
  ].join('\n'),
  no_dns: [
    "const socket = require('node:dgram').createSocket('udp4');",
    "socket.once('listening', () => { socket.close(); done(false); });",
    "socket.once('error', error => {",
    '  socket.close();',
    "  if (!['EPERM', 'EACCES', 'EAFNOSUPPORT'].includes(error.code)) return done(false);",
    "  const resolver = new (require('node:dns').Resolver)({ timeout: 250, tries: 1 });",
    "  resolver.setServers(['198.18.0.1']);",
    "  resolver.resolve4('ensemus-probe.invalid', problem =>",
    "    done(['ECONNREFUSED', 'ETIMEOUT', 'ENETUNREACH', 'EACCES'].includes(problem?.code)));",
    '});',
    "socket.bind(0, '0.0.0.0');",
  ].join('\n'),
  no_environment_credentials: [
    'const keys = Object.keys(process.env).sort();',
    "done(keys.join(',') === 'HOME,PATH' && process.env.HOME === '/tmp' &&",
    "     process.env.PATH === '/usr/local/bin:/usr/bin:/bin');",
  ].join('\n'),
  no_secret_mounts: [
    "const mounts = new Set(fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\\n').map(line => line.split(' ')[4]));",
    "const expected = new Set(['/', '/dev', '/proc', '/tmp', '/skill',",
    "  '/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom', '/dev/tty',",
    "  '/proc/acpi', '/proc/asound', '/proc/bus', '/proc/config.gz', '/proc/fs', '/proc/irq',",
    "  '/proc/kcore', '/proc/keys', '/proc/latency_stats', '/proc/sched_debug', '/proc/scsi',",
    "  '/proc/sys', '/proc/sysrq-trigger', '/proc/timer_list']);",
    "const absent = ['/run/secrets', '/var/run/secrets', '/sys/fs/cgroup', '/root/.ssh',",
    "  '/.aws', '/var/run/docker.sock'].every(path => !fs.existsSync(path));",
    "done(absent && ['/', '/dev', '/proc', '/tmp', '/skill'].every(path => mounts.has(path)) &&",
    '  [...mounts].every(path => expected.has(path)));',
  ].join('\n'),
  root_filesystem_read_only: "done(readOnly('/') && refusedWrite('/ensemus-probe'));",
  skill_directory_read_only: [
    // The bind mount must be read-only. File modes may reject an attempted write before the mount does.
    "done(readOnly('/skill') && refusedWrite('/skill/ensemus-probe', true) && refusedWrite('/skill/probe.cjs', true));",
  ].join('\n'),
  scratch_size_limited: [
    "const info = fs.statfsSync('/tmp');",
    'const capacity = info.bsize * info.blocks;',
    'if (info.type !== 0x01021994 || capacity !== limits.tmpfsMb * 1024 ** 2) return done(false);',
    "const handle = fs.openSync('/tmp/sandbox-probe', 'wx');",
    'const chunk = Buffer.alloc(65536, 1);',
    'let written = 0;',
    'try {',
    '  while (written <= capacity) written += fs.writeSync(handle, chunk);',
    '  done(false);',
    '} catch (error) {',
    "  done(error.code === 'ENOSPC' && written >= capacity - chunk.length);",
    '} finally {',
    '  fs.closeSync(handle);',
    "  fs.unlinkSync('/tmp/sandbox-probe');",
    '}',
  ].join('\n'),
  process_count_limited: [
    "const { Worker } = require('node:worker_threads');",
    "const program = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);';",
    'const workers = [];',
    'try {',
    '  for (let i = 0; i <= limits.pids; i++) workers.push(new Worker(program, { eval: true }));',
    '  done(false);',
    '} catch (error) {',
    '  const threads = /^Threads:\\s+(\\d+)$/m.exec(' + status + ');',
    "  done(error.code === 'ERR_WORKER_INIT_FAILED' && /EAGAIN/.test(error.message) && Number(threads?.[1]) === limits.pids);",
    '} finally {',
    '  for (const worker of workers) worker.terminate();',
    '}',
  ].join('\n'),
  no_host_process_view: [
    "const processes = fs.readdirSync('/proc').filter(dir => /^\\d+$/.test(dir));",
    "done(process.pid === 1 && processes.length === 1 && processes[0] === '1' &&",
    "  fs.readlinkSync('/proc/self') === '1');",
  ].join('\n'),
  no_new_privileges: [
    'const text = ' + status + ';',
    'done(process.getuid() === 1 && process.getgid() === 1 && /^NoNewPrivs:\\s+1$/m.test(text) &&',
    "  ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].every(field => new RegExp('^' + field + ':\\\\s+0+$', 'm').test(text)));",
  ].join('\n'),
};

const limitScripts: Partial<Record<IsolationCheck, string>> = {
  memory_limited: [
    'const chunks = [];',
    'attempt();',
    'for (let size = 0; size < limits.memoryMb + 32; size++) chunks.push(Buffer.alloc(1024 ** 2, 1));',
  ].join('\n'),
  wall_time_limited: 'attempt(); setTimeout(() => {}, limits.wallMs * 4);',
  cpu_time_limited: [
    'attempt();',
    'const ends = Date.now() + limits.cpuMs * 4;',
    'while (Date.now() < ends) { /* bounded CPU load */ }',
  ].join('\n'),
};

export function probePayload(check: IsolationCheck, limits: Record<string, number>): Buffer {
  return Buffer.from(
    [
      boot,
      'const limits = ' + JSON.stringify(limits) + ';',
      'const check = ' + JSON.stringify(check) + ';',
      'const done = passed => fs.writeSync(1, JSON.stringify({ check, passed }));',
      'const attempt = () => fs.writeSync(1, JSON.stringify({ check, attempted: true }));',
      "const readOnly = path => fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n')",
      "  .some(line => { const part = line.split(' '); return part[4] === path && part[5].split(',').includes('ro'); });",
      'const refusedWrite = (path, allowPermissionMode = false) => {',
      "  try { fs.closeSync(fs.openSync(path, 'a')); return false; }",
      "  catch (error) { return error.code === 'EROFS' || (allowPermissionMode && error.code === 'EACCES'); }",
      '};',
      '(function () {',
      inspection[check] ?? limitScripts[check],
      '})();',
    ].join('\n'),
  );
}
