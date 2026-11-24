import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileSandboxPolicy,
  ISOLATION_CHECKS,
  probePassed,
  SANDBOX_DEFAULT_CEILINGS,
  type IsolationCheck,
} from '@ensemus/domain/sandbox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOciSpec, SANDBOX_JOB_ENVIRONMENT } from './oci';
import { runIsolationProbe } from './probe';
import { RUNNER_MAX_REQUEST_BYTES, runnerProbeResponseSchema } from './protocol';
import {
  createOciCliRuntime,
  createSandboxRunnerServer,
  type ContainerRuntime,
  type RawJobResult,
} from './runner';
import { createScriptedRuntime, passingProbeReport } from './testing';

const ceilings = SANDBOX_DEFAULT_CEILINGS;
const compiled = compileSandboxPolicy(
  { runtime: 'node24', entry: 'main.cjs', network: { mode: 'none' }, limits: ceilings },
  ceilings,
);
if (!compiled.ok) throw new Error(compiled.code);
const { policy, policyHash } = compiled;
const authorization = 'Bearer test-token';
const jobBody = () => ({
  jobId: randomUUID(),
  policy,
  policyHash,
  files: [{ path: policy.entry, contentBase64: Buffer.from('sample source').toString('base64') }],
  stdinBase64: '',
});

function exited(body: object, overrides?: Partial<RawJobResult>): RawJobResult {
  const stdout = Buffer.from(JSON.stringify(body));
  return {
    ending: 'exited',
    exitCode: 0,
    wallMs: 10,
    cpuMs: 10,
    peakMemoryKb: 1000,
    stdout,
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    ...overrides,
  };
}

function probeResult(check: IsolationCheck, limits: typeof ceilings): RawJobResult {
  const attempt = { check, attempted: true };
  switch (check) {
    case 'wall_time_limited':
      return exited(attempt, { ending: 'wall_limit', exitCode: null, wallMs: limits.wallMs });
    case 'cpu_time_limited':
      return exited(attempt, { ending: 'cpu_limit', exitCode: null, cpuMs: limits.cpuMs });
    case 'memory_limited':
      return exited(attempt, {
        ending: 'memory_limit',
        exitCode: null,
        peakMemoryKb: 1024 * limits.memoryMb,
      });
    default:
      return exited({ check, passed: true });
  }
}

async function checkFor(input: Parameters<ContainerRuntime['run']>[0]): Promise<IsolationCheck> {
  const probe = await readFile(join(input.spec.mounts[2].source, 'probe.cjs'), 'utf8');
  const check = /const check = "([^"]+)"/.exec(probe)?.[1];
  const known = ISOLATION_CHECKS.find((item) => item === check);
  if (!known) throw new Error('Invalid probe fixture');
  return known;
}

const reportRuntime = (job: ContainerRuntime['run']) =>
  createScriptedRuntime({
    async run(input) {
      if (input.spec.process.args[2] !== '/skill/probe.cjs') return await job(input);
      return probeResult(await checkFor(input), input.limits);
    },
  });

let workRoot: string;
let server: Server | undefined;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'ensemus-runner-test-'));
});

afterEach(async () => {
  if (server) {
    const stopped = new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await stopped;
    server = undefined;
  }
  await rm(workRoot, { recursive: true, force: true });
});

async function start(runtime: ContainerRuntime | null, maxConcurrentJobs = 2) {
  server = createSandboxRunnerServer({
    runtime,
    rootfs: join(workRoot, 'rootfs'),
    workRoot: join(workRoot, 'jobs'),
    token: 'test-token',
    ceilings,
    maxConcurrentJobs,
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  return new URL('http://127.0.0.1:' + address.port);
}

function post(base: URL, body: unknown, signal?: AbortSignal) {
  return fetch(new URL('/v1/jobs', base), {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
}

async function probe(base: URL) {
  const result = await fetch(new URL('/v1/probe', base), { headers: { authorization } });
  expect(result.status).toBe(200);
  return runnerProbeResponseSchema.parse(await result.json());
}

function oversizedPost(base: URL, declared: boolean, authorized = true): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      new URL('/v1/jobs', base),
      {
        method: 'POST',
        headers: {
          ...(authorized ? { authorization } : {}),
          ...(declared
            ? { 'content-length': RUNNER_MAX_REQUEST_BYTES + 1 }
            : { 'transfer-encoding': 'chunked' }),
        },
      },
      (incoming) => {
        incoming.resume();
        resolve(incoming.statusCode ?? 0);
      },
    );
    outgoing.once('error', reject);
    outgoing.end(declared ? undefined : Buffer.alloc(RUNNER_MAX_REQUEST_BYTES + 1));
  });
}

