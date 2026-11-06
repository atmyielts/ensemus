// Owned by the sandbox-runs slice (EXP-05). See docs/06-delivery/m11b-slices.md and ADR-034 D3. A run's input
// and output stay in PostgreSQL under RLS, and only its ID crosses Temporal. Asking needs sandbox.run.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type {
  IsolationEvidence,
  IsolationProbeReport,
  SandboxJobResult,
  SandboxLimits,
  SandboxOutcomeCode,
  SandboxPolicy,
  SandboxRunPurpose,
  SandboxRunStatus,
} from '@ensemus/domain/sandbox';
import type { AgentRunGuard, SkillFeatureGate } from './skill-ports';

export type SandboxRunView = {
  id: string;
  skillVersionId: string;
  purpose: SandboxRunPurpose;
  classification: 'public' | 'internal' | 'confidential';
  status: SandboxRunStatus;
  outcomeCode: SandboxOutcomeCode | null;
  limits: SandboxLimits;
  network: 'none';
  /** `probe_passed` once a runner's probe passed for this run. Never anything stronger. */
  isolationEvidence: IsolationEvidence;
  exitCode: number | null;
  wallMs: number | null;
  cpuMs: number | null;
  peakMemoryKb: number | null;
  output: unknown;
  createdAt: Date;
  finishedAt: Date | null;
  version: number;
};

export type RequestSandboxRunInput = {
  skillVersionId: string;
  classification: 'public' | 'internal' | 'confidential';
  input: unknown;
  /** The deployment's ceilings. The policy is compiled once, here, and fixed on the row. */
  ceilings: SandboxLimits;
} & (
  | { purpose: 'operator_test' }
  | {
      purpose: 'agent_tool';
      workUnitId: string;
      agentRunId: string;
      executionStepId: string;
    }
);

/**
 * For M4's tool gateway, inside the transaction that records its step, so the two commit together. Checks,
 * in order: feature gate, capability for a person, skillUseDenial, classification (restricted never), input
 * size, the agent guard when an agent asks, and then writes the row and SANDBOX_RUN_REQUESTED. A missing
 * guard refuses an agent's request, with AGENT_LINK_UNAVAILABLE. An agent's request is a service context
 * and a proposal already authorized by M4's gateway: this never decides whether the agent may use the tool.
 */
export function requestSandboxRunInTx(
  _tx: Tx,
  _context: TenantContext,
  _deps: { gate: SkillFeatureGate; agentGuard: AgentRunGuard | null },
  _input: RequestSandboxRunInput,
): Promise<SandboxRunView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function requestSandboxRun(
  _database: AppDatabase,
  _context: TenantContext,
  _deps: { gate: SkillFeatureGate; agentGuard: AgentRunGuard | null },
  _input: RequestSandboxRunInput,
): Promise<SandboxRunView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getSandboxRun(
  _database: AppDatabase,
  _context: TenantContext,
  _sandboxRunId: string,
): Promise<SandboxRunView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Sets cancel_requested_at and emits SANDBOX_RUN_CANCEL_REQUESTED. A queued run ends `cancelled` here, and
 * a running one ends when the runner kills it. A settled run answers SANDBOX_RUN_NOT_CANCELLABLE.
 */
export function cancelSandboxRun(
  _database: AppDatabase,
  _context: TenantContext,
  _sandboxRunId: string,
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export type SandboxStatusView = {
  enabled: boolean;
  isolationEvidence: IsolationEvidence;
  lastProbePassedAt: Date | null;
  ceilings: SandboxLimits;
};

/**
 * What this tenant has seen. The web tier has no path to a runner, so this reads the newest probe time on
 * this tenant's own runs, and says `none` for a tenant that has run nothing. Never reads across tenants.
 */
export function getSandboxStatus(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { enabled: boolean; ceilings: SandboxLimits },
): Promise<SandboxStatusView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Everything the worker needs to start an attempt. Lives only in the worker's memory. */
export type PreparedSandboxJob = {
  sandboxRunId: string;
  attempt: number;
  skillVersionId: string;
  digest: string;
  purpose: SandboxRunPurpose;
  policy: SandboxPolicy;
  policyHash: string;
  input: unknown;
  bundleObjectKey: string;
  bundleSha256: string;
  signerKeyId: string | null;
  signature: Buffer | null;
  outputSchema: unknown;
};

export type BeginAttemptOutcome =
  | { step: 'start'; job: PreparedSandboxJob }
  /** At the tenant's concurrency ceiling. Not a failure, and it costs no attempt. */
  | { step: 'busy' }
  | { step: 'settled'; status: SandboxRunStatus };

/**
 * Takes a run from `queued` to `running`, counting the attempt, under an advisory lock per tenant so the
 * concurrency ceiling holds across workers. Rechecks skillUseDenial, cancel_requested_at, and that the
 * stored policy still hashes to policy_hash. Any failure settles the row with its code and answers
 * `settled`. The trigger refuses `running` without a probe, so a run with no passing report answers
 * `settled` with ISOLATION_NOT_PROVED, and a null report means the runner gave none.
 */
export function beginSandboxAttempt(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    sandboxRunId: string;
    probe: IsolationProbeReport | null;
    runtime: { name: string; version: string } | null;
    maxConcurrentPerTenant: number;
  },
): Promise<BeginAttemptOutcome> {
  throw new Error('NOT_IMPLEMENTED');
}

export type FinishAttemptInput = {
  sandboxRunId: string;
  attempt: number;
  result: SandboxJobResult;
  /** Parsed and checked by the Activity: null output means it did not parse or did not pass. */
  output: { ok: true; value: unknown } | { ok: false; code: 'OUTPUT_NOT_JSON' | 'OUTPUT_FAILED_SCHEMA' };
};

/**
 * Writes what the runner reported, from a fixed list, and settles the row. Job text is never stored: only
 * validated output on success, and sizes and codes on anything else. A repeat of a settled attempt does
 * nothing. Emits SANDBOX_RUN_SETTLED in the same transaction.
 */
export function finishSandboxAttempt(
  _database: AppDatabase,
  _context: TenantContext,
  _input: FinishAttemptInput,
): Promise<SandboxRunStatus> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The runner did not answer, so nothing is known about this attempt, and nothing it did can have left. Back
 * to `queued` under SANDBOX_MAX_ATTEMPTS, and to `runner_unavailable` after. Called from the worker that
 * lost it, or from the platform queue when no worker ever took it.
 */
export function abandonSandboxAttempt(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { sandboxRunId: string; code: Extract<SandboxOutcomeCode, 'RUNNER_UNREACHABLE' | 'RUNNER_NOT_CONFIGURED'> },
): Promise<SandboxRunStatus> {
  throw new Error('NOT_IMPLEMENTED');
}
