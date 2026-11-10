// Owned by the studio slice (AGENT-08). See docs/06-delivery/m7-slices.md and ADR-031 D5.
import { createHash } from 'node:crypto';
import {
  agentDefinitions,
  interactiveSessionOf,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  agentDrafts,
  processDrafts,
  simulationInputs,
  simulationRuns,
} from '@ensemus/database/product';
import { TOOL_MANIFESTS } from '@ensemus/domain/ai-tools';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  compileProcessGraph,
  type ProcessGraph,
  type ProcessSpec,
} from '@ensemus/domain/process-spec';
import { simulateProcess } from '@ensemus/domain/process-run';
import { AGGREGATE_SIMULATION_RUN, SIMULATION_REQUESTED } from '@ensemus/domain/product-events';
import { canReadRecord } from '@ensemus/domain/product-policy';
import { agentScenario, simulateAgent, type SimulationReport } from '@ensemus/domain/simulation';
import { findBundledWorkflow } from '@ensemus/packs/bundled';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { emit } from '../events';
import { canonicalId } from '../ids';
import { auditAction } from '../work';
import { studioPerson, withStudioTx as withTenantTx } from './studio-authority';

type Row = typeof simulationRuns.$inferSelect;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const view = (row: Row): SimulationView => ({
  id: row.id,
  subjectId: row.subjectId,
  subjectKey: row.subjectKey,
  subjectSha256: row.subjectSha256,
  scenarioKey: row.scenarioKey,
  subjectKind: row.subjectKind as SimulationView['subjectKind'],
  status: row.status as SimulationView['status'],
  report: row.report as SimulationReport | null,
  outcomeCode: row.outcomeCode,
  createdAt: row.createdAt,
  finishedAt: row.finishedAt,
});

/** Also used at final publication: the same current graph must still compile to the reviewed hash. */
export async function compileCurrentProcess(
  tx: Tx,
  graph: ProcessGraph,
  classification: ProcessSpec['classification'],
) {
  const definitions = await tx
    .select({ id: agentDefinitions.id })
    .from(agentDefinitions)
    .limit(2000);
  const result = compileProcessGraph(
    graph,
    {
      classification,
      agentDefinitionIds: new Set(definitions.map((row) => row.id)),
      toolIds: new Set(
        TOOL_MANIFESTS.filter((tool) => tool.class === 'external_write').map((tool) => tool.id),
      ),
    },
    sha256,
  );
  if (!result.ok || !result.spec || !result.specSha256) throw new AppError('GRAPH_INVALID');
  return { spec: result.spec, hash: result.specSha256 };
}

async function subjectInput(tx: Tx, context: TenantContext, subject: SimulationSubject) {
  if (subject.kind === 'agent_draft') {
    const [row] = await tx
      .select()
      .from(agentDrafts)
      .where(eq(agentDrafts.id, canonicalId(subject.draftId)))
      .for('share');
    if (!row) throw new AppError('NOT_FOUND');
    if (
      row.status === 'archived' ||
      !row.specSha256 ||
      !row.compiledSpecCanonical ||
      !row.compilePolicyVersion
    )
      throw new AppError('DRAFT_INVALID');
    if (sha256(row.compiledSpecCanonical) !== row.specSha256) throw new AppError('DRAFT_INVALID');
    return {
      kind: subject.kind,
      id: row.id,
      key: null,
      hash: row.specSha256,
      specCanonical: row.compiledSpecCanonical,
      sourceVersion: row.version,
      policyVersion: row.compilePolicyVersion,
    };
  }
  if (subject.kind === 'process_draft') {
    const [row] = await tx
      .select()
      .from(processDrafts)
      .where(eq(processDrafts.id, canonicalId(subject.draftId)))
      .for('share');
    if (!row || !canReadRecord(row, context)) throw new AppError('NOT_FOUND');
    if (row.status === 'archived' || !row.specSha256) throw new AppError('GRAPH_INVALID');
    const compiled = await compileCurrentProcess(
      tx,
      row.graph as ProcessGraph,
      row.classification as ProcessSpec['classification'],
    );
    if (compiled.hash !== row.specSha256) throw new AppError('SIMULATION_STALE');
    return {
      kind: subject.kind,
      id: row.id,
      key: null,
      hash: compiled.hash,
      specCanonical: canonicalJson(compiled.spec),
      sourceVersion: row.version,
      policyVersion: 'process-v1',
    };
  }
  const bundled = findBundledWorkflow(subject.processKey);
  if (!bundled) throw new AppError('NOT_FOUND');
  const compiled = await compileCurrentProcess(tx, bundled.graph, bundled.classification);
  return {
    kind: subject.kind,
    id: null,
    key: bundled.key,
    hash: compiled.hash,
    specCanonical: canonicalJson(compiled.spec),
    sourceVersion: bundled.version,
    policyVersion: 'bundled-v1',
  };
}

