// The web side of a run: start, stop, pause, resume. A request is a row and an outbox event in one
// transaction, so the web tier never reaches Temporal (ADR-024). Nothing here changes what a run is doing:
// the worker reads these rows before each step, and the event only wakes it. So a lost wake-up delays a
// stop and cannot lose it.
import { createHash } from 'node:crypto';
import {
  agentSpecV1Schema,
  runControlSchema,
  startAgentRunSchema,
  type AgentRunView,
  type RunControlRequest,
  type StartAgentRun,
} from '@ensemus/contracts/ai';
import {
  agentDefinitions,
  agentPublications,
  agentRuns,
  agentVersions,
  budgets,
  clientOnboardings,
  memberships,
  modelProfiles,
  runControls,
  serviceIdentities,
  withTenantTx,
  workAssignments,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { processRuns, processRunSteps, processSpecs } from '@ensemus/database/product';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  AGENT_RUN_STATUSES,
  canTransitionAgentRun,
  isTerminalAgentRun,
  type AgentRunStatus,
  type RunControlKind,
} from '@ensemus/domain/ai';
import {
  AGENT_RUN_CONTROL_REQUESTED,
  AGENT_RUN_REQUESTED,
  AGGREGATE_WORK_UNIT,
} from '@ensemus/domain/ai-events';
import { can } from '@ensemus/domain/policy';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { AppError, foreignReference, pgCode, type ErrorCode } from '../errors';
import { emit } from '../events';
import { canonicalId, idSchema } from '../ids';
import { bindClientOnboardingRunInTx } from '../knowledge/onboarding';
import { auditAction, incompletePrerequisites, loadChangeable, loadReadable } from '../work';
import { latestControlOf, loadReadableRun, runIdOrMissing, toAgentRunView } from './timeline';

const UNIQUE_VIOLATION = '23505';

const LIVE_STATUSES = AGENT_RUN_STATUSES.filter((status) => !isTerminalAgentRun(status));

/**
 * Only a person starts or steers a run this way. An agent's context carries its initiator's role, so
 * the capability checks alone would let a run start another one or lift its own pause. A child run goes
 * through delegation, which has its own limits.
 */
function assertPerson(context: TenantContext) {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
}

export type RunTerms = {
  maxModelTurns: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  maxCostMicros: number;
  timeoutSeconds: number;
  maxDelegationDepth: number;
  delegatedScopes: { tools: string[] };
};

/**
 * What a run may do, from the published version and nowhere else. A request has no field for any of this,
 * and no role can update these columns afterwards. The money was parsed once at publish (ADR-028 FD-6).
 */
export function runTermsFromVersion(version: { spec: unknown; maxCostMicros: number }): RunTerms {
  const spec = agentSpecV1Schema.safeParse(version.spec);
  if (!spec.success) throw new AppError('AGENT_SPEC_INVALID');
  const { execution, tools } = spec.data;
  const denied = new Set(tools.deny ?? []);
  return {
    maxModelTurns: execution.max_model_turns,
    maxToolCalls: execution.max_tool_calls,
    maxTotalTokens: execution.max_total_tokens,
    maxCostMicros: version.maxCostMicros,
    timeoutSeconds: execution.timeout_seconds,
    maxDelegationDepth: execution.max_delegation_depth,
    delegatedScopes: { tools: tools.allow.filter((tool) => !denied.has(tool)) },
  };
}

const STARTABLE_WORK: readonly string[] = ['queued', 'ready', 'running'];

/**
 * Why this work cannot take a run now, or null. A plan and an agent would share one workflow ID (ADR-028
 * FD-1), so work a plan holds is refused here, in words, as well as at claim. A plain Work Unit keeps a
 * finished run's ID until it moves on, and that is no reason to refuse a retry.
 */
export function workStartRefusal(work: {
  status: string;
  executionPlan: string | null;
  runRequestedAt: Date | null;
  runId: string | null;
}): 'INVALID_STATE' | 'RUN_ALREADY_REQUESTED' | null {
  if (!STARTABLE_WORK.includes(work.status)) return 'INVALID_STATE';
  if (work.executionPlan && (work.runRequestedAt || work.runId)) return 'RUN_ALREADY_REQUESTED';
  return null;
}

