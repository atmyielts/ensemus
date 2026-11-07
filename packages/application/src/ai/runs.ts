// Owned by the spine slice (AGENT-02, AI-13). The worker side of a run: claim, step rows, counters, finish.
// See docs/06-delivery/m4-slices.md and ADR-028 FD-1, FD-7, FD-12. Only agent-worker uses this, except
// `closeStrandedRunInTx`, which the base worker's upkeep calls. No transaction here spans a model call.
import { createHash } from 'node:crypto';
import {
  actorOf,
  agentAssignments,
  agentRuns,
  agentVersions,
  appendAudit,
  approvals,
  artifactEvidence,
  budgetReservations,
  budgets,
  egressDecisions,
  executionSteps,
  externalActions,
  modelProfiles,
  runControls,
  stepPayloads,
  TenantAccessDenied,
  toolProposals,
  withTenantTx,
  workUnits,
  type AgentContext,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { createAgentContext, withRunLookupTx } from '@ensemus/database/agent';
import {
  AGENT_RUN_STATUSES,
  canTransitionAgentRun,
  isTerminalAgentRun,
  strongestClassification,
  type AgentRunStatus,
  type AiClassification,
  type ProviderKind,
  type RunControlKind,
  type RunCounters,
  type RunLimits,
  type StepState,
  type StopCode,
} from '@ensemus/domain/ai';
import { AGENT_RUN_FINISHED, AGENT_RUN_STARTED } from '@ensemus/domain/ai-events';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../errors';
import { emit } from '../events';
import { applyTransition, closeOutdatedReviews, failRun, loadChangeable } from '../work';
import type { HaltCheck, TurnStart, TurnStore } from './ports';
import { lockRunInputsForContent } from './input-ledger';

export type ClaimedRun = {
  agentRunId: string;
  agentVersionId: string;
  initiatorMembershipId: string;
  limits: RunLimits;
  counters: RunCounters;
  nextStepNumber: number;
};

const LIVE_STATUSES = AGENT_RUN_STATUSES.filter((status) => !isTerminalAgentRun(status));

type RunRow = typeof agentRuns.$inferSelect;
type WorkFacts = { status: string; runId: string | null; runRequestedAt: Date | null };

const limitsOf = (run: RunRow): RunLimits => ({
  maxModelTurns: run.maxModelTurns,
  maxToolCalls: run.maxToolCalls,
  maxTotalTokens: run.maxTotalTokens,
  maxCostMicros: run.maxCostMicros,
  timeoutSeconds: run.timeoutSeconds,
  maxDelegationDepth: run.maxDelegationDepth,
});

const countersOf = (run: RunRow): RunCounters => ({
  modelTurns: run.modelTurns,
  toolCalls: run.toolCalls,
  inputTokens: run.inputTokens,
  outputTokens: run.outputTokens,
  costMicros: run.costMicros,
  activeMs: run.activeMs,
});

// --- Pure rules, so each can be tested without a database.

/**
 * Whether a run may take this Work Unit (ADR-028 trap 2). It shares its workflow ID with a plan's
 * workflow, so a plan that holds the work, or has asked to, keeps it. A person working it by hand has no
 * run on it, so the agent can join them there. `ours` is a retry of this same claim.
 */
export function claimDecision(
  work: WorkFacts,
  temporalRunId: string,
): 'take' | 'hold' | 'ours' | 'refuse' {
  if (work.runRequestedAt) return 'refuse';
  if (work.runId) {
    return work.runId === temporalRunId && work.status === 'running' ? 'ours' : 'refuse';
  }
  if (work.status === 'queued' || work.status === 'ready') return 'take';
  if (work.status === 'running') return 'hold';
  return 'refuse';
}

/**
 * The way from one run status to another. A run may be ended from a state the table does not allow
 * directly, such as `paused` to `outcome_unverified`, and it goes through `running`, as the trigger
 * requires. Null means there is no way, and the caller refuses.
 */
export function pathTo(from: AgentRunStatus, to: AgentRunStatus): readonly AgentRunStatus[] | null {
  if (from === to) return [];
  if (canTransitionAgentRun(from, to)) return [to];
  if (canTransitionAgentRun(from, 'running') && canTransitionAgentRun('running', to)) {
    return ['running', to];
  }
  return null;
}

/**
 * The answer for this step, and PostgreSQL's alone: a signal only wakes the workflow to come and ask. A stop
 * stands whatever comes after it. Otherwise the newest control wins, so a resume ends a pause.
 */
export function directiveFrom(input: {
  runStatus: AgentRunStatus;
  held: boolean;
  parentStopped: boolean;
  /** Newest first. */
  controls: readonly RunControlKind[];
  halted: boolean;
}): 'continue' | 'pause' | 'stop' | 'halted' {
  if (isTerminalAgentRun(input.runStatus)) return 'stop';
  if (input.controls.includes('stop') || input.parentStopped || !input.held) return 'stop';
  if (input.halted) return 'halted';
  return input.controls[0] === 'pause' ? 'pause' : 'continue';
}

export type ToolWaitAnswer =
  'waiting' | 'done' | 'denied' | 'expired' | 'failed' | 'unknown_external_state';

/**
 * Where a send M3 is carrying out has got to. Anything not on this list says unknown, never that it failed
 * or was sent. Only a person, through M3's own flow, can settle an unknown (ADR-028).
 */
export function toolWaitFrom(input: {
  actionStatus: string | null;
  approvalStatus: string | null;
}): ToolWaitAnswer {
  switch (input.actionStatus) {
    case 'awaiting_approval':
      if (input.approvalStatus === 'denied') return 'denied';
      if (input.approvalStatus === 'expired') return 'expired';
      return 'waiting';
    case 'ready':
    case 'sending':
    case 'reconciling':
      return 'waiting';
    case 'sent':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return input.approvalStatus === 'expired' ? 'expired' : 'denied';
    default:
      return 'unknown_external_state';
  }
}

export type ResumePoint =
  { kind: 'none' } | { kind: 'model'; outcome: string } | { kind: 'tool'; outcome: string };

/**
 * What a continued run was doing. Continue-as-new carries IDs, so this comes from the step rows. The
 * workflow only continues between finished steps or during a wait, so a tool step with no outcome yet can
 * only be one that was waiting.
 */
export function resumePointFrom(
  last: { kind: string; outcome: string | null } | undefined,
): ResumePoint {
  if (!last || last.kind === 'prepare' || last.kind === 'verification') return { kind: 'none' };
  if (last.kind === 'model_turn')
    return { kind: 'model', outcome: last.outcome ?? 'invalid_output' };
  if (last.kind === 'tool_call') return { kind: 'tool', outcome: last.outcome ?? 'needs_approval' };
  return { kind: 'tool', outcome: 'done' };
}

/**
 * Whether a finished answer has shown what its manifest asked. Each check says what it really looked at,
 * and a check nobody can perform makes the answer unverified, never quietly passed. `outcome_unverified` is
 * an honest result, and a person decides either way: nothing here completes the Work Unit.
 */
export function verdictFrom(input: {
  checks: readonly string[] | null;
  /** The last turn's answer, as stored, if its hash still matches. */
  answer: string | null;
  evidenceRows: number;
  denials: number;
}): 'completed' | 'outcome_unverified' {
  if (input.checks === null || input.answer === null || input.answer.length === 0) {
    return 'outcome_unverified';
  }
  for (const check of input.checks) {
    switch (check) {
      // The gateway holds a turn to the compiled schema, so what is left to see here is that a
      // structured answer arrived at all. Plain text is not one.
      case 'schema_check':
        try {
          JSON.parse(input.answer);
        } catch {
          return 'outcome_unverified';
        }
        break;
      case 'source_citation_check':
        if (input.evidenceRows === 0) return 'outcome_unverified';
        break;
      // Anything policy refused during this run, even if the run found another way, goes to a person.
      case 'organization_policy_check':
        if (input.denials > 0) return 'outcome_unverified';
        break;
      default:
        return 'outcome_unverified';
    }
  }
  return 'completed';
}

// --- Row helpers, inside the caller's transaction.

const lockRun = async (tx: Tx, agentRunId: string): Promise<RunRow | null> => {
  const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, agentRunId)).for('update');
  return run ?? null;
};