describe('OCI policy', () => {
  it('uses distinct namespaces, leaves credential surfaces out, and applies resource limits', () => {
    const spec = buildOciSpec(policy, { rootfs: '/rootfs', skillDir: '/bundle/skill' });
    expect(spec.root).toEqual({ path: '/rootfs', readonly: true });
    expect(spec.process.env).toEqual(SANDBOX_JOB_ENVIRONMENT);
    expect(spec.linux.rootfsPropagation).toBe('rslave');
    expect(spec.process.args).toEqual(['/usr/local/bin/node', '--', '/skill/' + policy.entry]);
    expect(spec.process.user.uid).toBeGreaterThan(0);
    expect(spec.process.noNewPrivileges).toBe(true);
    expect(Object.values(spec.process.capabilities).flat()).toEqual([]);
    expect(spec.linux.namespaces.map(({ type }) => type)).toEqual([
      'pid',
      'network',
      'ipc',
      'uts',
      'mount',
      'user',
      'cgroup',
    ]);
    expect(spec.linux.uidMappings[0]?.hostID).toBeGreaterThan(0);
    expect(spec.linux.resources.pids.limit).toBe(ceilings.pids);
    expect(spec.linux.resources.memory.limit).toBe(ceilings.memoryMb * 1024 ** 2);
    expect(spec.linux.resources.memory.swap).toBe(spec.linux.resources.memory.limit);
    expect(spec.mounts[2].options).toEqual(['rbind', 'ro', 'nosuid', 'nodev', 'noexec']);
    expect(spec.mounts[3].options).toContain('size=' + ceilings.tmpfsMb * 1024 ** 2);
    expect(spec.linux.seccomp.defaultAction).toBe('SCMP_ACT_ERRNO');
    const allowed = spec.linux.seccomp.syscalls
      .filter((rule) => rule.action === 'SCMP_ACT_ALLOW')
      .flatMap((rule) => [...rule.names]);
    for (const forbidden of [
      'socket',
      'mount',
      'unshare',
      'setns',
      'ptrace',
      'bpf',
      'io_uring_setup',
    ]) {
      expect(allowed).not.toContain(forbidden);
    }
  });

  it('does not resolve an arbitrary executable through PATH', async () => {
    const runtime = createOciCliRuntime({ binary: 'runc', stateDir: workRoot });
    await expect(runtime.version()).rejects.toThrow('RUNTIME_PLATFORM_UNSUPPORTED');
  });
});

