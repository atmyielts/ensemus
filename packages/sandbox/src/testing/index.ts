import {
  ISOLATION_CHECKS,
  type IsolationProbeReport,
  type SandboxJob,
  type SandboxJobResult,
  type SandboxRunnerPort,
} from '@ensemus/domain/sandbox';
import type { ContainerRuntime, RawJobResult } from '../runner';

/** Scripted fixtures exercise the caller without proving any isolation. */
export function createScriptedRunner(script: {
  probe?: () => IsolationProbeReport | Promise<IsolationProbeReport>;
  execute: (job: SandboxJob, signal: AbortSignal) => SandboxJobResult | Promise<SandboxJobResult>;
}): SandboxRunnerPort & { jobs: readonly SandboxJob[] } {
  const jobs: SandboxJob[] = [];
  return {
    jobs,
    async probe(signal) {
      signal?.throwIfAborted();
      return await (script.probe?.() ?? passingProbeReport());
    },
    async execute(job, signal) {
      signal.throwIfAborted();
      jobs.push(job);
      return await script.execute(job, signal);
    },
  };
}

export function passingProbeReport(): IsolationProbeReport {
  return {
    runtime: 'scripted',
    runtimeVersion: 'test',
    probedAt: new Date().toISOString(),
    checks: ISOLATION_CHECKS.map((check) => ({ check, passed: true })),
  };
}

export function createScriptedRuntime(script: {
  run: (input: Parameters<ContainerRuntime['run']>[0]) => RawJobResult | Promise<RawJobResult>;
}): ContainerRuntime & { calls: ReadonlyArray<Parameters<ContainerRuntime['run']>[0]> } {
  const calls: Array<Parameters<ContainerRuntime['run']>[0]> = [];
  return {
    name: 'scripted',
    calls,
    async version() {
      return 'test';
    },
    async run(input) {
      input.signal.throwIfAborted();
      calls.push(input);
      return await script.run(input);
    },
  };
}