/** Moves a run, along the only path the trigger allows, and answers the row as it now stands. */
async function moveRun(
  tx: Tx,
  run: RunRow,
  to: AgentRunStatus,
  stopCode: StopCode | null,
  extra: { temporalRunId?: string; startedAt?: Date } = {},
): Promise<RunRow> {
  const path = pathTo(run.status as AgentRunStatus, to);
  if (!path) throw new AppError('INVALID_STATE');
  let current = run;
  for (const status of path) {
    const ends = isTerminalAgentRun(status);
    const [row] = await tx
      .update(agentRuns)
      .set({
        status,
        ...(ends ? { stopCode, endedAt: new Date() } : {}),
        ...extra,
        updatedAt: new Date(),
        version: sql`${agentRuns.version} + 1`,
      })
      .where(eq(agentRuns.id, run.id))
      .returning();
    if (!row) throw new AppError('NOT_FOUND');
    current = row;
  }
  return current;
}

const nextStepOf = async (tx: Tx, agentRunId: string) => {
  const [row] = await tx
    .select({ top: executionSteps.stepNumber })
    .from(executionSteps)
    .where(eq(executionSteps.runId, agentRunId))
    .orderBy(desc(executionSteps.stepNumber))
    .limit(1);
  return row ? row.top + 1 : 0;
};

const claimedView = async (tx: Tx, run: RunRow): Promise<ClaimedRun> => ({
  agentRunId: run.id,
  agentVersionId: run.agentVersionId,
  initiatorMembershipId: run.initiatorMembershipId,
  limits: limitsOf(run),
  counters: countersOf(run),
  nextStepNumber: await nextStepOf(tx, run.id),
});

async function auditRun(
  tx: Tx,
  organizationId: string,
  run: RunRow,
  action: string,
  decision: 'allow' | 'deny',
  safeReason: string | null,
) {
  await appendAudit(tx, {
    organizationId,
    // With no context to hand, because the initiator has gone, the run still names itself.
    actorType: 'agent',
    actorId: run.id,
    action,
    targetRef: `agent_run:${run.id}`,
    decision,
    ...(safeReason ? { safeReason } : {}),
  });
}

/** Ends a run that never got going, and says why. Its budget and payloads were never touched. */
async function refuseClaim(
  tx: Tx,
  organizationId: string,
  run: RunRow,
  status: AgentRunStatus,
  stopCode: StopCode,
) {
  const ended = await moveRun(tx, run, status, stopCode);
  await auditRun(tx, organizationId, ended, 'ai.run_refused', 'deny', stopCode);
}

/**
 * What a finished run leaves behind. A hold on a call that may have reached a provider is not released
 * without a charge: the caller has charged those already, or, with no way to charge them because the
 * initiator has gone, passes `keepLost` so the budget goes on over-counting (FD-12). Prompts and answers go
 * now (FD-5), and nothing further can act on a proposal.
 */
