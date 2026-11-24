import { randomUUID } from 'node:crypto';
import {
  compileSandboxPolicy,
  ISOLATION_CHECKS,
  type IsolationCheck,
  type IsolationProbeReport,
  type SandboxLimits,
} from '@ensemus/domain/sandbox';
import { runWithBundle } from './job-bundle';
import { probePayload } from './probe-jobs';
import type { ContainerRuntime, RawJobResult } from './runner';

const PROBE_ENTRY = 'probe.cjs';
const PROBE_LIMITS: SandboxLimits = {
  wallMs: 3000,
  cpuMs: 1500,
  memoryMb: 128,
  tmpfsMb: 2,
  outputKb: 1,
  pids: 10,
};
const LIMIT_TOLERANCE_MS = 250;

function didAttempt(check: IsolationCheck, result: RawJobResult): boolean {
  return result.stdout.equals(Buffer.from(JSON.stringify({ check, attempted: true })));
}

function probeSucceeded(check: IsolationCheck, limits: SandboxLimits, result: RawJobResult) {
  if (result.stdout.length !== result.stdoutBytes) return false;
  switch (check) {
    case 'wall_time_limited':
      return (
        didAttempt(check, result) &&
        result.ending === 'wall_limit' &&
        result.wallMs >= limits.wallMs &&
        result.wallMs <= limits.wallMs + LIMIT_TOLERANCE_MS
      );
    case 'cpu_time_limited':
      return (
        didAttempt(check, result) &&
        result.ending === 'cpu_limit' &&
        result.cpuMs >= limits.cpuMs &&
        result.cpuMs <= limits.cpuMs + LIMIT_TOLERANCE_MS
      );
    case 'memory_limited':
      return (
        didAttempt(check, result) &&
        result.ending === 'memory_limit' &&
        result.peakMemoryKb >= limits.memoryMb * 1024 * 0.9 &&
        result.peakMemoryKb <= limits.memoryMb * 1024 + 1024
      );
    default:
      return (
        result.ending === 'exited' &&
        result.exitCode === 0 &&
        result.stdout.equals(Buffer.from(JSON.stringify({ check, passed: true })))
      );
  }
}

export async function runIsolationProbe(input: {
  runtime: ContainerRuntime;
  rootfs: string;
  workRoot: string;
  ceilings: SandboxLimits;
  now?: () => Date;
}): Promise<IsolationProbeReport> {
  const version = await input.runtime.version();
  const checks = [];
  for (const check of ISOLATION_CHECKS) {
    const limits = {
      wallMs: Math.min(
        input.ceilings.wallMs,
        check === 'wall_time_limited' ? 600 : PROBE_LIMITS.wallMs,
      ),
      cpuMs: Math.min(
        input.ceilings.cpuMs,
        check === 'cpu_time_limited' ? 350 : PROBE_LIMITS.cpuMs,
      ),
      memoryMb: Math.min(
        input.ceilings.memoryMb,
        check === 'memory_limited' ? 64 : PROBE_LIMITS.memoryMb,
      ),
      tmpfsMb: Math.min(input.ceilings.tmpfsMb, PROBE_LIMITS.tmpfsMb),
      outputKb: Math.min(input.ceilings.outputKb, PROBE_LIMITS.outputKb),
      pids: Math.min(input.ceilings.pids, PROBE_LIMITS.pids),
    };
    const compiled = compileSandboxPolicy(
      {
        runtime: 'node24',
        entry: PROBE_ENTRY,
        network: { mode: 'none' },
        limits,
      },
      input.ceilings,
    );

    let passed = false;
    if (compiled.ok) {
      try {
        const result = await runWithBundle({
          runtime: input.runtime,
          rootfs: input.rootfs,
          workRoot: input.workRoot,
          jobId: randomUUID(),
          policy: compiled.policy,
          files: [{ path: PROBE_ENTRY, bytes: probePayload(check, limits) }],
          stdin: Buffer.alloc(0),
          signal: AbortSignal.timeout(limits.wallMs + 5000),
        });
        passed = probeSucceeded(check, limits, result);
      } catch {
        // A failed or incomplete attempt is explicit negative evidence.
      }
    }
    checks.push({ check, passed });
  }
  return {
    runtime: input.runtime.name,
    runtimeVersion: version,
    probedAt: (input.now?.() ?? new Date()).toISOString(),
    checks,
  };
}