/**
 * A kinder answer than a run that stops straight away, when something is plainly missing. This is not the
 * control: the gateway checks all of it again at every call, and it is what enforces it.
 */
export function earlyRefusal(facts: {
  hasActiveProfile: boolean;
  hasBudget: boolean;
}): 'MODEL_PROFILE_NOT_ACTIVE' | 'BUDGET_NOT_CONFIGURED' | null {
  if (!facts.hasActiveProfile) return 'MODEL_PROFILE_NOT_ACTIVE';
  if (!facts.hasBudget) return 'BUDGET_NOT_CONFIGURED';
  return null;
}

const thisPeriod = (now: Date) => now.toISOString().slice(0, 7);

async function runEarlyChecks(tx: Tx, agentVersionId: string) {
  const [profile] = await tx
    .select({ id: modelProfiles.id })
    .from(modelProfiles)
    .where(eq(modelProfiles.status, 'active'))
    .limit(1);
  const [budget] = await tx
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(
        eq(budgets.period, thisPeriod(new Date())),
        or(
          eq(budgets.scope, 'organization'),
          and(eq(budgets.scope, 'agent_version'), eq(budgets.agentVersionId, agentVersionId)),
        ),
      ),
    )
    .limit(1);
  const refusal = earlyRefusal({ hasActiveProfile: Boolean(profile), hasBudget: Boolean(budget) });
  if (refusal) throw new AppError(refusal);
}

/** A version to run: in this tenant, with an identity that is still usable, and still published. */
async function loadRunnableVersion(tx: Tx, agentVersionId: string) {
  const [version] = await tx
    .select({
      id: agentVersions.id,
      spec: agentVersions.spec,
      maxCostMicros: agentVersions.maxCostMicros,
      serviceIdentityId: agentDefinitions.serviceIdentityId,
    })
    .from(agentVersions)
    .innerJoin(
      agentDefinitions,
      and(
        eq(agentDefinitions.organizationId, agentVersions.organizationId),
        eq(agentDefinitions.id, agentVersions.definitionId),
      ),
    )
    .innerJoin(
      serviceIdentities,
      and(
        eq(serviceIdentities.organizationId, agentDefinitions.organizationId),
        eq(serviceIdentities.id, agentDefinitions.serviceIdentityId),
      ),
    )
    .where(eq(agentVersions.id, agentVersionId));
  // The form only offers this tenant's versions, so this is someone writing their own request.
  if (!version) throw foreignReference();
  // These mutable authorities remain locked until the request commits. Do not lock the immutable
  // version table: the application deliberately has no UPDATE privilege on it.
  const [identity] = await tx
    .select({ status: serviceIdentities.status, expiresAt: serviceIdentities.expiresAt })
    .from(serviceIdentities)
    .where(eq(serviceIdentities.id, version.serviceIdentityId))
    .for('share');
  const expired =
    identity?.expiresAt !== null &&
    identity?.expiresAt !== undefined &&
    identity.expiresAt <= new Date();
  if (!identity || identity.status !== 'active' || expired) throw new AppError('INVALID_STATE');
  const [published] = await tx
    .select({ id: agentPublications.id })
    .from(agentPublications)
    .where(
      and(
        eq(agentPublications.versionId, agentVersionId),
        lte(agentPublications.activeFrom, sql`now()`),
        or(isNull(agentPublications.activeUntil), gt(agentPublications.activeUntil, sql`now()`)),
      ),
    )
    .limit(1)
    .for('share');
  if (!published) throw new AppError('INVALID_STATE');
  return version;
}

/** A saved context is not saved authority. Keep the real actor type when refreshing its role. */
async function freshRunInitiator(tx: Tx, context: TenantContext): Promise<TenantContext> {
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .for('share');
  if (!member || !can(member.role, 'agent.run')) throw new AppError('FORBIDDEN');
  return { ...context, role: member.role };
}