describe('runner HTTP admission', () => {
  it('refuses a missing runtime and checks credentials before accepting a body', async () => {
    const base = await start(null);
    expect((await fetch(new URL('/healthz', base))).status).toBe(200);
    expect((await fetch(new URL('/v1/probe', base))).status).toBe(401);
    expect(
      (
        await fetch(new URL('/v1/probe', base), {
          headers: { authorization: 'Bearer other' },
        })
      ).status,
    ).toBe(401);
    expect(await oversizedPost(base, true, false)).toBe(401);
    expect((await post(base, jobBody())).status).toBe(503);
    expect((await fetch(new URL('/v1/probe', base), { headers: { authorization } })).status).toBe(
      503,
    );
  });

  it('rejects declared and streaming oversized requests without calling the runtime', async () => {
    const runtime = reportRuntime(async () => exited({ executed: true }));
    const base = await start(runtime);
    expect(await oversizedPost(base, true)).toBe(413);
    expect(await oversizedPost(base, false)).toBe(413);
    expect(runtime.calls).toHaveLength(0);
  });

  it('rejects invalid policy, hashes, paths, bundles and base64 before starting a job', async () => {
    const runtime = reportRuntime(async () => exited({ executed: true }));
    const base = await start(runtime);
    expect((await post(base, {})).status).toBe(400);
    expect((await post(base, { ...jobBody(), jobId: '-'.repeat(36) })).status).toBe(400);
    expect((await post(base, { ...jobBody(), policyHash: '1'.repeat(64) })).status).toBe(400);
    const excessive = compileSandboxPolicy(
      { ...policy, limits: { ...ceilings, wallMs: ceilings.wallMs + 1 } },
      { ...ceilings, wallMs: ceilings.wallMs + 1 },
    );
    if (!excessive.ok) throw new Error(excessive.code);
    expect(
      (
        await post(base, {
          ...jobBody(),
          policy: excessive.policy,
          policyHash: excessive.policyHash,
        })
      ).status,
    ).toBe(400);
    expect((await post(base, { ...jobBody(), stdinBase64: 'ZE==' })).status).toBe(400);
    for (const path of [
      '../entry',
      'a/../entry',
      '/etc/passwd',
      'C:\\root',
      'a\\b',
      '.hidden',
      'a//b',
      '__proto__',
    ]) {
      const input = jobBody();
      input.files.push({ path, contentBase64: '' });
      expect((await post(base, input)).status).toBe(400);
    }
    for (const path of ['main.cjs', 'main.cjs/nested']) {
      const input = jobBody();
      input.files.push({ path, contentBase64: '' });
      expect((await post(base, input)).status).toBe(400);
    }
    expect(runtime.calls).toHaveLength(0);
  });

  it('rejects a symbolic link as the work directory before staging anything', async () => {
    const elsewhere = join(workRoot, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(
      elsewhere,
      join(workRoot, 'jobs'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const runtime = reportRuntime(async () => exited({ executed: true }));
    const base = await start(runtime);
    expect((await post(base, jobBody())).status).toBe(503);
    expect(await readdir(elsewhere)).toEqual([]);
    expect(runtime.calls).toHaveLength(0);
  });

  it('shares one probe and clears only job directories on startup, success and failure', async () => {
    const jobs = join(workRoot, 'jobs');
    await mkdir(jobs, { mode: 0o700 });
    await mkdir(join(jobs, 'job-old123'));
    await mkdir(join(jobs, 'keep'));
    let executed = 0;
    const runtime = reportRuntime(async (input) => {
      const skillDir = input.spec.mounts[2].source;
      expect(await readFile(join(skillDir, 'main.cjs'), 'utf8')).toBe('sample source');
      expect((await lstat(skillDir)).isSymbolicLink()).toBe(false);
      executed++;
      if (executed === 2) throw new Error('Untrusted text is not exported.');
      return exited({ executed: true });
    });
    const base = await start(runtime);
    const [first, second] = await Promise.all([probe(base), probe(base)]);
    expect(probePassed(first)).toBe(true);
    expect(second).toEqual(first);
    expect((await post(base, jobBody())).status).toBe(200);
    const failure = await post(base, jobBody());
    expect(failure.status).toBe(503);
    expect(await failure.text()).toBe('');
    expect(executed).toBe(2);
    expect(runtime.calls).toHaveLength(ISOLATION_CHECKS.length + 2);
    expect(await readdir(jobs)).toEqual(['keep']);
  });

  it('limits concurrency, aborts disconnected jobs and removes their staged files', async () => {
    let bundle: string | undefined;
    let receivedAbort = false;
    let signalEntered!: () => void;
    let signalCompleted!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      signalCompleted = resolve;
    });
    const runtime = reportRuntime(async (input) => {
      bundle = input.bundleDir;
      signalEntered();
      await new Promise<void>((resolve) =>
        input.signal.addEventListener(
          'abort',
          () => {
            receivedAbort = true;
            resolve();
          },
          { once: true },
        ),
      );
      signalCompleted();
      return exited({}, { ending: 'cancelled', exitCode: null });
    });
    const base = await start(runtime, 1);
    await probe(base);
    const controller = new AbortController();
    const pending = post(base, jobBody(), controller.signal).catch(() => null);
    await entered;
    expect((await post(base, jobBody())).status).toBe(503);
    controller.abort();
    expect(await pending).toBeNull();
    await completed;
    expect(receivedAbort).toBe(true);
    await expect
      .poll(async () => {
        if (!bundle) return false;
        return access(bundle, constants.F_OK).then(
          () => false,
          () => true,
        );
      })
      .toBe(true);
  });

  it('refuses real requests with incomplete probe evidence', async () => {
    const runtime = createScriptedRuntime({ run: async () => exited({}, { exitCode: 2 }) });
    const base = await start(runtime);
    expect((await post(base, jobBody())).status).toBe(503);
    expect(runtime.calls).toHaveLength(ISOLATION_CHECKS.length);
    expect(runtime.calls.every((call) => call.spec.process.args[2] === '/skill/probe.cjs')).toBe(
      true,
    );
  });
});

describe('native probe interpretation', () => {
  it('fails on a crash, missing attempt, forbidden success or extra output', async () => {
    const runtime = createScriptedRuntime({
      async run(input) {
        const check = await checkFor(input);
        switch (check) {
          case 'no_outbound_network':
            return exited({ check, passed: true }, { exitCode: 2 });
          case 'no_environment_credentials':
            return exited({ check, passed: false });
          case 'cpu_time_limited':
            return exited(
              { check },
              { ending: 'cpu_limit', exitCode: null, cpuMs: input.limits.cpuMs },
            );
          case 'no_dns':
            return exited({ check, passed: true, extra: 1 });
          default:
            return probeResult(check, input.limits);
        }
      },
    });
    const result = await runIsolationProbe({ runtime, ceilings, workRoot, rootfs: workRoot });
    expect(result.checks.filter(({ passed }) => !passed).map(({ check }) => check)).toEqual([
      'no_outbound_network',
      'no_dns',
      'no_environment_credentials',
      'cpu_time_limited',
    ]);
    expect(probePassed(result)).toBe(false);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('rejects contradictory duplicate checks', () => {
    const report = passingProbeReport();
    expect(
      probePassed({
        ...report,
        checks: [...report.checks, { check: ISOLATION_CHECKS[0], passed: false }],
      }),
    ).toBe(false);
  });
});
