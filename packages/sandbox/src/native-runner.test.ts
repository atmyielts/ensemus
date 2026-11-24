import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileSandboxPolicy,
  ISOLATION_CHECKS,
  probePassed,
  SANDBOX_DEFAULT_CEILINGS,
  type SandboxJob,
} from '@ensemus/domain/sandbox';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRunnerClient } from './client';
import { prepareWorkRoot, runWithBundle } from './job-bundle';
import { createOciCliRuntime, createSandboxRunnerServer } from './runner';

const enabled = process.env.ENSEMUS_NATIVE_SANDBOX_CHECK === '1';
const limits = SANDBOX_DEFAULT_CEILINGS;
let workspace: string | undefined;
let server: Server | undefined;
let client: ReturnType<typeof createRunnerClient>;

function setting(key: 'ENSEMUS_NATIVE_RUNC' | 'ENSEMUS_NATIVE_ROOTFS'): string {
  const value = process.env[key];
  if (!value) throw new Error('Missing dedicated native test configuration: ' + key);
  return value;
}

function job(source: string, options?: Partial<typeof limits>): SandboxJob {
  const compiled = compileSandboxPolicy(
    {
      runtime: 'node24',
      entry: 'start.cjs',
      network: { mode: 'none' },
      limits: { ...limits, ...options },
    },
    limits,
  );
  if (!compiled.ok) throw new Error(compiled.code);
  return {
    jobId: randomUUID(),
    policy: compiled.policy,
    policyHash: compiled.policyHash,
    files: [{ path: compiled.policy.entry, content: Buffer.from(source) }],
    stdin: Buffer.from('{"native":true}'),
  };
}

describe.skipIf(!enabled)('native Linux runc Sandbox', () => {
  beforeAll(async () => {
    const binary = setting('ENSEMUS_NATIVE_RUNC');
    const rootfs = setting('ENSEMUS_NATIVE_ROOTFS');
    workspace = await mkdtemp(join(tmpdir(), 'ensemus-native-sandbox-'));
    const token = randomUUID();
    const bootFailures: string[] = [];
    const runtime = createOciCliRuntime({
      binary,
      stateDir: join(workspace, 'state'),
      onBootError(error, log) {
        bootFailures.push([String(error), log].filter(Boolean).join('\n'));
      },
    });
    const workRoot = await prepareWorkRoot(join(workspace, 'jobs'));
    const smoke = job("process.stdout.write('fixture ready');");
    try {
      const result = await runWithBundle({
        runtime,
        rootfs,
        workRoot,
        jobId: smoke.jobId,
        policy: smoke.policy,
        files: smoke.files.map(({ path, content }) => ({ path, bytes: content })),
        stdin: smoke.stdin,
        signal: AbortSignal.timeout(5000),
      });
      expect(result).toMatchObject({ ending: 'exited', exitCode: 0 });
      expect(result.stdout.toString()).toBe('fixture ready');
    } catch (error) {
      throw new Error(bootFailures.join('\n') || 'Native fixture could not boot', { cause: error });
    }
    server = createSandboxRunnerServer({
      runtime,
      workRoot,
      rootfs,
      token,
      maxConcurrentJobs: 2,
      ceilings: limits,
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Native test listener missing');
    client = createRunnerClient({ url: 'http://127.0.0.1:' + address.port, token });
  });

  afterAll(async () => {
    if (server) {
      const stopped = new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await stopped;
    }
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it('observes all thirteen restrictions in real jobs before admitting a skill', async () => {
    const report = await client.probe(AbortSignal.timeout(10_000));
    expect(report.runtime).toBe('runc');
    expect(report.checks).toEqual(ISOLATION_CHECKS.map((check) => ({ check, passed: true })));
    expect(probePassed(report)).toBe(true);
    const result = await client.execute(
      job("const fs = require('node:fs'); process.stdout.write(fs.readFileSync(0));"),
      AbortSignal.timeout(5000),
    );
    expect(result.ending).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('{"native":true}');
    expect(result.cpuMs).toBeGreaterThan(0);
    expect(result.peakMemoryKb).toBeGreaterThan(0);
  }, 15_000);

  it('kills combined stream overflow, preserves real exit codes, and cleans up', async () => {
    const output = await client.execute(
      job("process.stderr.write('y'.repeat(8192));", { outputKb: 1 }),
      AbortSignal.timeout(5000),
    );
    expect(output.ending).toBe('output_limit');
    expect(output.stdout.length).toBe(0);
    expect(output.stderrBytes).toBeGreaterThan(1024);
    const failure = await client.execute(job('process.exit(37);'), AbortSignal.timeout(5000));
    expect(failure.ending).toBe('exited');
    expect(failure.exitCode).toBe(37);
    expect(await readdir(join(workspace!, 'jobs'))).toEqual([]);
    expect(await readdir(join(workspace!, 'state'))).toEqual([]);
  }, 15_000);
});