/** The single run/outbox/audit insert kernel. Its only callers enforce their distinct actor boundary. */
async function startRunInTx(
  tx: Tx,
  context: TenantContext,
  workUnitId: string,
  agentVersionId: string,
) {
  await loadReadable(tx, context, workUnitId);
  const actor = await freshRunInitiator(tx, context);
  const work = await loadChangeable(tx, actor, workUnitId);
  const refusal = workStartRefusal(work);
  if (refusal) throw new AppError(refusal);
  const [live] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.workUnitId, workUnitId), inArray(agentRuns.status, LIVE_STATUSES)))
    .limit(1);
  if (live) throw new AppError('AGENT_RUN_ACTIVE');
  const version = await loadRunnableVersion(tx, agentVersionId);
  const terms = runTermsFromVersion(version);
  await runEarlyChecks(tx, agentVersionId);
  if (work.status === 'queued' && (await incompletePrerequisites(tx, work.id)) > 0)
    throw new AppError('PREREQUISITES_INCOMPLETE');
  const [run] = await tx
    .insert(agentRuns)
    .values({
      organizationId: actor.organizationId,
      workUnitId,
      agentVersionId,
      initiatorMembershipId: actor.membershipId,
      serviceIdentityId: version.serviceIdentityId,
      effectiveClassification: work.classification,
      ...terms,
    })
    .returning();
  if (!run) throw new Error('The insert returned nothing');
  await emit(tx, actor, {
    eventType: AGENT_RUN_REQUESTED,
    aggregateType: AGGREGATE_WORK_UNIT,
    aggregateId: workUnitId,
    aggregateVersion: work.version,
    classification: work.classification,
    payload: { agent_run_id: run.id, work_unit_id: workUnitId },
  });
  await auditAction(tx, actor, 'agent_run.requested', `agent_run:${run.id}`);
  return run;
}

/**
 * Starts a run. One transaction holds the run, its outbox event and its audit row, so none exists alone,
 * and it can join an idempotency key's transaction. The work's row lock queues two starts on one Work
 * Unit, and the index on live runs holds if anything gets past that.
 */
