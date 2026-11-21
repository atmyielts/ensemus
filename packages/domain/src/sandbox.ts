// Sandbox run rules (ADR-034 D3). Pure types and small rules. What these describe is only isolation once
// a runner on a real boundary has been proved. Nothing here enforces anything by itself, and no copy in
// the product may call a run isolated (ADR-034 D3, "What is not claimed").
import { createHash } from 'node:crypto';
import { canonicalJson } from './approval';

export const SANDBOX_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'memory_exceeded',
  'output_exceeded',
  'denied',
  'cancelled',
  'runner_unavailable',
] as const;
export type SandboxRunStatus = (typeof SANDBOX_RUN_STATUSES)[number];

/**
 * `running` can go back to `queued`, and it is the only way back: a sandbox has no network and holds no
 * credentials, so a run the worker lost cannot have changed anything outside itself, and another try is
 * safe. The attempts column stops that at three. Migration 0651 holds the same table.
 */
export const SANDBOX_RUN_TRANSITIONS: Record<SandboxRunStatus, readonly SandboxRunStatus[]> = {
  queued: ['running', 'denied', 'cancelled', 'runner_unavailable'],
  running: [
    'succeeded',
    'failed',
    'timed_out',
    'memory_exceeded',
    'output_exceeded',
    'cancelled',
    'runner_unavailable',
    'queued',
  ],
  succeeded: [],
  failed: [],
  timed_out: [],
  memory_exceeded: [],
  output_exceeded: [],
  denied: [],
  cancelled: [],
  runner_unavailable: [],
};

export function canTransitionSandboxRun(from: SandboxRunStatus, to: SandboxRunStatus): boolean {
  return SANDBOX_RUN_TRANSITIONS[from].includes(to);
}

export const isSettledSandboxRun = (status: SandboxRunStatus) =>
  SANDBOX_RUN_TRANSITIONS[status].length === 0;

export const SANDBOX_MAX_ATTEMPTS = 3;
export const SANDBOX_INPUT_MAX_BYTES = 1_048_576;

export const SANDBOX_RUN_PURPOSES = ['skill_test', 'agent_tool', 'operator_test'] as const;
export type SandboxRunPurpose = (typeof SANDBOX_RUN_PURPOSES)[number];

/** Why a run ended as it did. Fixed codes: text from a job is untrusted and never stored. */
export const SANDBOX_OUTCOME_CODES = [
  // Refused before anything ran.
  'FEATURE_DISABLED',
  'SKILL_NOT_USABLE',
  'SKILL_BYTES_CHANGED',
  'POLICY_OUT_OF_DATE',
  'CLASSIFICATION_NOT_ALLOWED',
  'AGENT_RUN_STOPPED',
  'AGENT_LINK_UNAVAILABLE',
  'ISOLATION_NOT_PROVED',
  'RUNNER_NOT_CONFIGURED',
  'RUNNER_UNREACHABLE',
  'CONCURRENCY_LIMIT',
  // Ran.
  'EXITED_ZERO',
  'EXITED_NON_ZERO',
  'OUTPUT_NOT_JSON',
  'OUTPUT_FAILED_SCHEMA',
  'WALL_LIMIT',
  'CPU_LIMIT',
  'MEMORY_LIMIT',
  'OUTPUT_LIMIT',
  'CANCELLED_BY_REQUEST',
  'ATTEMPTS_EXHAUSTED',
] as const;
export type SandboxOutcomeCode = (typeof SANDBOX_OUTCOME_CODES)[number];

export const SANDBOX_RUNTIMES = ['node24'] as const;
export type SandboxRuntimeName = (typeof SANDBOX_RUNTIMES)[number];

/** Limits a package asks for, or a deployment allows. Every one of them is enforced by the runtime. */
export type SandboxLimits = {
  wallMs: number;
  cpuMs: number;
  memoryMb: number;
  /** The one writable place: a size-limited tmpfs at /tmp. */
  tmpfsMb: number;
  outputKb: number;
  pids: number;
};