async function clearRunLeftovers(tx: Tx, agentRunId: string, options: { keepLost: boolean }) {
  const held = await tx
    .select({
      id: budgetReservations.id,
      budgetId: budgetReservations.budgetId,
      amountMicros: budgetReservations.amountMicros,
      attempt: budgetReservations.attempt,
      stepKind: executionSteps.kind,
      stepState: executionSteps.state,
      stepAttempt: executionSteps.attempt,
    })
    .from(budgetReservations)
    .innerJoin(executionSteps, eq(executionSteps.id, budgetReservations.stepId))
    .where(
      and(
        eq(budgetReservations.runId, agentRunId),
        eq(budgetReservations.status, 'held'),
        sql`${budgetReservations.modelCallId} is null`,
      ),
    );
  const now = new Date();
  for (const row of held) {
    if (options.keepLost && mayHaveReachedProvider(row)) continue;
    await tx
      .update(budgetReservations)
      .set({ status: 'released', settledAt: now })
      .where(eq(budgetReservations.id, row.id));
    await tx
      .update(budgets)
      .set({ reservedMicros: sql`greatest(${budgets.reservedMicros} - ${row.amountMicros}, 0)` })
      .where(eq(budgets.id, row.budgetId));
  }
  await tx
    .update(executionSteps)
    .set({ state: 'cancelled', endedAt: now })
    .where(and(eq(executionSteps.runId, agentRunId), eq(executionSteps.state, 'in_flight')));
  await tx
    .update(toolProposals)
    .set({ status: 'cancelled', updatedAt: now })
    .where(
      and(
        eq(toolProposals.runId, agentRunId),
        inArray(toolProposals.status, ['proposed', 'awaiting_approval', 'approved']),
      ),
    );
  await tx
    .delete(stepPayloads)
    .where(
      inArray(
        stepPayloads.stepId,
        tx
          .select({ id: executionSteps.id })
          .from(executionSteps)
          .where(eq(executionSteps.runId, agentRunId)),
      ),
    );
  await tx.delete(agentAssignments).where(eq(agentAssignments.agentRunId, agentRunId));
}

const mayHaveReachedProvider = (row: {
  stepKind: string;
  stepState: string;
  stepAttempt: number;
  attempt: number;
}) =>
  row.stepKind === 'model_turn' && (row.stepState === 'in_flight' || row.attempt < row.stepAttempt);

// --- Claiming.

const isAccessRefusal = (error: unknown) =>
  error instanceof AppError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN');

/** Finds the queued run through `withRunLookupTx`, then claims it under its initiator's context. */
export async function claimQueuedRun(
  database: AppDatabase,
  input: { organizationId: string; workUnitId: string; temporalRunId: string },
): Promise<ClaimedRun | null> {
  const { organizationId, workUnitId, temporalRunId } = input;
  const found = await withRunLookupTx(database, organizationId, async (tx) => {
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.workUnitId, workUnitId), inArray(agentRuns.status, LIVE_STATUSES)))
      .limit(1);
    return run ?? null;
  });
  if (!found) return null;

  let context: AgentContext;
  try {
    context = await createAgentContext(database, {
      organizationId,
      initiatorMembershipId: found.initiatorMembershipId,
      agentRunId: found.id,
    });
  } catch (error) {
    if (!(error instanceof TenantAccessDenied)) throw error;
    // A retry of a claim that already happened leaves this to the next step, which ends the run.
    if (found.status === 'queued') {
      await withRunLookupTx(database, organizationId, async (tx) => {
        const run = await lockRun(tx, found.id);
        if (run?.status === 'queued') {
          await refuseClaim(tx, organizationId, run, 'cancelled', 'INITIATOR_INACTIVE');
        }
      });
    }
    return null;
  }

  return withTenantTx(database, context, async (tx) => {
    // Two workers can get this far. The row lock decides, and the loser finds it no longer queued.
    const run = await lockRun(tx, found.id);
    if (!run) return null;
    if (run.status !== 'queued') {
      return run.temporalRunId === temporalRunId &&
        !isTerminalAgentRun(run.status as AgentRunStatus)
        ? claimedView(tx, run)
        : null;
    }

    // The initiator's own access decides, exactly as for a person. The agent role could read this row
    // whatever they could do, which is why that is not what is asked.
    let work: Awaited<ReturnType<typeof loadChangeable>>;
    try {
      work = await loadChangeable(tx, context, workUnitId);
    } catch (error) {
      if (!isAccessRefusal(error)) throw error;
      await refuseClaim(tx, organizationId, run, 'policy_denied', 'POLICY_DENIED');
      return null;
    }

    const decision = claimDecision(work, temporalRunId);
    if (decision === 'refuse') {
      await refuseClaim(tx, organizationId, run, 'failed', 'WORK_STOPPED');
      return null;
    }
    if (decision === 'take') {
      const ready =
        work.status === 'queued' ? await applyTransition(tx, context, work, 'ready') : work;
      await applyTransition(tx, context, ready, 'running', { runId: temporalRunId });
    } else if (decision === 'hold') {
      await tx
        .update(workUnits)
        .set({ runId: temporalRunId, updatedAt: new Date() })
        .where(eq(workUnits.id, work.id));
    }

    const claimed = await moveRun(tx, run, 'preparing', null, {
      temporalRunId,
      startedAt: new Date(),
    });
    await tx
      .insert(agentAssignments)
      .values({
        organizationId,
        workUnitId,
        serviceIdentityId: run.serviceIdentityId,
        agentRunId: run.id,
      })
      .onConflictDoNothing();
    await tx
      .insert(executionSteps)
      .values({
        organizationId,
        runId: run.id,
        stepNumber: 0,
        kind: 'prepare',
        state: 'completed',
        labelCode: 'PREPARING',
        endedAt: new Date(),
      })
      .onConflictDoNothing();
    await appendAudit(tx, {
      organizationId,
      ...actorOf(context),
      action: 'ai.run_claimed',
      targetRef: `agent_run:${run.id}`,
      decision: 'allow',
    });
    await emit(tx, context, {
      eventType: AGENT_RUN_STARTED,
      aggregateType: 'agent_run',
      aggregateId: run.id,
      aggregateVersion: claimed.version,
      classification: claimed.effectiveClassification,
      payload: { agent_run_id: run.id, work_unit_id: workUnitId },
    });
    return claimedView(tx, claimed);
  });
}