export async function startAgentRun(
  database: AppDatabase,
  context: TenantContext,
  input: StartAgentRun,
): Promise<AgentRunView> {
  assertPerson(context);
  const parsed = startAgentRunSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const workUnitId = canonicalId(parsed.data.work_unit_id);
  const agentVersionId = canonicalId(parsed.data.agent_version_id);
  try {
    return await withTenantTx(database, context, async (tx) => {
      const run = await startRunInTx(tx, context, workUnitId, agentVersionId);
      // Nothing has been spent, and nothing backs a figure of nothing yet.
      return toAgentRunView(run, true);
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new AppError('AGENT_RUN_ACTIVE');
    throw error;
  }
}

/**
 * Trusted workflow admission, bound to an existing person's immutable onboarding request. This is
 * deliberately not a generic in-transaction start API and never converts a worker into a person.
 */
export async function requestOnboardingAgentRunInTx(
  tx: Tx,
  context: TenantContext,
  input: { workUnitId: string; agentKey: string; requestKey?: string },
): Promise<{ agentRunId: string }> {
  if (context.actorType !== 'delegated') throw new AppError('FORBIDDEN');
  const key = idSchema.safeParse(input.requestKey),
    workId = idSchema.safeParse(input.workUnitId);
  if (input.agentKey !== 'client-brief' || !key.success || !workId.success)
    throw new AppError('INVALID_INPUT');
  const [row] = await tx
    .select()
    .from(clientOnboardings)
    .where(
      and(
        eq(clientOnboardings.id, canonicalId(key.data)),
        eq(clientOnboardings.requestedByMembershipId, context.membershipId),
      ),
    )
    .for('update');
  if (!row || row.briefWorkUnitId !== canonicalId(workId.data)) throw new AppError('NOT_FOUND');
  const actor = await freshRunInitiator(tx, context);
  if (
    !row.ownerMembershipId ||
    !row.reviewerMembershipId ||
    !row.reviewWorkUnitId ||
    !row.sendWorkUnitId ||
    !row.parentObjectiveSha256 ||
    !row.briefObjectiveSha256 ||
    !row.reviewObjectiveSha256 ||
    !row.sendObjectiveSha256 ||
    row.reviewerMembershipId === row.ownerMembershipId ||
    row.reviewerMembershipId === row.requestedByMembershipId
  )
    throw new AppError('INVALID_STATE');
  const people = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        inArray(memberships.id, [
          ...new Set([
            row.ownerMembershipId,
            row.reviewerMembershipId,
            row.requestedByMembershipId,
          ]),
        ]),
        eq(memberships.status, 'active'),
      ),
    )
    .orderBy(asc(memberships.id))
    .for('share');
  if (
    people.length !==
    new Set([row.ownerMembershipId, row.reviewerMembershipId, row.requestedByMembershipId]).size
  )
    throw new AppError('FORBIDDEN');
  const pins = [
    {
      id: row.workUnitId,
      hash: row.parentObjectiveSha256,
      owner: row.ownerMembershipId,
      child: false,
    },
    {
      id: row.briefWorkUnitId!,
      hash: row.briefObjectiveSha256,
      owner: row.reviewerMembershipId,
      child: true,
    },
    {
      id: row.reviewWorkUnitId,
      hash: row.reviewObjectiveSha256,
      owner: row.reviewerMembershipId,
      child: true,
    },
    {
      id: row.sendWorkUnitId,
      hash: row.sendObjectiveSha256,
      owner: row.ownerMembershipId,
      child: true,
    },
  ].sort((a, b) => a.id.localeCompare(b.id));
  for (const pin of pins) {
    const work = await loadReadable(tx, actor, pin.id, true);
    if (
      createHash('sha256')
        .update(work.objective ?? '')
        .digest('hex') !== pin.hash ||
      work.ownerMembershipId !== pin.owner ||
      (pin.child ? work.parentId !== row.workUnitId : work.parentId !== null) ||
      work.projectId !== row.projectId ||
      ['failed', 'cancelled'].includes(work.status)
    )
      throw new AppError('VERSION_CONFLICT');
  }
  const assignments = await tx
    .select({ workUnitId: workAssignments.workUnitId })
    .from(workAssignments)
    .where(
      and(
        inArray(workAssignments.workUnitId, [row.briefWorkUnitId!, row.reviewWorkUnitId]),
        eq(workAssignments.membershipId, row.reviewerMembershipId),
        eq(workAssignments.actorType, 'human'),
        eq(workAssignments.responsibility, 'reviewer'),
      ),
    );
  if (new Set(assignments.map((assignment) => assignment.workUnitId)).size !== 2)
    throw new AppError('VERSION_CONFLICT');
  if (row.agentRunId) {
    const [existing] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, row.agentRunId),
          eq(agentRuns.workUnitId, row.briefWorkUnitId!),
          eq(agentRuns.initiatorMembershipId, actor.membershipId),
          isNull(agentRuns.parentRunId),
        ),
      );
    if (!existing || row.state === 'started') throw new AppError('INVALID_STATE');
    return { agentRunId: existing.id };
  }
  if (row.state !== 'started') throw new AppError('INVALID_STATE');
  const published = await tx
    .select({ versionId: agentPublications.versionId })
    .from(agentPublications)
    .innerJoin(
      agentDefinitions,
      and(
        eq(agentDefinitions.organizationId, agentPublications.organizationId),
        eq(agentDefinitions.id, agentPublications.definitionId),
      ),
    )
    .where(
      and(
        eq(agentDefinitions.slug, 'client-brief'),
        lte(agentPublications.activeFrom, sql`now()`),
        or(isNull(agentPublications.activeUntil), gt(agentPublications.activeUntil, sql`now()`)),
      ),
    )
    .limit(2);
  if (published.length !== 1) throw new AppError('INVALID_STATE');
  const [publishedVersion] = await tx
    .select({ spec: agentVersions.spec, definitionId: agentVersions.definitionId })
    .from(agentVersions)
    .innerJoin(
      agentDefinitions,
      and(
        eq(agentDefinitions.organizationId, agentVersions.organizationId),
        eq(agentDefinitions.id, agentVersions.definitionId),
      ),
    )
    .where(
      and(eq(agentVersions.id, published[0]!.versionId), eq(agentDefinitions.slug, 'client-brief')),
    );
  const spec = agentSpecV1Schema.safeParse(publishedVersion?.spec);
  if (!spec.success || spec.data.id !== 'client-brief') throw new AppError('AGENT_SPEC_INVALID');
  const run = await startRunInTx(tx, actor, row.briefWorkUnitId!, published[0]!.versionId);
  await bindClientOnboardingRunInTx(tx, actor, { onboardingId: row.id, agentRunId: run.id });
  return { agentRunId: run.id };
}

