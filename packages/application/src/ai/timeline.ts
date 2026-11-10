// What a person can see of a run: codes and counters, and no model text, because the role this runs under
// cannot read any (ADR-028 FD-4, FD-5). Access follows the Work Unit: a run is reported as not found to
// anyone who may not read its work, so neither its existence nor its work's can be probed through it.
import {
  agentRunViewSchema,
  executionStepViewSchema,
  type AgentRunView,
  type ExecutionStepView,
} from '@ensemus/contracts/ai';
import {
  agentDefinitions,
  agentRuns,
  agentVersions,
  executionSteps,
  rateCards,
  runControls,
  usageLedger,
  withTenantTx,
  workAssignments,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type { RunControlKind } from '@ensemus/domain/ai';
import { canChangeWork, type Classification } from '@ensemus/domain/policy';
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { loadReadable } from '../work';

// Bounds on what one read returns. Neither is a limit on a run: a run's own turn and tool limits already
// keep its steps below this, and older runs are still there to be asked for by ID.
const MAX_RUNS_LISTED = 50;
const MAX_STEPS_LISTED = 2_000;

type RunRow = Pick<
  typeof agentRuns.$inferSelect,
  | 'id'
  | 'workUnitId'
  | 'agentVersionId'
  | 'parentRunId'
  | 'status'
  | 'stopCode'
  | 'effectiveClassification'
  | 'modelTurns'
  | 'toolCalls'
  | 'inputTokens'
  | 'outputTokens'
  | 'costMicros'
  | 'createdAt'
  | 'endedAt'
>;

/** Listed fields only, and checked against the contract, so an internal column cannot leave this way. */
export function toAgentRunView(row: RunRow, isEstimate: boolean): AgentRunView {
  return agentRunViewSchema.parse({
    id: row.id,
    work_unit_id: row.workUnitId,
    agent_version_id: row.agentVersionId,
    parent_run_id: row.parentRunId,
    status: row.status,
    stop_code: row.stopCode,
    effective_classification: row.effectiveClassification,
    model_turns: row.modelTurns,
    tool_calls: row.toolCalls,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cost_micros: row.costMicros,
    cost_is_estimate: isEstimate,
    created_at: row.createdAt.toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
  });
}

type StepRow = Pick<
  typeof executionSteps.$inferSelect,
  | 'stepNumber'
  | 'kind'
  | 'state'
  | 'labelCode'
  | 'outcome'
  | 'decisionCode'
  | 'startedAt'
  | 'endedAt'
>;

/** Codes and times. A step row has no free-text column, and this adds none. */
export function toStepView(row: StepRow): ExecutionStepView {
  return executionStepViewSchema.parse({
    step_number: row.stepNumber,
    kind: row.kind,
    state: row.state,
    label_code: row.labelCode,
    outcome: row.outcome,
    decision_code: row.decisionCode,
    started_at: row.startedAt.toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
  });
}

export type RunCostFacts = {
  /** Ledger entries for this run that carry a cost. */
  costing: number;
  /** How many of those are not a final figure from an Ensemus rate card, in Cloud. */
  unbacked: number;
};

/**
 * Whether a cost is only an estimate. It is one until a final entry from an Ensemus rate card backs every
 * part of it, which never happens in BYOM or Sovereign, where the rates are the tenant's own, and is
 * not so for a lost answer charged at its reserved amount (ADR-028 FD-12).
 */
export function costIsEstimate(facts: RunCostFacts | undefined): boolean {
  return !facts || facts.costing === 0 || facts.unbacked > 0;
}

async function costFactsFor(tx: Tx, runIds: readonly string[]) {
  if (runIds.length === 0) return new Map<string, RunCostFacts>();
  const rows = await tx
    .select({
      runId: usageLedger.runId,
      costing: sql<number>`count(*)::int`,
      unbacked: sql<number>`(count(*) filter (where ${usageLedger.commercialMode} <> 'cloud'
        or ${usageLedger.status} = 'estimated'
        or ${rateCards.source} is distinct from 'ensemus_card'))::int`,
    })
    .from(usageLedger)
    .leftJoin(
      rateCards,
      and(
        eq(rateCards.organizationId, usageLedger.organizationId),
        eq(rateCards.id, usageLedger.rateCardId),
      ),
    )
    // A tool call has no price, so it says nothing about whether the money is an estimate.
    .where(and(inArray(usageLedger.runId, [...runIds]), gt(usageLedger.costMicros, 0)))
    .groupBy(usageLedger.runId);
  return new Map(rows.map(({ runId, ...facts }) => [runId, facts]));
}

const runColumns = {
  id: agentRuns.id,
  workUnitId: agentRuns.workUnitId,
  agentVersionId: agentRuns.agentVersionId,
  parentRunId: agentRuns.parentRunId,
  initiatorMembershipId: agentRuns.initiatorMembershipId,
  status: agentRuns.status,
  stopCode: agentRuns.stopCode,
  effectiveClassification: agentRuns.effectiveClassification,
  modelTurns: agentRuns.modelTurns,
  toolCalls: agentRuns.toolCalls,
  inputTokens: agentRuns.inputTokens,
  outputTokens: agentRuns.outputTokens,
  costMicros: agentRuns.costMicros,
  createdAt: agentRuns.createdAt,
  endedAt: agentRuns.endedAt,
};

/** An ID that is not one finds nothing, as anything else missing does, and never reaches a query. */
export function runIdOrMissing(id: string): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
}