/**
 * After continue-as-new the old workflow run reads as closed, and the upkeep sweep probes exactly that, so
 * this run takes the hold over before anything else (ADR-028 trap 1). The hold has to be the one the same
 * run took last time, and that is the proof: nothing else can move this from one run ID to another.
 */
export async function reclaimRun(
  database: AppDatabase,
  context: AgentContext,
  input: { workUnitId: string; agentRunId: string; temporalRunId: string },
): Promise<ClaimedRun | null> {
  return withTenantTx(database, context, async (tx) => {
    const run = await lockRun(tx, input.agentRunId);
    if (!run || run.workUnitId !== input.workUnitId) return null;
    if (isTerminalAgentRun(run.status as AgentRunStatus) || !run.temporalRunId) return null;
    if (run.temporalRunId === input.temporalRunId) return claimedView(tx, run);

    const work = await loadChangeable(tx, context, input.workUnitId);
    if (work.runId !== null && work.runId !== run.temporalRunId) return null;
    if (work.runId !== null) {
      // The version stays. Nothing about the work changed, and a person's open form should not conflict.
      await tx
        .update(workUnits)
        .set({ runId: input.temporalRunId, updatedAt: new Date() })
        .where(eq(workUnits.id, work.id));
    }
    const [moved] = await tx
      .update(agentRuns)
      .set({ temporalRunId: input.temporalRunId, updatedAt: new Date() })
      .where(eq(agentRuns.id, run.id))
      .returning();
    return moved ? claimedView(tx, moved) : null;
  });
}

/**
 * A run nothing ever claimed, because no agent-worker was there or the work was stopped first. Only this
 * role can say so, which is why it runs on the agent queue, whenever a worker comes back. It touches a run
 * still queued and nothing else.
 */
export async function closeUnclaimedRun(
  database: AppDatabase,
  input: {
    organizationId: string;
    workUnitId: string;
    status: AgentRunStatus;
    stopCode: StopCode;
  },
): Promise<void> {
  await withRunLookupTx(database, input.organizationId, async (tx) => {
    const [queued] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.workUnitId, input.workUnitId), eq(agentRuns.status, 'queued')))
      .for('update');
    if (queued) await refuseClaim(tx, input.organizationId, queued, input.status, input.stopCode);
  });
}

/**
 * The initiator's context for this run, read fresh. Every Activity starts here. Throws
 * TenantAccessDenied when the initiator is disabled, which ends the run as INITIATOR_INACTIVE.
 */
export async function contextForRun(
  database: AppDatabase,
  input: { organizationId: string; agentRunId: string },
): Promise<AgentContext> {
  const [run] = await withRunLookupTx(database, input.organizationId, (tx) =>
    tx
      .select({ initiatorMembershipId: agentRuns.initiatorMembershipId })
      .from(agentRuns)
      .where(eq(agentRuns.id, input.agentRunId)),
  );
  // Same as a missing membership, so one tenant cannot tell another's run from no run at all.
  if (!run) throw new TenantAccessDenied();
  return createAgentContext(database, {
    organizationId: input.organizationId,
    initiatorMembershipId: run.initiatorMembershipId,
    agentRunId: input.agentRunId,
  });
}

export type RunFacts = {
  status: AgentRunStatus;
  temporalRunId: string | null;
  workUnitId: string;
  agentVersionId: string;
  classification: AiClassification;
  bound: { profileId: string; profileVersion: number; providerKind: ProviderKind } | null;
  limits: RunLimits;
  counters: RunCounters;
};

/** What an Activity needs to know about its run, read in one short transaction. */
export async function readRunFacts(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string },
): Promise<RunFacts | null> {
  const [row] = await withTenantTx(database, context, (tx) =>
    tx
      .select({ run: agentRuns, providerKind: modelProfiles.providerKind })
      .from(agentRuns)
      .leftJoin(modelProfiles, eq(modelProfiles.id, agentRuns.boundProfileId))
      .where(eq(agentRuns.id, input.agentRunId)),
  );
  if (!row) return null;
  const { run, providerKind } = row;
  return {
    status: run.status as AgentRunStatus,
    temporalRunId: run.temporalRunId,
    workUnitId: run.workUnitId,
    agentVersionId: run.agentVersionId,
    classification: run.effectiveClassification as AiClassification,
    bound:
      run.boundProfileId && run.boundProfileVersion !== null && providerKind
        ? {
            profileId: run.boundProfileId,
            profileVersion: run.boundProfileVersion,
            providerKind: providerKind as ProviderKind,
          }
        : null,
    limits: limitsOf(run),
    counters: countersOf(run),
  };
}