/** Who may steer a run. Those who may start or stop any run, and the person who started this one. */
/** Durable process admission is distinct from an interactive request and a model delegation. Its
 * actual step, starter, Work and published definition are checked before using the shared kernel. */
export async function requestProcessAgentRun(
  database: AppDatabase,
  context: TenantContext,
  input: {
    processRunId: string;
    stepKey: string;
    workUnitId: string;
    agentVersionId: string;
    initiatorMembershipId: string;
  },
): Promise<{ runId: string }> {
  if (context.actorType !== 'delegated') throw new AppError('FORBIDDEN');
  const processId = runIdOrMissing(input.processRunId),
    workId = runIdOrMissing(input.workUnitId),
    versionId = runIdOrMissing(input.agentVersionId);
  const initiator = idSchema.safeParse(input.initiatorMembershipId);
  if (
    input.stepKey.length < 1 ||
    input.stepKey.length > 128 ||
    !initiator.success ||
    canonicalId(initiator.data) !== context.membershipId
  )
    throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, async (tx) => {
    const actor = await freshRunInitiator(tx, context);
    const [process] = await tx
      .select()
      .from(processRuns)
      .where(eq(processRuns.id, processId))
      .for('update');
    if (!process || process.startedByMembershipId !== actor.membershipId)
      throw new AppError('NOT_FOUND');
    if (!['running', 'waiting'].includes(process.status)) throw new AppError('INVALID_STATE');
    const root = await loadChangeable(tx, actor, process.rootWorkUnitId);
    if (['completed', 'cancelled', 'failed'].includes(root.status))
      throw new AppError('INVALID_STATE');
    const target = await loadChangeable(tx, actor, workId);
    if (target.parentId !== root.id) throw new AppError('VERSION_CONFLICT');
    const [step] = await tx
      .select()
      .from(processRunSteps)
      .where(and(eq(processRunSteps.runId, process.id), eq(processRunSteps.stepKey, input.stepKey)))
      .for('update');
    const [spec] = await tx.select().from(processSpecs).where(eq(processSpecs.id, process.specId));
    if (
      !step ||
      step.workUnitId !== workId ||
      !['ready', 'waiting'].includes(step.status) ||
      !spec ||
      root.classification !== spec.classification ||
      spec.specSha256 !== createHash('sha256').update(canonicalJson(spec.spec)).digest('hex')
    )
      throw new AppError('VERSION_CONFLICT');
    const body = spec.spec as { steps?: unknown };
    const pins =
      body && Array.isArray(body.steps)
        ? body.steps.filter(
            (value: unknown) =>
              value && typeof value === 'object' && 'key' in value && value.key === input.stepKey,
          )
        : [];
    const pin = pins[0] as { kind?: unknown; agentDefinitionId?: unknown } | undefined;
    if (
      pins.length !== 1 ||
      pin?.kind !== 'agent_task' ||
      typeof pin.agentDefinitionId !== 'string'
    )
      throw new AppError('VERSION_CONFLICT');
    if (step.agentRunId) {
      const [bound] = await tx
        .select({
          id: agentRuns.id,
          workId: agentRuns.workUnitId,
          initiator: agentRuns.initiatorMembershipId,
          definition: agentVersions.definitionId,
        })
        .from(agentRuns)
        .innerJoin(
          agentVersions,
          and(
            eq(agentVersions.organizationId, agentRuns.organizationId),
            eq(agentVersions.id, agentRuns.agentVersionId),
          ),
        )
        .where(eq(agentRuns.id, step.agentRunId));
      if (
        !bound ||
        bound.workId !== workId ||
        bound.initiator !== actor.membershipId ||
        bound.definition !== pin.agentDefinitionId
      )
        throw new AppError('VERSION_CONFLICT');
      return { runId: bound.id };
    }
    const [version] = await tx
      .select({ definition: agentVersions.definitionId })
      .from(agentVersions)
      .where(eq(agentVersions.id, versionId));
    if (!version || version.definition !== pin.agentDefinitionId) throw new AppError('NOT_FOUND');
    const run = await startRunInTx(tx, actor, workId, versionId);
    await tx
      .update(processRunSteps)
      .set({ agentRunId: run.id, status: 'waiting', updatedAt: sql`clock_timestamp()` })
      .where(
        and(eq(processRunSteps.runId, process.id), eq(processRunSteps.stepKey, input.stepKey)),
      );
    return { runId: run.id };
  }).catch((error: unknown) => {
    if (pgCode(error) === 'EN406') throw new AppError('VERSION_CONFLICT');
    if (pgCode(error) === UNIQUE_VIOLATION) throw new AppError('AGENT_RUN_ACTIVE');
    throw error;
  });
}

