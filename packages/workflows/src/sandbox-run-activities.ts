// Owned by the sandbox-runs slice (EXP-05). See docs/06-delivery/m11b-slices.md and ADR-034 D3.
import type { SandboxExecuteStep, SandboxRunInput, SandboxRunOutcome } from './schemas';
import type { SandboxActivityDeps, SkillActivityDeps } from './skill-deps';

/**
 * On the sandbox queue, which only the sandbox worker polls. Heartbeats while the job runs. Before anything
 * goes to the runner: a passing probe no older than probeMaxAgeMs, a fresh skillUseDenial through
 * beginSandboxAttempt, and the bytes checked against the row's hash and signature, so a changed object in
 * the store ends SKILL_BYTES_CHANGED and never runs.
 */
export function createSandboxRunActivities(_deps: SandboxActivityDeps) {
  return {
    async executeSandboxRun(_input: SandboxRunInput): Promise<SandboxExecuteStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type SandboxRunActivities = ReturnType<typeof createSandboxRunActivities>;

/** On the platform queue, so it still works when no sandbox worker is running. */
export function createSandboxRunPlatformActivities(_deps: SkillActivityDeps) {
  return {
    /** No worker took it in time. Settles `runner_unavailable`, and answers what the row now says. */
    async abandonSandboxRun(_input: SandboxRunInput): Promise<SandboxRunOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
    /** Reads what the row ended on, after a cancellation or a child's failure. */
    async readSandboxRunOutcome(_input: SandboxRunInput): Promise<SandboxRunOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type SandboxRunPlatformActivities = ReturnType<typeof createSandboxRunPlatformActivities>;