/** Reads the controls and the switches. Anything that cannot be read about a switch counts as halted. */
export async function readRunDirective(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string; temporalRunId: string; halt: () => HaltCheck },
): Promise<'continue' | 'pause' | 'stop' | 'halted'> {
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select({
        status: agentRuns.status,
        parentRunId: agentRuns.parentRunId,
        agentVersionId: agentRuns.agentVersionId,
        providerKind: modelProfiles.providerKind,
        workStatus: workUnits.status,
        workRunId: workUnits.runId,
      })
      .from(agentRuns)
      .innerJoin(workUnits, eq(workUnits.id, agentRuns.workUnitId))
      .leftJoin(modelProfiles, eq(modelProfiles.id, agentRuns.boundProfileId))
      .where(eq(agentRuns.id, input.agentRunId));
    if (!row) return 'stop';

    const controls = await tx
      .select({ kind: runControls.kind })
      .from(runControls)
      .where(eq(runControls.runId, input.agentRunId))
      .orderBy(desc(runControls.createdAt));

    // A child looks at its parent as well, so a stop reaches it even if the parent's signal to the child
    // workflow never does (FD-16). Each child does the same one level down.
    let parentStopped = false;
    if (row.parentRunId) {
      const [parent] = await tx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, row.parentRunId));
      const [stopped] = await tx
        .select({ id: runControls.id })
        .from(runControls)
        .where(and(eq(runControls.runId, row.parentRunId), eq(runControls.kind, 'stop')))
        .limit(1);
      parentStopped =
        !parent || isTerminalAgentRun(parent.status as AgentRunStatus) || stopped !== undefined;
    }

    let halted = false;
    try {
      await input.halt().assertRunning(tx, context, {
        agentVersionId: row.agentVersionId,
        ...(row.providerKind ? { providerKind: row.providerKind as ProviderKind } : {}),
      });
    } catch {
      halted = true;
    }

    return directiveFrom({
      runStatus: row.status as AgentRunStatus,
      held:
        row.workRunId === input.temporalRunId &&
        (row.workStatus === 'running' || row.workStatus === 'awaiting_approval'),
      parentStopped,
      controls: controls.map(({ kind }) => kind as RunControlKind),
      halted,
    });
  });
}

/** Which stop this was, for the row: a control someone recorded, or the work itself having been stopped. */
export async function stopReason(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string },
): Promise<'STOPPED_BY_PERSON' | 'WORK_STOPPED'> {
  const [control] = await withTenantTx(database, context, (tx) =>
    tx
      .select({ id: runControls.id })
      .from(runControls)
      .where(and(eq(runControls.runId, input.agentRunId), eq(runControls.kind, 'stop')))
      .limit(1),
  );
  return control ? 'STOPPED_BY_PERSON' : 'WORK_STOPPED';
}

export async function setRunStatus(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string; status: AgentRunStatus },
): Promise<void> {
  await withTenantTx(database, context, async (tx) => {
    const run = await lockRun(tx, input.agentRunId);
    if (!run) throw new AppError('NOT_FOUND');
    // A run that has ended stays ended. The next directive says so, and nothing is reported from here.
    if (isTerminalAgentRun(run.status as AgentRunStatus)) return;
    await moveRun(tx, run, input.status, null);
  });
}

const COUNTER_COLUMNS = {
  modelTurns: agentRuns.modelTurns,
  toolCalls: agentRuns.toolCalls,
  inputTokens: agentRuns.inputTokens,
  outputTokens: agentRuns.outputTokens,
  costMicros: agentRuns.costMicros,
  activeMs: agentRuns.activeMs,
} as const;

/** Each column adds in the database, so two writers cannot lose one another's numbers. */
export async function addToCountersInTx(
  tx: Tx,
  input: { agentRunId: string; delta: Partial<RunCounters> },
): Promise<RunCounters> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [name, column] of Object.entries(COUNTER_COLUMNS)) {
    const amount = input.delta[name as keyof RunCounters] ?? 0;
    // Counters only rise. The trigger holds that too, and this says so before it gets that far.
    if (!Number.isSafeInteger(amount) || amount < 0) throw new AppError('INVALID_INPUT');
    if (amount > 0) set[name] = sql`${column} + ${amount}`;
  }
  const [row] = await tx
    .update(agentRuns)
    .set(set as Partial<typeof agentRuns.$inferInsert>)
    .where(eq(agentRuns.id, input.agentRunId))
    .returning();
  if (!row) throw new AppError('NOT_FOUND');
  return countersOf(row);
}

export function addToCounters(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string; delta: Partial<RunCounters> },
): Promise<RunCounters> {
  return withTenantTx(database, context, (tx) => addToCountersInTx(tx, input));
}

/**
 * Counts tool steps by their rows, and adds what this Activity spent. A step that waited for a person, or a
 * retry, passes through here again, and a count taken from the rows cannot count it twice.
 */
export function countToolSteps(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string; activeMs: number },
): Promise<RunCounters> {
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(executionSteps)
      .where(and(eq(executionSteps.runId, input.agentRunId), eq(executionSteps.kind, 'tool_call')));
    const [run] = await tx
      .select({ toolCalls: agentRuns.toolCalls })
      .from(agentRuns)
      .where(eq(agentRuns.id, input.agentRunId))
      .for('update');
    if (!run) throw new AppError('NOT_FOUND');
    return addToCountersInTx(tx, {
      agentRunId: input.agentRunId,
      delta: {
        toolCalls: Math.max((row?.count ?? 0) - run.toolCalls, 0),
        activeMs: Math.max(Math.round(input.activeMs), 0),
      },
    });
  });
}