/** A process may stop only a run already bound to its own starter and exact step Work. */
export async function requestProcessAgentStop(
  database: AppDatabase,
  context: TenantContext,
  rawId: string,
) {
  if (context.actorType !== 'delegated') throw new AppError('FORBIDDEN');
  const id = runIdOrMissing(rawId);
  await withTenantTx(database, context, async (tx) => {
    const [member] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.id, context.membershipId),
          eq(memberships.userId, context.userId),
          eq(memberships.status, 'active'),
        ),
      )
      .for('share');
    if (!member) throw new AppError('FORBIDDEN');
    const actor = { ...context, role: member.role };
    const [bound] = await tx
      .select({ workId: processRunSteps.workUnitId })
      .from(processRunSteps)
      .innerJoin(
        processRuns,
        and(
          eq(processRuns.organizationId, processRunSteps.organizationId),
          eq(processRuns.id, processRunSteps.runId),
        ),
      )
      .innerJoin(
        agentRuns,
        and(
          eq(agentRuns.organizationId, processRunSteps.organizationId),
          eq(agentRuns.id, processRunSteps.agentRunId),
          eq(agentRuns.workUnitId, processRunSteps.workUnitId),
          eq(agentRuns.initiatorMembershipId, processRuns.startedByMembershipId),
        ),
      )
      .where(
        and(
          eq(processRunSteps.agentRunId, id),
          eq(processRuns.startedByMembershipId, actor.membershipId),
        ),
      );
    if (!bound) throw new AppError('NOT_FOUND');
    await controlRunInTx(tx, actor, id, 'stop');
  });
}

export function mayControlRun(
  person: { membershipId: string; role: string },
  run: { initiatorMembershipId: string },
  kind: RunControlKind,
): boolean {
  if (can(person.role, 'agent.stop')) return true;
  if (person.membershipId !== run.initiatorMembershipId) return false;
  // Stopping your own run is always yours to do. Resuming starts its spending again, which is starting
  // it, so someone whose role no longer allows that cannot.
  return kind !== 'resume' || can(person.role, 'agent.run');
}

export type ControlDecision =
  /** Write the row and the event. */
  | 'record'
  /** Already asked for and still standing, as with a double click. Nothing to write. */
  | 'already'
  | Extract<ErrorCode, 'AGENT_RUN_NOT_CONTROLLABLE' | 'INVALID_STATE'>;

/**
 * What a control does to a run in this state. The status is what the worker last did, and the latest
 * control is what was asked for since, so both count: a pause the worker has not reached can still be
 * resumed. A stop is final, and nothing overtakes it. A pause follows the same state machine the worker
 * has to obey, so it is never recorded where it could not happen.
 */