/**
 * The gate for everything about one run. Row-level security confines this to the tenant, so a run from
 * another organization finds nothing, and work this person may not read is reported the same way.
 */
export async function loadReadableRun(tx: Tx, context: TenantContext, agentRunId: string) {
  const [run] = await tx.select(runColumns).from(agentRuns).where(eq(agentRuns.id, agentRunId));
  if (!run) throw new AppError('NOT_FOUND');
  const work = await loadReadable(tx, context, run.workUnitId);
  return { run, work };
}

function selectSteps(tx: Tx, agentRunId: string) {
  return tx
    .select({
      stepNumber: executionSteps.stepNumber,
      kind: executionSteps.kind,
      state: executionSteps.state,
      labelCode: executionSteps.labelCode,
      outcome: executionSteps.outcome,
      decisionCode: executionSteps.decisionCode,
      startedAt: executionSteps.startedAt,
      endedAt: executionSteps.endedAt,
    })
    .from(executionSteps)
    .where(eq(executionSteps.runId, agentRunId))
    .orderBy(asc(executionSteps.stepNumber))
    .limit(MAX_STEPS_LISTED);
}

export async function latestControlOf(tx: Tx, agentRunId: string): Promise<RunControlKind | null> {
  const [row] = await tx
    .select({ kind: runControls.kind })
    .from(runControls)
    .where(eq(runControls.runId, agentRunId))
    .orderBy(desc(runControls.createdAt), desc(runControls.id))
    .limit(1);
  return (row?.kind as RunControlKind | undefined) ?? null;
}

export async function getAgentRun(
  database: AppDatabase,
  context: TenantContext,
  agentRunId: string,
): Promise<AgentRunView> {
  const id = runIdOrMissing(agentRunId);
  return withTenantTx(database, context, async (tx) => {
    const { run } = await loadReadableRun(tx, context, id);
    const facts = await costFactsFor(tx, [run.id]);
    return toAgentRunView(run, costIsEstimate(facts.get(run.id)));
  });
}

export async function listRunsForWork(
  database: AppDatabase,
  context: TenantContext,
  workUnitId: string,
): Promise<readonly AgentRunView[]> {
  const id = runIdOrMissing(workUnitId);
  return withTenantTx(database, context, async (tx) => {
    await loadReadable(tx, context, id);
    const runs = await tx
      .select(runColumns)
      .from(agentRuns)
      .where(eq(agentRuns.workUnitId, id))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(MAX_RUNS_LISTED);
    const facts = await costFactsFor(
      tx,
      runs.map((run) => run.id),
    );
    return runs.map((run) => toAgentRunView(run, costIsEstimate(facts.get(run.id))));
  });
}

export async function listRunSteps(
  database: AppDatabase,
  context: TenantContext,
  agentRunId: string,
): Promise<readonly ExecutionStepView[]> {
  const id = runIdOrMissing(agentRunId);
  return withTenantTx(database, context, async (tx) => {
    await loadReadableRun(tx, context, id);
    return (await selectSteps(tx, id)).map(toStepView);
  });
}