/** Mixing inherits the strongest class, and a class only rises (FD-13). Answers where it now stands. */
export async function raiseClassification(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string; atLeast: AiClassification },
): Promise<AiClassification> {
  return withTenantTx(database, context, async (tx) => {
    const run = await lockRun(tx, input.agentRunId);
    if (!run) throw new AppError('NOT_FOUND');
    const current = run.effectiveClassification as AiClassification;
    const next = strongestClassification(current, input.atLeast);
    if (next !== current) {
      await tx
        .update(agentRuns)
        .set({ effectiveClassification: next, updatedAt: new Date() })
        .where(eq(agentRuns.id, run.id));
    }
    return next;
  });
}

// --- A model turn's row.

const STATE_FOR_OUTCOME: Record<string, StepState> = {
  tool_proposed: 'completed',
  final_output: 'completed',
  stopped: 'cancelled',
};

/**
 * Ends a turn and counts it in one transaction, so a retry can neither lose the count nor add it twice. An
 * old attempt that outlived its retry changes nothing: the row is no longer at its attempt.
 */
export async function completeTurn(
  database: AppDatabase,
  context: AgentContext,
  input: {
    agentRunId: string;
    stepId: string;
    attempt: number;
    outcome: string;
    /** Why, as a stop code when it has one and a reason code otherwise. */
    code: string | null;
    delta: Partial<RunCounters>;
  },
): Promise<RunCounters | null> {
  return withTenantTx(database, context, async (tx) => {
    const [ended] = await tx
      .update(executionSteps)
      .set({
        state: STATE_FOR_OUTCOME[input.outcome] ?? 'failed',
        outcome: input.outcome,
        decisionCode: input.code,
        endedAt: new Date(),
      })
      .where(
        and(
          eq(executionSteps.id, input.stepId),
          eq(executionSteps.state, 'in_flight'),
          eq(executionSteps.attempt, input.attempt),
        ),
      )
      .returning({ id: executionSteps.id });
    if (!ended) return null;
    return addToCountersInTx(tx, { agentRunId: input.agentRunId, delta: input.delta });
  });
}

/** A finished turn's stored answer, for a retry that found it finished. */
export async function storedTurn(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string; stepId: string },
): Promise<{ code: string | null; counters: RunCounters }> {
  return withTenantTx(database, context, async (tx) => {
    const [step] = await tx
      .select({ code: executionSteps.decisionCode })
      .from(executionSteps)
      .where(eq(executionSteps.id, input.stepId));
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, input.agentRunId));
    if (!run) throw new AppError('NOT_FOUND');
    return { code: step?.code ?? null, counters: countersOf(run) };
  });
}

export type LostAttempt = {
  stepId: string;
  stepNumber: number;
  attempt: number;
  reservationId: string;
  amountMicros: number;
};

/**
 * Holds on calls that may have reached a provider and never reported back, oldest first. One reservation
 * is one row per budget, and closing any of them closes them all, so each attempt appears once.
 */
export async function listLostAttempts(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string },
): Promise<readonly LostAttempt[]> {
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        stepId: executionSteps.id,
        stepNumber: executionSteps.stepNumber,
        attempt: budgetReservations.attempt,
        reservationId: budgetReservations.id,
        amountMicros: budgetReservations.amountMicros,
        stepKind: executionSteps.kind,
        stepState: executionSteps.state,
        stepAttempt: executionSteps.attempt,
      })
      .from(budgetReservations)
      .innerJoin(executionSteps, eq(executionSteps.id, budgetReservations.stepId))
      .where(
        and(
          eq(budgetReservations.runId, input.agentRunId),
          eq(budgetReservations.status, 'held'),
          sql`${budgetReservations.modelCallId} is null`,
        ),
      )
      .orderBy(executionSteps.stepNumber, budgetReservations.attempt, budgetReservations.budgetId),
  );
  const seen = new Set<string>();
  return rows.flatMap(({ stepKind, stepState, stepAttempt, ...lost }) => {
    const group = `${lost.stepId}:${lost.attempt}`;
    if (seen.has(group)) return [];
    if (!mayHaveReachedProvider({ stepKind, stepState, stepAttempt, attempt: lost.attempt })) {
      return [];
    }
    seen.add(group);
    return [lost];
  });
}

/** Terminal status, reservations released, payloads purged. Safe to repeat. */
export async function finishRun(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string; status: AgentRunStatus; stopCode: StopCode | null },
): Promise<void> {
  await withTenantTx(database, context, async (tx) => {
    const run = await lockRun(tx, input.agentRunId);
    if (!run) throw new AppError('NOT_FOUND');
    if (isTerminalAgentRun(run.status as AgentRunStatus)) {
      await clearRunLeftovers(tx, run.id, { keepLost: false });
      return;
    }
    const ended = await moveRun(tx, run, input.status, input.stopCode);
    await clearRunLeftovers(tx, run.id, { keepLost: false });
    await releaseWork(tx, context, run, input.status);
    await appendAudit(tx, {
      organizationId: context.organizationId,
      ...actorOf(context),
      action: 'ai.run_finished',
      targetRef: `agent_run:${run.id}`,
      decision: 'allow',
      ...(input.stopCode ? { safeReason: input.stopCode } : {}),
    });
    await emit(tx, context, {
      eventType: AGENT_RUN_FINISHED,
      aggregateType: 'agent_run',
      aggregateId: run.id,
      aggregateVersion: ended.version,
      classification: ended.effectiveClassification,
      payload: { agent_run_id: run.id, status: input.status, stop_code: input.stopCode },
    });
  });
}

/**
 * Ends this run's hold on its work. A finished answer goes for a person to check, and stops there:
 * completing it takes the accountable owner, and `work.ts` checks that it is a person. An initiator who can
 * no longer change the work cannot move it, and the upkeep sweep finds it once the workflow has closed.
 */
