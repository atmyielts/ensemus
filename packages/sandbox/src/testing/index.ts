// Test doubles. Lint keeps this out of anything that ships. Neither of these isolates anything, and neither may
// ever be a default code path: a deployment with no runner runs nothing. Owned by the sandbox-runner slice.
import type {
  IsolationProbeReport,
  SandboxJob,
  SandboxJobResult,
  SandboxRunnerPort,
} from '@ensemus/domain/sandbox';
import type { ContainerRuntime, RawJobResult } from '../runner';

/** A runner that answers from a script, and records what it was given. */
export function createScriptedRunner(_script: {
  probe?: () => IsolationProbeReport | Promise<IsolationProbeReport>;
  execute: (job: SandboxJob, signal: AbortSignal) => SandboxJobResult | Promise<SandboxJobResult>;
}): SandboxRunnerPort & { jobs: readonly SandboxJob[] } {
  throw new Error('NOT_IMPLEMENTED');
}

/** A probe report with every check passing, to test what a passing report allows, and no more. */
export function passingProbeReport(): IsolationProbeReport {
  throw new Error('NOT_IMPLEMENTED');
}

/** A runtime that answers from a script, so the runner's own rules can be tested with no containers. */
export function createScriptedRuntime(_script: {
  run: (input: Parameters<ContainerRuntime['run']>[0]) => RawJobResult | Promise<RawJobResult>;
}): ContainerRuntime & { calls: ReadonlyArray<Parameters<ContainerRuntime['run']>[0]> } {
  throw new Error('NOT_IMPLEMENTED');
}