export type RunSummary = {
  view: AgentRunView;
  /** A name a person gave the agent when publishing it. */
  agentName: string;
  versionNumber: number;
  initiatorMembershipId: string;
};

export type RunTimeline = {
  work: {
    id: string;
    title: string;
    classification: string;
    status: string;
    executionPlan: string | null;
    runRequestedAt: Date | null;
    runId: string | null;
  };
  /** Whether this person may change the work, which starting a run needs on top of `agent.run`. */
  canChangeWork: boolean;
  /** Newest first. */
  runs: readonly RunSummary[];
  /** The run asked for, or the newest. Null when no agent has run on this work. */
  selected: RunSummary | null;
  steps: readonly ExecutionStepView[];
  /** The last stop, pause or resume anyone asked for on the selected run. */
  latestControl: RunControlKind | null;
};

/**
 * Everything the run page shows, read in one transaction so that its parts agree. PostgreSQL is the read
 * model, so the answer is the same from any replica and after any reconnect.
 */
export async function getRunTimeline(
  database: AppDatabase,
  context: TenantContext,
  workUnitId: string,
  options: { runId?: string } = {},
): Promise<RunTimeline> {
  const id = runIdOrMissing(workUnitId);
  const wanted = options.runId === undefined ? undefined : runIdOrMissing(options.runId);
  return withTenantTx(database, context, async (tx) => {
    const work = await loadReadable(tx, context, id);
    const assignment = await tx
      .select({ m: workAssignments.membershipId })
      .from(workAssignments)
      .where(
        and(
          eq(workAssignments.workUnitId, id),
          eq(workAssignments.membershipId, context.membershipId),
        ),
      );
    const mayChange = canChangeWork(
      {
        classification: work.classification as Classification,
        ownerMembershipId: work.ownerMembershipId,
        isAssigned: assignment.length > 0,
      },
      { membershipId: context.membershipId, role: context.role },
    );

    const selectRuns = (where: SQL | undefined) =>
      tx
        .select({
          run: runColumns,
          agentName: agentDefinitions.name,
          versionNumber: agentVersions.versionNumber,
        })
        .from(agentRuns)
        .innerJoin(
          agentVersions,
          and(
            eq(agentVersions.organizationId, agentRuns.organizationId),
            eq(agentVersions.id, agentRuns.agentVersionId),
          ),
        )
        .innerJoin(
          agentDefinitions,
          and(
            eq(agentDefinitions.organizationId, agentVersions.organizationId),
            eq(agentDefinitions.id, agentVersions.definitionId),
          ),
        )
        .where(where)
        .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
        .limit(MAX_RUNS_LISTED);

    const rows = await selectRuns(eq(agentRuns.workUnitId, id));
    let chosen = rows[0];
    if (wanted !== undefined) {
      // Asked for by ID, so it may be older than the list, and it has to be on this work.
      [chosen] = await selectRuns(and(eq(agentRuns.id, wanted), eq(agentRuns.workUnitId, id)));
      if (!chosen) throw new AppError('NOT_FOUND');
    }
    const facts = await costFactsFor(
      tx,
      (chosen ? [...rows, chosen] : rows).map(({ run }) => run.id),
    );
    const summarize = (row: (typeof rows)[number]): RunSummary => ({
      view: toAgentRunView(row.run, costIsEstimate(facts.get(row.run.id))),
      agentName: row.agentName,
      versionNumber: row.versionNumber,
      initiatorMembershipId: row.run.initiatorMembershipId,
    });
    return {
      work: {
        id: work.id,
        title: work.title,
        classification: work.classification,
        status: work.status,
        executionPlan: work.executionPlan,
        runRequestedAt: work.runRequestedAt,
        runId: work.runId,
      },
      canChangeWork: mayChange,
      runs: rows.map(summarize),
      selected: chosen ? summarize(chosen) : null,
      steps: chosen ? (await selectSteps(tx, chosen.run.id)).map(toStepView) : [],
      latestControl: chosen ? await latestControlOf(tx, chosen.run.id) : null,
    };
  });
}