export function decideControl(
  status: AgentRunStatus,
  latest: RunControlKind | null,
  kind: RunControlKind,
): ControlDecision {
  if (isTerminalAgentRun(status)) return 'AGENT_RUN_NOT_CONTROLLABLE';
  if (latest === 'stop') return kind === 'stop' ? 'already' : 'INVALID_STATE';
  if (kind === 'stop') return 'record';
  const pausedOrPausing = latest === 'pause' || (status === 'paused' && latest === null);
  if (kind === 'pause') {
    if (pausedOrPausing) return 'already';
    return status === 'paused' || canTransitionAgentRun(status, 'paused')
      ? 'record'
      : 'INVALID_STATE';
  }
  if (pausedOrPausing) return 'record';
  return latest === 'resume' ? 'already' : 'INVALID_STATE';
}

/**
 * Records a stop, pause or resume, with its outbox event and audit row, in one transaction. The run's row
 * lock keeps two people's controls in order, so the decision reads the true latest one.
 */
export async function controlAgentRun(
  database: AppDatabase,
  context: TenantContext,
  input: { agentRunId: string } & RunControlRequest,
): Promise<void> {
  assertPerson(context);
  const agentRunId = runIdOrMissing(input.agentRunId);
  const parsed = runControlSchema.safeParse({ kind: input.kind });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const { kind } = parsed.data;
  await withTenantTx(database, context, (tx) => controlRunInTx(tx, context, agentRunId, kind));
}

async function controlRunInTx(
  tx: Tx,
  context: TenantContext,
  agentRunId: string,
  kind: RunControlKind,
) {
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .for('share');
  if (!member) throw new AppError('FORBIDDEN');
  const actor = { ...context, role: member.role };
  const { run, work } = await loadReadableRun(tx, actor, agentRunId);
  if (!mayControlRun(actor, run, kind)) throw new AppError('FORBIDDEN');
  const [locked] = await tx
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, agentRunId))
    .for('update');
  if (!locked) throw new AppError('NOT_FOUND');
  const decision = decideControl(
    locked.status as AgentRunStatus,
    await latestControlOf(tx, agentRunId),
    kind,
  );
  if (decision === 'already') return;
  if (decision !== 'record') throw new AppError(decision);
  await tx.insert(runControls).values({
    organizationId: context.organizationId,
    runId: agentRunId,
    kind,
    byMembershipId: context.membershipId,
    // The time now, under the lock. A transaction's own start time could be earlier than the control
    // it waited for, and then a stop would read as older than the pause it came after.
    createdAt: sql`clock_timestamp()`,
  });
  await emit(tx, actor, {
    eventType: AGENT_RUN_CONTROL_REQUESTED,
    aggregateType: AGGREGATE_WORK_UNIT,
    aggregateId: run.workUnitId,
    aggregateVersion: work.version,
    classification: run.effectiveClassification,
    payload: { agent_run_id: agentRunId, kind },
  });
  await auditAction(
    tx,
    actor,
    'agent_run.control_requested',
    `agent_run:${agentRunId}`,
    kind.toUpperCase(),
  );
}

export type RunnableAgent = { versionId: string; name: string; versionNumber: number };

// Enough for any form to choose from. It bounds a list, and limits nobody's number of agents.
const MAX_AGENTS_OFFERED = 200;

/** What the start form offers: each agent's published version, to someone who may start a run. */
export async function listRunnableAgents(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly RunnableAgent[]> {
  assertPerson(context);
  if (!can(context.role, 'agent.run')) throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        versionId: agentVersions.id,
        name: agentDefinitions.name,
        versionNumber: agentVersions.versionNumber,
      })
      .from(agentPublications)
      .innerJoin(
        agentVersions,
        and(
          eq(agentVersions.organizationId, agentPublications.organizationId),
          eq(agentVersions.id, agentPublications.versionId),
        ),
      )
      .innerJoin(
        agentDefinitions,
        and(
          eq(agentDefinitions.organizationId, agentVersions.organizationId),
          eq(agentDefinitions.id, agentVersions.definitionId),
        ),
      )
      .where(
        and(
          lte(agentPublications.activeFrom, sql`now()`),
          or(isNull(agentPublications.activeUntil), gt(agentPublications.activeUntil, sql`now()`)),
        ),
      )
      .orderBy(asc(agentDefinitions.name), asc(agentVersions.versionNumber))
      .limit(MAX_AGENTS_OFFERED),
  );
}