/**
 * A deployment's ceilings when an operator sets none. Engineering defaults for one bounded job, not a
 * promise about performance, and every one is the operator's to change by configuration.
 */
export const SANDBOX_DEFAULT_CEILINGS: SandboxLimits = {
  wallMs: 30_000,
  cpuMs: 20_000,
  memoryMb: 256,
  tmpfsMb: 64,
  outputKb: 1024,
  pids: 32,
};

/** What is left when a package asks for less than it might. The smallest job that can do anything. */
export const SANDBOX_MINIMUM_LIMITS: SandboxLimits = {
  wallMs: 100,
  cpuMs: 100,
  memoryMb: 32,
  tmpfsMb: 1,
  outputKb: 1,
  pids: 1,
};

/**
 * The compiled rule for one run, fixed on its row when it is requested. `network` has one value on
 * purpose: opening it needs a route out, which needs its own ADR and outside review. `credentials` and
 * `environment` have one value, because a job is given nothing (ADR-034 D3).
 */
export type SandboxPolicy = {
  policyVersion: 1;
  runtime: SandboxRuntimeName;
  entry: string;
  network: { mode: 'none' };
  credentials: 'none';
  environment: 'fixed_empty';
  filesystem: { root: 'read_only'; skill: 'read_only'; scratch: 'tmpfs_only' };
  limits: SandboxLimits;
};

export type SandboxPolicyRequest = {
  runtime: string;
  entry: string;
  network: { mode: string };
  limits: SandboxLimits;
};

export type PolicyRefusal = 'RUNTIME_NOT_SUPPORTED' | 'NETWORK_NOT_ALLOWED' | 'LIMITS_OVER_CEILING';

export type CompiledSandboxPolicy =
  { ok: true; policy: SandboxPolicy; policyHash: string } | { ok: false; code: PolicyRefusal };

/**
 * Turns what a package's manifest asks for, and what this deployment allows, into the rule for a run.
 * Refuses rather than narrows when a limit is over the ceiling, so a package's tests mean the same on
 * every deployment that accepts it. Owned by the sandbox-policy slice (ADR-034 D3).
 */
export function compileSandboxPolicy(
  request: SandboxPolicyRequest,
  ceilings: SandboxLimits,
): CompiledSandboxPolicy {
  if (!(SANDBOX_RUNTIMES as readonly string[]).includes(request.runtime))
    return { ok: false, code: 'RUNTIME_NOT_SUPPORTED' };
  if (request.network.mode !== 'none') return { ok: false, code: 'NETWORK_NOT_ALLOWED' };
  for (const field of Object.keys(SANDBOX_MINIMUM_LIMITS) as (keyof SandboxLimits)[]) {
    const value = request.limits[field],
      ceiling = ceilings[field];
    if (
      !Number.isSafeInteger(value) ||
      !Number.isSafeInteger(ceiling) ||
      value < SANDBOX_MINIMUM_LIMITS[field] ||
      value > ceiling
    ) {
      return { ok: false, code: 'LIMITS_OVER_CEILING' };
    }
  }
  const policy: SandboxPolicy = {
    policyVersion: 1,
    runtime: 'node24',
    entry: request.entry,
    network: { mode: 'none' },
    credentials: 'none',
    environment: 'fixed_empty',
    filesystem: { root: 'read_only', skill: 'read_only', scratch: 'tmpfs_only' },
    limits: {
      wallMs: request.limits.wallMs,
      cpuMs: request.limits.cpuMs,
      memoryMb: request.limits.memoryMb,
      tmpfsMb: request.limits.tmpfsMb,
      outputKb: request.limits.outputKb,
      pids: request.limits.pids,
    },
  };
  return { ok: true, policy, policyHash: sandboxPolicyHash(policy) };
}

/** Binds a run to its rule. A stored policy that no longer hashes to this is refused before it runs. */
export function sandboxPolicyHash(policy: SandboxPolicy): string {
  return createHash('sha256').update(canonicalJson(policy)).digest('hex');
}