async function releaseWork(
  tx: Tx,
  context: AgentContext,
  run: RunRow,
  status: AgentRunStatus,
): Promise<void> {
  if (!run.temporalRunId) return;
  let work: Awaited<ReturnType<typeof loadChangeable>>;
  try {
    work = await loadChangeable(tx, context, run.workUnitId);
  } catch (error) {
    if (isAccessRefusal(error)) return;
    throw error;
  }
  if (work.runId !== run.temporalRunId) return;
  if (status === 'completed' || status === 'outcome_unverified') {
    if (work.status !== 'running') return;
    const checking = await applyTransition(tx, context, work, 'verifying');
    await closeOutdatedReviews(tx, context, checking);
    return;
  }
  await failRun(tx, context, work);
}

/**
 * The initiator has gone, so no agent context can be made for this run, and every service needs one. This
 * does only what needs none: the run's own row and leftovers. A hold that may have reached a provider stays
 * held, so the budget over-counts. The Work Unit is left to the upkeep sweep, once the workflow has closed.
 */
export async function closeRunWithoutContext(
  database: AppDatabase,
  input: {
    organizationId: string;
    agentRunId: string;
    status: AgentRunStatus;
    stopCode: StopCode | null;
  },
): Promise<void> {
  await withRunLookupTx(database, input.organizationId, async (tx) => {
    const run = await lockRun(tx, input.agentRunId);
    if (!run) return;
    if (!isTerminalAgentRun(run.status as AgentRunStatus)) {
      const ended = await moveRun(tx, run, input.status, input.stopCode);
      await auditRun(tx, input.organizationId, ended, 'ai.run_finished', 'deny', input.stopCode);
    }
    await clearRunLeftovers(tx, run.id, { keepLost: true });
  });
}

/**
 * The base worker's upkeep found this workflow run gone. It calls this under the Work Unit's lock, in
 * the transaction that releases its hold, so neither half can commit on its own. The exact Temporal run
 * matters: a reopened work item or continue-as-new must never be closed by an older sweep's answer.
 */
export async function closeStrandedRunInTx(
  tx: Tx,
  context: TenantContext,
  input: { workUnitId: string; temporalRunId: string },
): Promise<void> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  await tx
    .update(agentRuns)
    .set({
      status: 'failed',
      stopCode: 'STRANDED',
      endedAt: new Date(),
      updatedAt: new Date(),
      version: sql`${agentRuns.version} + 1`,
    })
    .where(
      and(
        eq(agentRuns.organizationId, context.organizationId),
        eq(agentRuns.workUnitId, input.workUnitId),
        eq(agentRuns.temporalRunId, input.temporalRunId),
        inArray(agentRuns.status, LIVE_STATUSES),
      ),
    );
}

/** An exact-run cleanup for callers that do not also change the Work Unit. */
export async function closeStrandedRun(
  database: AppDatabase,
  context: TenantContext,
  input: { workUnitId: string; temporalRunId: string },
): Promise<void> {
  await withTenantTx(database, context, (tx) => closeStrandedRunInTx(tx, context, input));
}

/** Writes a prompt or an answer to `ai.step_payloads`, with its class and hash. Nothing else does. */
export async function storeStepPayload(
  database: AppDatabase,
  context: AgentContext,
  input: {
    stepId: string;
    kind: 'prompt' | 'completion' | 'tool_args' | 'tool_output';
    classification: AiClassification;
    content: string;
  },
): Promise<void> {
  const contentSha256 = createHash('sha256').update(input.content).digest('hex');
  await withTenantTx(database, context, async (tx) => {
    await lockRunInputsForContent(tx, context);
    // A step has one of each. A retried attempt's words replace an earlier attempt's, so the next turn
    // never reads the same step twice.
    await tx
      .delete(stepPayloads)
      .where(and(eq(stepPayloads.stepId, input.stepId), eq(stepPayloads.kind, input.kind)));
    await tx.insert(stepPayloads).values({
      organizationId: context.organizationId,
      stepId: input.stepId,
      kind: input.kind,
      classification: input.classification,
      content: input.content,
      contentSha256,
    });
  });
}

/** Where the last step left this run, for a run continued as new. */
export async function readResumePoint(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string },
): Promise<ResumePoint> {
  const [last] = await withTenantTx(database, context, (tx) =>
    tx
      .select({ kind: executionSteps.kind, outcome: executionSteps.outcome })
      .from(executionSteps)
      .where(eq(executionSteps.runId, input.agentRunId))
      .orderBy(desc(executionSteps.stepNumber))
      .limit(1),
  );
  return resumePointFrom(last);
}

/** Where a waiting tool step has got to. Reads PostgreSQL only, so it is safe to poll for days. */
export async function readToolWait(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string; stepNumber: number },
): Promise<ToolWaitAnswer> {
  const [row] = await withTenantTx(database, context, (tx) =>
    tx
      .select({ action: externalActions.status, approval: approvals.status })
      .from(toolProposals)
      .innerJoin(executionSteps, eq(executionSteps.id, toolProposals.stepId))
      .leftJoin(externalActions, eq(externalActions.id, toolProposals.externalActionId))
      .leftJoin(approvals, eq(approvals.id, toolProposals.approvalId))
      .where(
        and(
          eq(toolProposals.runId, input.agentRunId),
          lte(executionSteps.stepNumber, input.stepNumber),
        ),
      )
      .orderBy(desc(executionSteps.stepNumber))
      .limit(1),
  );
  return toolWaitFrom({ actionStatus: row?.action ?? null, approvalStatus: row?.approval ?? null });
}

const specChecks = z.looseObject({
  output: z.looseObject({ verification: z.array(z.string()) }),
});