async function readable(tx: Tx, context: TenantContext, id: string) {
  const [row] = await tx
    .select()
    .from(simulationRuns)
    .where(eq(simulationRuns.id, canonicalId(id)));
  if (!row) throw new AppError('NOT_FOUND');
  if (row.subjectKind === 'process_draft') {
    const [draft] = await tx
      .select({ id: processDrafts.id })
      .from(processDrafts)
      .where(
        and(
          eq(processDrafts.id, row.subjectId!),
          sql`(${processDrafts.classification}<>'restricted' or ${processDrafts.ownerMembershipId}=${context.membershipId}::uuid)`,
        ),
      );
    if (!draft) throw new AppError('NOT_FOUND');
  }
  return row;
}

export type SimulationSubject =
  | { kind: 'agent_draft'; draftId: string }
  | { kind: 'process_draft'; draftId: string }
  | { kind: 'bundled_workflow'; processKey: string };

export type SimulationView = {
  id: string;
  subjectKind: 'agent_draft' | 'process_draft' | 'bundled_workflow';
  subjectId: string | null;
  subjectKey: string | null;
  subjectSha256: string;
  scenarioKey: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'errored';
  outcomeCode: string | null;
  report: SimulationReport | null;
  createdAt: Date;
  finishedAt: Date | null;
};

/**
 * Needs `studio.author`, or `onboarding.manage` for a catalog workflow. Commits the row and SIMULATION_REQUESTED
 * together, and the worker does the rest. The hash is read here, so a later edit cannot change what ran.
 */
export async function requestSimulation(
  database: AppDatabase,
  context: TenantContext,
  input: { subject: SimulationSubject; scenarioKey: string },
): Promise<SimulationView> {
  return withTenantTx(database, context, async (tx) => {
    const actor = await studioPerson(
        tx,
        context,
        input.subject.kind === 'bundled_workflow' ? 'onboarding.manage' : 'studio.author',
      ),
      identity = interactiveSessionOf(actor);
    if (!identity) throw new AppError('FORBIDDEN');
    const snapshot = await subjectInput(tx, actor, input.subject);
    if (
      snapshot.kind === 'agent_draft'
        ? !agentScenario(input.scenarioKey)
        : snapshot.kind === 'bundled_workflow'
          ? findBundledWorkflow(snapshot.key!)?.scenario.key !== input.scenarioKey
          : input.scenarioKey !== 'standard.process'
    )
      throw new AppError('INVALID_INPUT');
    const [row] = await tx
      .insert(simulationRuns)
      .values({
        organizationId: actor.organizationId,
        subjectKind: snapshot.kind,
        subjectId: snapshot.id,
        subjectKey: snapshot.key,
        subjectSha256: snapshot.hash,
        scenarioKey: input.scenarioKey,
        requestedByMembershipId: actor.membershipId,
      })
      .returning();
    if (!row) throw new AppError('INVALID_STATE');
    await tx.insert(simulationInputs).values({
      organizationId: actor.organizationId,
      simulationRunId: row.id,
      sourceVersion: snapshot.sourceVersion,
      specCanonical: snapshot.specCanonical,
      policyVersion: snapshot.policyVersion,
      requestedByMembershipId: actor.membershipId,
      requestedSessionId: identity.sessionId,
    });
    await emit(tx, actor, {
      eventType: SIMULATION_REQUESTED,
      aggregateType: AGGREGATE_SIMULATION_RUN,
      aggregateId: row.id,
      aggregateVersion: 1,
      classification: 'internal',
      payload: { simulation_id: row.id, subject_kind: snapshot.kind },
    });
    await auditAction(tx, actor, 'simulation.requested', `simulation_run:${row.id}`);
    return view(row);
  });
}

