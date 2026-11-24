// Owned by the sandbox-runs slice (EXP-05). See docs/06-delivery/m11b-slices.md and ADR-034 D3. A run's input
// and output stay in PostgreSQL under RLS, and only its ID crosses Temporal. Asking needs sandbox.run.
import { createHash } from 'node:crypto';
import {
  marketplaceListings,
  sandboxRuns,
  skillPackages,
  skillVersions,
  trustedSigners,
  withTenantTx,
  type AppDatabase,
  type SandboxRunRow,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { skillManifestSchema } from '@ensemus/contracts/skills';
import { canonicalJson } from '@ensemus/domain/approval';
import { can } from '@ensemus/domain/policy';
import {
  SANDBOX_INPUT_MAX_BYTES,
  SANDBOX_MAX_ATTEMPTS,
  compileSandboxPolicy,
  isSettledSandboxRun,
  probePassed,
  sandboxAcceptsClassification,
  sandboxPolicyHash,
  type IsolationEvidence,
  type IsolationProbeReport,
  type SandboxJobResult,
  type SandboxLimits,
  type SandboxOutcomeCode,
  type SandboxPolicy,
  type SandboxRunPurpose,
  type SandboxRunStatus,
} from '@ensemus/domain/sandbox';
import { skillBundleObjectKey, skillUseDenial, type SkillUseFacts } from '@ensemus/domain/skill';
import {
  AGGREGATE_SANDBOX_RUN,
  SANDBOX_RUN_CANCEL_REQUESTED,
  SANDBOX_RUN_REQUESTED,
  SANDBOX_RUN_SETTLED,
} from '@ensemus/domain/skill-events';
import { and, eq, sql } from 'drizzle-orm';
import { AppError, pgCode } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { requireSkillMember } from './skill-access';
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

function sandboxId(value: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

function jsonText(value: unknown) {
  try {
    return canonicalJson(value);
  } catch {
    throw new AppError('INVALID_INPUT');
  }
}

async function jsonbSize(tx: Tx, serialized: string): Promise<number | null> {
  const size = await tx.execute<{ size: number | null }>(sql`
    with candidate as materialized (select ${serialized}::text as body)
    select case when pg_input_is_valid(body, 'jsonb')
      then octet_length((body::jsonb)::text) end as size from candidate
  `);
  return size.rows[0]?.size ?? null;
}

function compileVersionPolicy(manifest: unknown, ceilings: SandboxLimits) {
  const parsed = skillManifestSchema.safeParse(manifest);
  if (!parsed.success || parsed.data.execution.kind !== 'sandbox') return null;
  const { runtime, entry, network, limits } = parsed.data.execution;
  const compiled = compileSandboxPolicy(
    {
      runtime,
      entry,
      network,
      limits: {
        wallMs: limits.wall_ms,
        cpuMs: limits.cpu_ms,
        memoryMb: limits.memory_mb,
        tmpfsMb: limits.tmpfs_mb,
        outputKb: limits.output_kb,
        pids: limits.pids,
      },
    },
    ceilings,
  );
  return compiled.ok ? { ...compiled, outputSchema: parsed.data.output_schema } : null;
}

async function readRunnableVersion(
  tx: Tx,
  context: TenantContext,
  id: string,
  allowVerified: boolean,
) {
  // Serialize with trust revocation and publication before observing the candidate.
  await tx.execute(sql`select skills.lock_trust()`);
  const [row] = await tx
    .select({
      version: skillVersions,
      packageState: skillPackages.state,
      origin: skillPackages.origin,
      signerState: trustedSigners.state,
      signerKey: trustedSigners.publicKey,
      listing: marketplaceListings,
    })
    .from(skillVersions)
    .innerJoin(
      skillPackages,
      and(
        eq(skillPackages.organizationId, skillVersions.organizationId),
        eq(skillPackages.id, skillVersions.packageId),
      ),
    )
    .leftJoin(
      trustedSigners,
      and(
        eq(trustedSigners.organizationId, skillVersions.organizationId),
        eq(trustedSigners.keyId, skillVersions.signerKeyId),
      ),
    )
    .leftJoin(
      marketplaceListings,
      and(
        eq(marketplaceListings.id, skillPackages.listingId),
        eq(marketplaceListings.digest, skillVersions.digest),
        eq(marketplaceListings.signature, skillVersions.signature),
        eq(marketplaceListings.signerKeyId, skillVersions.signerKeyId),
      ),
    )
    .where(and(eq(skillVersions.organizationId, context.organizationId), eq(skillVersions.id, id)));
  if (!row) return { found: false } as const;
  const version = row.version;
  const state = allowVerified && version.state === 'verified' ? 'published' : version.state;
  const denial = skillUseDenial({
    state: state as SkillUseFacts['state'],
    packageState: row.packageState as SkillUseFacts['packageState'],
    origin: row.origin as SkillUseFacts['origin'],
    signerState: row.signerState as SkillUseFacts['signerState'],
    listingDelistMode:
      row.origin === 'marketplace' && !row.listing
        ? 'revoke'
        : ((row.listing?.delistMode ?? null) as SkillUseFacts['listingDelistMode']),
  });
  const signerKey = row.origin === 'tenant' ? row.signerKey : row.listing?.signerPublicKey;
  if (
    denial ||
    version.executionKind !== 'sandbox' ||
    !version.digest ||
    !version.signerKeyId ||
    !version.signature ||
    !signerKey ||
    !version.maxClassification ||
    version.bundleObjectKey !== skillBundleObjectKey(context.organizationId, version.id)
  )
    return { found: true, usable: false } as const;
  return {
    found: true,
    usable: true,
    digest: version.digest,
    manifest: version.manifest,
    maximum: version.maxClassification as Parameters<typeof sandboxAcceptsClassification>[1],
    bundleObjectKey: version.bundleObjectKey,
    bundleSha256: version.bundleSha256,
    signerKeyId: version.signerKeyId,
    signerKey,
    signature: version.signature,
  } as const;
}

async function requireOperator(tx: Tx, context: TenantContext) {
  const role = await requireSkillMember(tx, context);
  if (!can(role, 'sandbox.run')) throw new AppError('FORBIDDEN');
}

function workerOnly(context: TenantContext) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
}

function runView(row: SandboxRunRow): SandboxRunView {
  return {
    id: row.id,
    skillVersionId: row.skillVersionId,
    purpose: row.purpose as SandboxRunPurpose,
    classification: row.classification as SandboxRunView['classification'],
    status: row.status as SandboxRunStatus,
    outcomeCode: row.outcomeCode as SandboxOutcomeCode | null,
    limits: (row.policy as SandboxPolicy).limits,
    network: 'none',
    isolationEvidence: row.isolationProbePassedAt ? 'probe_passed' : 'none',
    exitCode: row.exitCode,
    wallMs: row.wallMs,
    cpuMs: row.cpuMs,
    peakMemoryKb: row.peakMemoryKb,
    output: row.output,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    version: row.version,
  };
}

async function runRow(tx: Tx, context: TenantContext, id: string, lock = false) {
  const query = tx
    .select()
    .from(sandboxRuns)
    .where(
      and(
        eq(sandboxRuns.organizationId, context.organizationId),
        eq(sandboxRuns.id, sandboxId(id)),
      ),
    );
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

function runEvent(tx: Tx, context: TenantContext, row: SandboxRunRow, type: string) {
  return emit(tx, context, {
    eventType: type,
    aggregateType: AGGREGATE_SANDBOX_RUN,
    aggregateId: row.id,
    aggregateVersion: row.version,
    classification: row.classification,
    payload: { sandbox_run_id: row.id, skill_version_id: row.skillVersionId, status: row.status },
  });
}

export async function requestSandboxRunInTx(
  tx: Tx,
  context: TenantContext,
  deps: { gate: SkillFeatureGate; agentGuard: AgentRunGuard | null },
  input: RequestSandboxRunInput,
): Promise<SandboxRunView> {
  if (!(await deps.gate.isEnabled(context, 'sandbox'))) throw new AppError('FEATURE_NOT_ENABLED');
  if (input.purpose === 'operator_test') await requireOperator(tx, context);
  else workerOnly(context);
  const skill = await readRunnableVersion(
    tx,
    context,
    sandboxId(input.skillVersionId),
    input.purpose === 'operator_test',
  );
  if (!skill.found) throw new AppError('NOT_FOUND');
  if (!skill.usable) throw new AppError('SKILL_VERSION_NOT_USABLE');
  if (
    !(['public', 'internal', 'confidential'] as readonly string[]).includes(input.classification) ||
    !sandboxAcceptsClassification(input.classification, skill.maximum)
  )
    throw new AppError('SANDBOX_CLASSIFICATION_NOT_ALLOWED');
  const serialized = jsonText(input.input);
  if (Buffer.byteLength(serialized, 'utf8') > SANDBOX_INPUT_MAX_BYTES)
    throw new AppError('SANDBOX_INPUT_TOO_LARGE');
  const bytes = await jsonbSize(tx, serialized);
  if (bytes === null) throw new AppError('INVALID_INPUT');
  if (bytes > SANDBOX_INPUT_MAX_BYTES) throw new AppError('SANDBOX_INPUT_TOO_LARGE');
  if (input.purpose === 'agent_tool') {
    if (!deps.agentGuard) throw new AppError('AGENT_LINK_UNAVAILABLE');
    const status = await deps.agentGuard.sandboxRunAllowed(tx, context, {
      agentRunId: sandboxId(input.agentRunId),
      executionStepId: sandboxId(input.executionStepId),
    });
    if (status !== 'allowed') throw new AppError('AGENT_RUN_NOT_CONTROLLABLE');
  }
  const compiled = compileVersionPolicy(skill.manifest, input.ceilings);
  if (!compiled) throw new AppError('SKILL_VERSION_NOT_USABLE');
  const [row] = await tx
    .insert(sandboxRuns)
    .values({
      organizationId: context.organizationId,
      skillVersionId: sandboxId(input.skillVersionId),
      digest: skill.digest,
      purpose: input.purpose,
      classification: input.classification,
      input: sql`${serialized}::jsonb`,
      policy: compiled.policy,
      policyHash: compiled.policyHash,
      ...(input.purpose === 'operator_test'
        ? { requestedByMembershipId: context.membershipId }
        : {
            agentRunId: sandboxId(input.agentRunId),
            executionStepId: sandboxId(input.executionStepId),
            workUnitId: sandboxId(input.workUnitId),
          }),
    })
    .returning();
  if (!row) throw new AppError('INVALID_STATE');
  await runEvent(tx, context, row, SANDBOX_RUN_REQUESTED);
  return runView(row);
}

export async function requestSandboxRun(
  database: AppDatabase,
  context: TenantContext,
  deps: { gate: SkillFeatureGate; agentGuard: AgentRunGuard | null },
  input: RequestSandboxRunInput,
): Promise<SandboxRunView> {
  try {
    return await withTenantTx(database, context, (tx) =>
      requestSandboxRunInTx(tx, context, deps, input),
    );
  } catch (error) {
    if (pgCode(error) === 'ES003') throw new AppError('SKILL_VERSION_NOT_USABLE');
    throw error;
  }
}

export function getSandboxRun(
  database: AppDatabase,
  context: TenantContext,
  sandboxRunId: string,
): Promise<SandboxRunView> {
  return withTenantTx(database, context, async (tx) => {
    if (context.actorType !== 'service') await requireOperator(tx, context);
    return runView(await runRow(tx, context, sandboxRunId));
  });
}

/** A queued run stops before native execution admission. A running run requests an abort. */
export function cancelSandboxRun(
  database: AppDatabase,
  context: TenantContext,
  sandboxRunId: string,
): Promise<void> {
  return withTenantTx(database, context, async (tx) => {
    await requireOperator(tx, context);
    const row = await runRow(tx, context, sandboxRunId, true);
    if (row.cancelRequestedAt && (row.status === 'running' || row.status === 'cancelled')) return;
    if (isSettledSandboxRun(row.status as SandboxRunStatus))
      throw new AppError('SANDBOX_RUN_NOT_CANCELLABLE');
    const now = new Date();
    const changed = await changeRun(tx, row, {
      cancelRequestedAt: now,
      ...(row.status === 'queued'
        ? { status: 'cancelled', outcomeCode: 'CANCELLED_BY_REQUEST', finishedAt: now }
        : {}),
    });
    await runEvent(tx, context, changed, SANDBOX_RUN_CANCEL_REQUESTED);
    if (changed.status === 'cancelled') await runEvent(tx, context, changed, SANDBOX_RUN_SETTLED);
  });
}

export type SandboxStatusView = {
  enabled: boolean;
  isolationEvidence: IsolationEvidence;
  lastProbePassedAt: Date | null;
  ceilings: SandboxLimits;
};

export function getSandboxStatus(
  database: AppDatabase,
  context: TenantContext,
  input: { enabled: boolean; ceilings: SandboxLimits },
): Promise<SandboxStatusView> {
  return withTenantTx(database, context, async (tx) => {
    await requireOperator(tx, context);
    const { rows } = await tx.execute<{ observed: string | null }>(
      sql`select sandbox.latest_tenant_probe()::text as observed`,
    );
    const lastProbePassedAt = rows[0]?.observed ? new Date(rows[0].observed) : null;
    return {
      enabled: input.enabled,
      isolationEvidence: lastProbePassedAt ? 'probe_passed' : 'none',
      lastProbePassedAt,
      ceilings: input.ceilings,
    };
  });
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
  signerKeyId: string;
  signerKey: Buffer;
  signature: Buffer;
  outputSchema: unknown;
};

export type BeginAttemptOutcome =
  | { step: 'start'; job: PreparedSandboxJob }
  /** At the tenant's concurrency ceiling. Not a failure, and it costs no attempt. */
  | { step: 'busy' }
  | { step: 'settled'; status: SandboxRunStatus };

type RunPatch = Partial<typeof sandboxRuns.$inferInsert>;

async function changeRun(tx: Tx, row: SandboxRunRow, patch: RunPatch) {
  const [changed] = await tx
    .update(sandboxRuns)
    .set({
      ...patch,
      version: row.version + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sandboxRuns.organizationId, row.organizationId),
        eq(sandboxRuns.id, row.id),
        eq(sandboxRuns.version, row.version),
      ),
    )
    .returning();
  if (!changed) throw new AppError('VERSION_CONFLICT');
  return changed;
}

async function settle(
  tx: Tx,
  context: TenantContext,
  row: SandboxRunRow,
  status: Exclude<SandboxRunStatus, 'queued' | 'running'>,
  code: SandboxOutcomeCode,
  patch: RunPatch = {},
): Promise<typeof status> {
  const changed = await changeRun(tx, row, {
    ...patch,
    status,
    outcomeCode: code,
    finishedAt: new Date(),
  });
  await runEvent(tx, context, changed, SANDBOX_RUN_SETTLED);
  return status;
}

/** Commits the attempt and its exact fresh probe before handing a job to the worker. */
export function beginSandboxAttempt(
  database: AppDatabase,
  context: TenantContext,
  input: {
    sandboxRunId: string;
    probe: IsolationProbeReport | null;
    runtime: { name: string; version: string } | null;
    probeMaxAgeMs: number;
    maxConcurrentPerTenant: number;
    ceilings: SandboxLimits;
    enabled: boolean;
  },
): Promise<BeginAttemptOutcome> {
  workerOnly(context);
  return withTenantTx(database, context, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      'sandbox_concurrency:'||${context.organizationId}::text,0))`);
    await tx.execute(sql`select skills.lock_trust()`);
    const row = await runRow(tx, context, input.sandboxRunId, true);
    if (isSettledSandboxRun(row.status as SandboxRunStatus))
      return { step: 'settled', status: row.status as SandboxRunStatus };
    if (row.status === 'running') return { step: 'busy' };
    const deny = async (code: SandboxOutcomeCode): Promise<BeginAttemptOutcome> => ({
      step: 'settled',
      status: await settle(tx, context, row, 'denied', code),
    });
    if (row.cancelRequestedAt)
      return {
        step: 'settled',
        status: await settle(tx, context, row, 'cancelled', 'CANCELLED_BY_REQUEST'),
      };
    if (!input.enabled) return deny('FEATURE_DISABLED');

    // Nothing supplies a native runtime/admission proof for gateway or verification fixture jobs yet.
    if (row.purpose !== 'operator_test')
      return deny(row.purpose === 'agent_tool' ? 'AGENT_LINK_UNAVAILABLE' : 'SKILL_NOT_USABLE');
    const skill = await readRunnableVersion(tx, context, row.skillVersionId, true);
    if (!skill.found || !skill.usable || row.digest !== skill.digest)
      return deny('SKILL_NOT_USABLE');
    if (
      !sandboxAcceptsClassification(
        row.classification as SandboxRunView['classification'],
        skill.maximum,
      )
    )
      return deny('CLASSIFICATION_NOT_ALLOWED');
    const compiled = compileVersionPolicy(skill.manifest, input.ceilings);
    if (
      !compiled ||
      compiled.policyHash !== row.policyHash ||
      sandboxPolicyHash(row.policy as SandboxPolicy) !== row.policyHash
    )
      return deny('POLICY_OUT_OF_DATE');

    const report = input.probe;
    const probeAt = report ? new Date(report.probedAt) : null;
    const age = probeAt ? Date.now() - probeAt.getTime() : NaN;
    if (
      !report ||
      !input.runtime ||
      !probePassed(report) ||
      report.checks.some((check) => !check.passed) ||
      report.runtime !== input.runtime.name ||
      report.runtimeVersion !== input.runtime.version ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > input.probeMaxAgeMs
    )
      return deny('ISOLATION_NOT_PROVED');
    const [running] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sandboxRuns)
      .where(
        and(
          eq(sandboxRuns.organizationId, context.organizationId),
          eq(sandboxRuns.status, 'running'),
        ),
      );
    if ((running?.n ?? 0) >= input.maxConcurrentPerTenant) return { step: 'busy' };
    if (row.attempts >= SANDBOX_MAX_ATTEMPTS) {
      return {
        step: 'settled',
        status: await settle(tx, context, row, 'runner_unavailable', 'ATTEMPTS_EXHAUSTED'),
      };
    }
    const claimed = await changeRun(tx, row, {
      status: 'running',
      attempts: row.attempts + 1,
      isolationProbePassedAt: probeAt,
      runtimeName: input.runtime.name,
      runtimeVersion: input.runtime.version,
      startedAt: new Date(),
    });
    return {
      step: 'start',
      job: {
        sandboxRunId: row.id,
        attempt: claimed.attempts,
        skillVersionId: row.skillVersionId,
        digest: skill.digest,
        purpose: row.purpose as SandboxRunPurpose,
        policy: compiled.policy,
        policyHash: compiled.policyHash,
        input: row.input,
        bundleObjectKey: skill.bundleObjectKey,
        bundleSha256: skill.bundleSha256,
        signerKeyId: skill.signerKeyId,
        signerKey: skill.signerKey,
        signature: skill.signature,
        outputSchema: compiled.outputSchema,
      },
    };
  });
}

export type FinishAttemptInput = {
  sandboxRunId: string;
  attempt: number;
  result: SandboxJobResult;
  output:
    { ok: true; value: unknown } | { ok: false; code: 'OUTPUT_NOT_JSON' | 'OUTPUT_FAILED_SCHEMA' };
};

const endings = {
  wall_limit: ['timed_out', 'WALL_LIMIT'],
  cpu_limit: ['timed_out', 'CPU_LIMIT'],
  memory_limit: ['memory_exceeded', 'MEMORY_LIMIT'],
  output_limit: ['output_exceeded', 'OUTPUT_LIMIT'],
  cancelled: ['cancelled', 'CANCELLED_BY_REQUEST'],
} as const;

/** Accepts only the current attempt's validated result. The runner's text never enters storage. */
export function finishSandboxAttempt(
  database: AppDatabase,
  context: TenantContext,
  input: FinishAttemptInput,
): Promise<SandboxRunStatus> {
  workerOnly(context);
  return withTenantTx(database, context, async (tx) => {
    const row = await runRow(tx, context, input.sandboxRunId, true);
    if (row.status !== 'running' || row.attempts !== input.attempt)
      return row.status as SandboxRunStatus;
    const result = input.result;
    if (result.runtime.name !== row.runtimeName || result.runtime.version !== row.runtimeVersion)
      return settle(tx, context, row, 'failed', 'ISOLATION_NOT_PROVED');
    const fixed = {
      exitCode: result.exitCode,
      wallMs: result.wallMs,
      cpuMs: result.cpuMs,
      peakMemoryKb: result.peakMemoryKb,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
    };
    if (result.ending !== 'exited') {
      const [status, code] = endings[result.ending];
      return settle(tx, context, row, status, code, fixed);
    }
    if (result.exitCode !== 0) return settle(tx, context, row, 'failed', 'EXITED_NON_ZERO', fixed);
    if (row.cancelRequestedAt)
      return settle(tx, context, row, 'cancelled', 'CANCELLED_BY_REQUEST', fixed);
    if (!input.output.ok) return settle(tx, context, row, 'failed', input.output.code, fixed);
    const body = jsonText(input.output.value);
    if (Buffer.byteLength(body, 'utf8') > SANDBOX_INPUT_MAX_BYTES)
      return settle(tx, context, row, 'output_exceeded', 'OUTPUT_LIMIT', fixed);
    const bytes = await jsonbSize(tx, body);
    if (bytes === null) return settle(tx, context, row, 'failed', 'OUTPUT_NOT_JSON', fixed);
    if (bytes > SANDBOX_INPUT_MAX_BYTES)
      return settle(tx, context, row, 'output_exceeded', 'OUTPUT_LIMIT', fixed);
    return settle(tx, context, row, 'succeeded', 'EXITED_ZERO', {
      ...fixed,
      output: sql`${body}::jsonb`,
      outputSha256: createHash('sha256').update(body).digest('hex'),
    });
  });
}

/** An ambiguous runner response never authorizes a retry or certifies job termination. */
export function abandonSandboxAttempt(
  database: AppDatabase,
  context: TenantContext,
  input: {
    sandboxRunId: string;
    code: Extract<SandboxOutcomeCode, 'RUNNER_UNREACHABLE' | 'RUNNER_NOT_CONFIGURED'>;
    attempt?: number;
  },
): Promise<SandboxRunStatus> {
  workerOnly(context);
  return withTenantTx(database, context, async (tx) => {
    const row = await runRow(tx, context, input.sandboxRunId, true);
    if (
      isSettledSandboxRun(row.status as SandboxRunStatus) ||
      (input.attempt !== undefined && (row.status !== 'running' || row.attempts !== input.attempt))
    )
      return row.status as SandboxRunStatus;
    if (row.status === 'queued' && row.cancelRequestedAt)
      return settle(tx, context, row, 'cancelled', 'CANCELLED_BY_REQUEST');
    const code = row.status === 'running' ? 'RUNNER_UNREACHABLE' : input.code;
    return settle(tx, context, row, 'runner_unavailable', code);
  });
}

/** A verified worker found changed bytes or invalid input before sending any job to the runner. */
export function failSandboxAttemptBeforeExecution(
  database: AppDatabase,
  context: TenantContext,
  input: {
    sandboxRunId: string;
    attempt: number;
    code: 'SKILL_BYTES_CHANGED' | 'SKILL_NOT_USABLE';
  },
): Promise<SandboxRunStatus> {
  workerOnly(context);
  return withTenantTx(database, context, async (tx) => {
    const row = await runRow(tx, context, input.sandboxRunId, true);
    if (row.status !== 'running' || row.attempts !== input.attempt)
      return row.status as SandboxRunStatus;
    if (row.cancelRequestedAt) return settle(tx, context, row, 'cancelled', 'CANCELLED_BY_REQUEST');
    return settle(tx, context, row, 'failed', input.code);
  });
}

/** Final native check before the runner sees bytes. Revocation, cancellation or a superseded attempt
 * refuses dispatch. The operator may still cancel an admitted attempt while the job runs. */
export function sandboxAttemptCanExecute(
  database: AppDatabase,
  context: TenantContext,
  input: { sandboxRunId: string; attempt: number },
): Promise<boolean> {
  workerOnly(context);
  return withTenantTx(database, context, async (tx) => {
    // Trust lock first, so revocation never waits for a lock that this worker is holding.
    await tx.execute(sql`select skills.lock_trust()`);
    const row = await runRow(tx, context, input.sandboxRunId, true);
    if (row.status !== 'running' || row.attempts !== input.attempt || row.cancelRequestedAt)
      return false;
    const skill = await readRunnableVersion(tx, context, row.skillVersionId, true);
    return skill.found && skill.usable && skill.digest === row.digest;
  });
}
