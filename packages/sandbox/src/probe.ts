// Owned by the sandbox-runner slice (EXP-05). See docs/06-delivery/m11b-slices.md and ADR-034 D3. Runs real jobs on
// the configured runtime that try to do what the limits forbid. A passing report says the limits held for
// these jobs on this server, and nothing about a determined escape, which is what outside review is for.
import type { IsolationProbeReport, SandboxLimits } from '@ensemus/domain/sandbox';
import type { ContainerRuntime } from './runner';

/**
 * One job per check in ISOLATION_CHECKS, or several checks to a job where they cannot interfere. Each check
 * passes only on seeing the forbidden thing fail: a job that crashes before trying fails the check, and so
 * does a missing answer. Uses the deployment's own ceilings, so it tests what will actually be enforced.
 */
export function runIsolationProbe(_input: {
  runtime: ContainerRuntime;
  rootfs: string;
  workRoot: string;
  ceilings: SandboxLimits;
  now?: () => Date;
}): Promise<IsolationProbeReport> {
  throw new Error('NOT_IMPLEMENTED');
}