/** Checks a final output against what its manifest asks for, once, and keeps the answer in a step row. */
export async function verifyOutput(
  database: AppDatabase,
  context: AgentContext,
  input: { agentRunId: string },
): Promise<'completed' | 'outcome_unverified'> {
  return withTenantTx(database, context, async (tx) => {
    const run = await lockRun(tx, input.agentRunId);
    if (!run) throw new AppError('NOT_FOUND');
    const [earlier] = await tx
      .select({ outcome: executionSteps.outcome })
      .from(executionSteps)
      .where(and(eq(executionSteps.runId, run.id), eq(executionSteps.kind, 'verification')))
      .limit(1);
    if (earlier) return earlier.outcome === 'completed' ? 'completed' : 'outcome_unverified';

    const [version] = await tx
      .select({ spec: agentVersions.spec })
      .from(agentVersions)
      .where(eq(agentVersions.id, run.agentVersionId));
    const parsed = specChecks.safeParse(version?.spec);

    const [answer] = await tx
      .select({ content: stepPayloads.content, sha256: stepPayloads.contentSha256 })
      .from(executionSteps)
      .innerJoin(stepPayloads, eq(stepPayloads.stepId, executionSteps.id))
      .where(
        and(
          eq(executionSteps.runId, run.id),
          eq(executionSteps.kind, 'model_turn'),
          eq(executionSteps.outcome, 'final_output'),
          eq(stepPayloads.kind, 'completion'),
        ),
      )
      .orderBy(desc(executionSteps.stepNumber))
      .limit(1);
    const intact =
      answer && createHash('sha256').update(answer.content).digest('hex') === answer.sha256;

    const [evidence] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(artifactEvidence)
      .where(eq(artifactEvidence.runId, run.id));
    const [refusedEgress] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(egressDecisions)
      .where(and(eq(egressDecisions.runId, run.id), eq(egressDecisions.decision, 'deny')));
    const [refusedTools] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(toolProposals)
      .where(and(eq(toolProposals.runId, run.id), eq(toolProposals.status, 'denied')));

    const verdict = verdictFrom({
      checks: parsed.success ? parsed.data.output.verification : null,
      answer: intact ? answer.content : null,
      evidenceRows: evidence?.count ?? 0,
      denials: (refusedEgress?.count ?? 0) + (refusedTools?.count ?? 0),
    });
    await tx.insert(executionSteps).values({
      organizationId: context.organizationId,
      runId: run.id,
      stepNumber: await nextStepOf(tx, run.id),
      kind: 'verification',
      state: 'completed',
      outcome: verdict,
      labelCode: 'CHECKING_RESULT',
      endedAt: new Date(),
    });
    return verdict;
  });
}

/**
 * FD-12. A retry must never forget a call a provider may have billed, so `beginTurn` hands the caller any
 * hold an earlier attempt left. No transaction stays open across the model call: this one writes the row,
 * and returns before anything is sent.
 */
export function createTurnStore(database: AppDatabase): TurnStore {
  return {
    beginTurn(context, step): Promise<TurnStart> {
      return withTenantTx(database, context, async (tx) => {
        const [fresh] = await tx
          .insert(executionSteps)
          .values({
            organizationId: context.organizationId,
            runId: step.runId,
            stepNumber: step.stepNumber,
            kind: 'model_turn',
            state: 'in_flight',
            labelCode: 'THINKING',
            attempt: 1,
          })
          .onConflictDoNothing()
          .returning({ id: executionSteps.id });
        if (fresh) return { kind: 'begin', stepId: fresh.id, attempt: 1, lostAttempt: null };

        const [row] = await tx
          .select()
          .from(executionSteps)
          .where(
            and(
              eq(executionSteps.runId, step.runId),
              eq(executionSteps.stepNumber, step.stepNumber),
            ),
          )
          .for('update');
        if (!row) throw new AppError('NOT_FOUND');
        if (row.kind !== 'model_turn') throw new AppError('INVALID_STATE');
        if (row.state !== 'in_flight') {
          return { kind: 'already_done', stepId: row.id, outcome: row.outcome ?? 'invalid_output' };
        }

        const [held] = await tx
          .select({
            id: budgetReservations.id,
            attempt: budgetReservations.attempt,
            amountMicros: budgetReservations.amountMicros,
          })
          .from(budgetReservations)
          .where(
            and(
              eq(budgetReservations.stepId, row.id),
              eq(budgetReservations.status, 'held'),
              sql`${budgetReservations.modelCallId} is null`,
            ),
          )
          .orderBy(budgetReservations.attempt, budgetReservations.budgetId)
          .limit(1);

        const attempt = row.attempt + 1;
        await tx.update(executionSteps).set({ attempt }).where(eq(executionSteps.id, row.id));
        return {
          kind: 'begin',
          stepId: row.id,
          attempt,
          lostAttempt: held
            ? { attempt: held.attempt, reservationId: held.id, amountMicros: held.amountMicros }
            : null,
        };
      });
    },

    bindProfile(context, binding) {
      return withTenantTx(database, context, async (tx) => {
        const run = await lockRun(tx, binding.runId);
        if (!run) throw new AppError('NOT_FOUND');
        if (run.boundProfileId) {
          // The same profile at the same version is a retry. Anything else is a run trying to move.
          if (
            run.boundProfileId !== binding.profileId ||
            run.boundProfileVersion !== binding.profileVersion
          ) {
            throw new AppError('POLICY_DENIED');
          }
          return;
        }
        await tx
          .update(agentRuns)
          .set({
            boundProfileId: binding.profileId,
            boundProfileVersion: binding.profileVersion,
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
      });
    },
  };
}