export async function getSimulation(
  database: AppDatabase,
  context: TenantContext,
  simulationId: string,
): Promise<SimulationView> {
  return withTenantTx(database, context, async (tx) => {
    const actor = await studioPerson(tx, context);
    return view(await readable(tx, actor, simulationId));
  });
}

export async function listSimulations(
  database: AppDatabase,
  context: TenantContext,
  input: { subject: SimulationSubject },
): Promise<readonly SimulationView[]> {
  return withTenantTx(database, context, async (tx) => {
    const actor = await studioPerson(tx, context);
    // Authorize the subject first; a guessed private subject cannot affect a count or page.
    if (input.subject.kind === 'process_draft') {
      const [draft] = await tx
        .select()
        .from(processDrafts)
        .where(eq(processDrafts.id, canonicalId(input.subject.draftId)));
      if (!draft || !canReadRecord(draft, actor)) throw new AppError('NOT_FOUND');
    } else if (input.subject.kind === 'agent_draft') {
      if (
        !(
          await tx
            .select({ id: agentDrafts.id })
            .from(agentDrafts)
            .where(eq(agentDrafts.id, canonicalId(input.subject.draftId)))
        )[0]
      )
        throw new AppError('NOT_FOUND');
    } else if (!findBundledWorkflow(input.subject.processKey)) throw new AppError('NOT_FOUND');
    return (
      await tx
        .select()
        .from(simulationRuns)
        .where(
          and(
            eq(simulationRuns.subjectKind, input.subject.kind),
            input.subject.kind === 'bundled_workflow'
              ? eq(simulationRuns.subjectKey, input.subject.processKey)
              : eq(simulationRuns.subjectId, canonicalId(input.subject.draftId)),
          ),
        )
        .orderBy(desc(simulationRuns.createdAt), desc(simulationRuns.id))
        .limit(100)
    ).map(view);
  });
}

/**
 * Called by the worker's Activity, with a service context. Claims a queued run, computes the report with the
 * pure simulators, and records it. Running it again on a finished run changes nothing.
 */
export async function runSimulationStep(
  database: AppDatabase,
  context: TenantContext,
  input: { simulationId: string },
): Promise<'passed' | 'failed' | 'errored' | 'already_finished'> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const id = canonicalId(input.simulationId);
  return withTenantTx(database, context, async (tx) => {
    await tx.execute(sql`select set_config('app.studio_simulation_id',${id},true)`);
    const [row] = await tx
      .select()
      .from(simulationRuns)
      .where(eq(simulationRuns.id, id))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (['passed', 'failed', 'errored'].includes(row.status)) return 'already_finished';
    const [snapshot] = await tx
      .select()
      .from(simulationInputs)
      .where(eq(simulationInputs.simulationRunId, id));
    if (!snapshot || sha256(snapshot.specCanonical) !== row.subjectSha256)
      throw new AppError('SIMULATION_STALE');
    await tx
      .update(simulationRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(simulationRuns.id, id));
    const spec = JSON.parse(snapshot.specCanonical) as Record<string, unknown>;
    let report: SimulationReport;
    if (row.subjectKind === 'agent_draft') {
      const scenario = agentScenario(row.scenarioKey);
      if (!scenario) throw new AppError('INVALID_STATE');
      report = simulateAgent(spec, row.subjectSha256, scenario);
    } else {
      const scenario =
        row.subjectKind === 'bundled_workflow'
          ? findBundledWorkflow(row.subjectKey!)?.scenario
          : { key: 'standard.process', turns: [] };
      if (!scenario || scenario.key !== row.scenarioKey) throw new AppError('SIMULATION_STALE');
      report = simulateProcess(spec as unknown as ProcessSpec, row.subjectSha256, scenario);
    }
    await tx
      .update(simulationRuns)
      .set({
        status: report.outcome,
        report,
        reportSha256: sha256(canonicalJson(report)),
        outcomeCode:
          report.outcome === 'passed' ? 'SYNTHETIC_GATES_PASSED' : 'SYNTHETIC_GATES_FAILED',
        finishedAt: new Date(),
      })
      .where(eq(simulationRuns.id, id));
    await auditAction(
      tx,
      context,
      'simulation.finished',
      `simulation_run:${id}`,
      report.outcome === 'passed' ? 'SYNTHETIC_GATES_PASSED' : 'SYNTHETIC_GATES_FAILED',
    );
    return report.outcome;
  });
}