/** What a runner's probe tried, from inside a real job. Each must fail for the check to pass. */
export const ISOLATION_CHECKS = [
  'no_outbound_network',
  'no_dns',
  'no_environment_credentials',
  'no_secret_mounts',
  'root_filesystem_read_only',
  'skill_directory_read_only',
  'scratch_size_limited',
  'memory_limited',
  'wall_time_limited',
  'cpu_time_limited',
  'process_count_limited',
  'no_host_process_view',
  'no_new_privileges',
] as const;
export type IsolationCheck = (typeof ISOLATION_CHECKS)[number];

/**
 * How much anyone can say about a runner, in the API and on the page. There is no value meaning
 * "isolated": a passing probe says the limits held for one job on this server, and nothing about whether
 * a determined escape would. Only outside review can say more (ADR-034, "What needs outside review").
 */
export const ISOLATION_EVIDENCE = ['none', 'probe_passed'] as const;
export type IsolationEvidence = (typeof ISOLATION_EVIDENCE)[number];

export type IsolationProbeReport = {
  runtime: string;
  runtimeVersion: string;
  probedAt: string;
  checks: ReadonlyArray<{ check: IsolationCheck; passed: boolean }>;
};

/** Every check on the list, none missing and none failed. A short report proves nothing. */
export function probePassed(report: IsolationProbeReport): boolean {
  return ISOLATION_CHECKS.every((check) =>
    report.checks.some((item) => item.check === check && item.passed),
  );
}

/** One job for a runner. The runner learns no tenant, person or skill name: only this. */
export type SandboxJob = {
  /** Opaque to the runner. Unique per attempt, so a retry cannot find a previous attempt's files. */
  jobId: string;
  policy: SandboxPolicy;
  policyHash: string;
  /** The package's files, already checked against its signature by the caller. */
  files: ReadonlyArray<{ path: string; content: Buffer }>;
  /** Given on standard input and nowhere else. */
  stdin: Buffer;
};

/** How a job ended, from what the runtime reported. Fixed values, with no text from the job. */
export const SANDBOX_JOB_ENDINGS = [
  'exited',
  'wall_limit',
  'cpu_limit',
  'memory_limit',
  'output_limit',
  'cancelled',
] as const;
export type SandboxJobEnding = (typeof SANDBOX_JOB_ENDINGS)[number];

export type SandboxJobResult = {
  ending: SandboxJobEnding;
  exitCode: number | null;
  wallMs: number;
  cpuMs: number;
  peakMemoryKb: number;
  /** At most the policy's output limit. Untrusted: it is parsed as data, or dropped. */
  stdout: Buffer;
  stdoutBytes: number;
  /** Counted and thrown away. Standard error is never stored, because it is the job's to fill. */
  stderrBytes: number;
  runtime: { name: string; version: string };
};

/**
 * The runner, as the sandbox worker sees it. @ensemus/sandbox/client implements this. There is no
 * in-process implementation outside @ensemus/sandbox/testing, so a deployment with no runner runs nothing.
 */
export interface SandboxRunnerPort {
  probe(signal?: AbortSignal): Promise<IsolationProbeReport>;
  execute(job: SandboxJob, signal: AbortSignal): Promise<SandboxJobResult>;
}

/** The runner could not be reached or would not take the job. Nothing about the job is known. */
export class SandboxRunnerUnavailable extends Error {
  override name = 'SandboxRunnerUnavailable';
  constructor(readonly code: 'RUNNER_UNREACHABLE' | 'RUNNER_NOT_CONFIGURED') {
    super(code);
  }
}

/** The order data classes rise in. A package states the highest it may be given. */
const CLASSIFICATION_ORDER = ['public', 'internal', 'confidential', 'restricted'] as const;
export type SandboxClassification = (typeof CLASSIFICATION_ORDER)[number];

/** Restricted data never reaches a sandbox in M11B, whatever a package says (ADR-034 D3). */
export function sandboxAcceptsClassification(
  data: SandboxClassification,
  packageMaximum: SandboxClassification,
): boolean {
  if (data === 'restricted') return false;
  return CLASSIFICATION_ORDER.indexOf(data) <= CLASSIFICATION_ORDER.indexOf(packageMaximum);
}
