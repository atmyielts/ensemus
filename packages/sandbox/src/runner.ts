// Owned by the sandbox-runner slice (EXP-05). See docs/06-delivery/m11b-slices.md and ADR-034 D3. The process that
// starts jobs. It holds no secret but its own request token, reaches no database and has no route out. It
// passes a job nothing from its own environment, because the job's environment is written in the OCI spec.
import type { Server } from 'node:http';
import type { IsolationProbeReport, SandboxJobEnding, SandboxLimits } from '@ensemus/domain/sandbox';
import type { OciSpec } from './oci';

/** What a runtime reports about one job, in numbers and no text. */
export type RawJobResult = {
  ending: SandboxJobEnding;
  exitCode: number | null;
  wallMs: number;
  cpuMs: number;
  peakMemoryKb: number;
  stdout: Buffer;
  stdoutBytes: number;
  stderrBytes: number;
};

/** A runtime that can actually enforce a spec. Only something on a real boundary may implement this. */
export interface ContainerRuntime {
  readonly name: string;
  version(): Promise<string>;
  /**
   * Runs one job from a bundle directory holding config.json. Enforces the wall limit itself, by killing
   * the job, because a runtime's own limits say nothing about a job that only sleeps. Reads standard output
   * up to the policy's limit and counts the rest. Kills it on abort, and always removes it.
   */
  run(input: {
    jobId: string;
    bundleDir: string;
    spec: OciSpec;
    stdin: Buffer;
    limits: SandboxLimits;
    signal: AbortSignal;
  }): Promise<RawJobResult>;
}

/**
 * An OCI runtime on the command line, such as runsc or crun. Arguments are always an array and never a
 * shell. Which binary is the operator's setting, and there is no default: with none, the runner refuses
 * every job with RUNNER_NOT_CONFIGURED, because falling back to a plain process would be no boundary at all.
 */
export function createOciCliRuntime(_config: { binary: string; stateDir: string }): ContainerRuntime {
  throw new Error('NOT_IMPLEMENTED');
}

export type SandboxRunnerConfig = {
  /** Null when no runtime is configured. Every job and probe then answers 503. */
  runtime: ContainerRuntime | null;
  rootfs: string;
  workRoot: string;
  token: string;
  maxConcurrentJobs: number;
  ceilings: SandboxLimits;
};

/**
 * Serves ./protocol. Checks, before reading a body: the bearer token in constant time, and the declared
 * size. A job's limits over the ceilings, or a policy that does not hash to its policyHash, is refused. A
 * path is checked again against the same rule the manifest uses, and each file is opened so that it cannot
 * follow a link. The job's directory is removed whatever happens, including a crash at start-up, by clearing
 * workRoot. Logs job IDs and enums only. Never logs standard output, standard error or a file.
 */
export function createSandboxRunnerServer(_config: SandboxRunnerConfig): Server {
  throw new Error('NOT_IMPLEMENTED');
}

export type { IsolationProbeReport };
