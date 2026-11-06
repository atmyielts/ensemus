// Agent-only durable read inventory. IDs/hashes/classes only; no prompt text or model citations.
import { createHash } from 'node:crypto';
import {
  agentRuns,
  runInputCheckpoints,
  runInputObservations,
  knowledgeSources,
  withTenantTx,
  type AgentContext,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { canonicalJson } from '@ensemus/domain/approval';
import { strongestClassification, type AiClassification } from '@ensemus/domain/ai';
import { AppError, pgCode } from '../errors';
import { idSchema } from '../ids';
import type { ArtifactInputInventory } from '../knowledge/artifact-provenance';

export type ObservedInput = {
  kind: 'work_unit' | 'project' | 'client' | 'artifact';
  id: string;
  sha256: string;
  classification: AiClassification;
};
class RunInputClosed extends AppError {
  constructor() {
    super('POLICY_DENIED');
  }
}
export const isRunInputFence = (error: unknown) =>
  error instanceof RunInputClosed ||
  pgCode(error) === 'EN119' ||
  (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EN119');
export const workInputHash = (work: { title: string; objective: string | null }) =>
  createHash('sha256')
    .update(canonicalJson({ title: work.title, objective: work.objective }))
    .digest('hex');
const id = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
const own = (context: AgentContext) => {
  if (context.actorType !== 'agent') throw new AppError('FORBIDDEN');
  return id(context.agentRunId);
};

/** A birth-complete marker is meaningful only under the new immutable runtime admission protocol. */
export async function assertRunInputsOpen(tx: Tx, context: AgentContext) {
  const runId = own(context);
  const proof = await tx.execute<{ admitted: boolean }>(
    sql`select ai.run_input_admitted(${runId}::uuid) as admitted`,
  );
  if (!proof.rows[0]?.admitted) throw new RunInputClosed();
}

/** Acquire before touching payload rows. Purge takes this fence first, then deletes payloads too. */
export async function lockRunInputsForContent(tx: Tx, context: AgentContext) {
  own(context);
  await tx
    .select({ id: runInputCheckpoints.runId })
    .from(runInputCheckpoints)
    .where(eq(runInputCheckpoints.runId, context.agentRunId))
    .for('share');
  await assertRunInputsOpen(tx, context);
  const result = await tx.execute<{ readable: boolean }>(
    sql`select ai.run_inputs_readable(${context.agentRunId}::uuid,${context.membershipId}::uuid) as readable`,
  );
  if (!result.rows[0]?.readable) throw new RunInputClosed();
}

export async function recordRunInputs(
  tx: Tx,
  context: AgentContext,
  input: readonly ObservedInput[],
) {
  await assertRunInputsOpen(tx, context);
  if (!input.length || input.length > 1000) throw new AppError('INVALID_INPUT');
  const artifacts = [
    ...new Set(input.filter((row) => row.kind === 'artifact').map((row) => id(row.id))),
  ].sort();
  if (artifacts.length) {
    // Enumerate the entire source set before any run/checkpoint lock, never one file at a time.
    const sources = await tx.execute<{ id: string }>(
      sql`select distinct knowledge.artifact_required_sources(v.id) as id from (values ${sql.join(
        artifacts.map((artifactId) => sql`(${artifactId}::uuid)`),
        sql`,`,
      )}) v(id) limit 1001`,
    );
    if (sources.rows.length > 1000) throw new AppError('INVALID_INPUT');
    const sourceIds = sources.rows.map((row) => row.id).sort();
    if (sourceIds.length)
      await tx
        .select({ id: knowledgeSources.id })
        .from(knowledgeSources)
        .where(inArray(knowledgeSources.id, sourceIds))
        .orderBy(knowledgeSources.id)
        .for('share', { noWait: true });
  }
  const [run] = await tx
    .select({ classification: agentRuns.effectiveClassification })
    .from(agentRuns)
    .where(eq(agentRuns.id, context.agentRunId))
    .for('update');
  if (!run) throw new AppError('NOT_FOUND');
  await tx
    .insert(runInputObservations)
    .values(
      [...input]
        .sort((a, b) =>
          `${a.kind}:${a.id}:${a.sha256}`.localeCompare(`${b.kind}:${b.id}:${b.sha256}`),
        )
        .map((row) => ({
          organizationId: context.organizationId,
          runId: context.agentRunId,
          inputKind: row.kind,
          inputId: id(row.id),
          inputSha256: row.sha256,
          classification: row.classification,
        })),
    )
    .onConflictDoNothing();
  const classification = input.reduce(
    (current, row) => strongestClassification(current, row.classification),
    run.classification as AiClassification,
  );
  if (classification !== run.classification)
    await tx
      .update(agentRuns)
      .set({ effectiveClassification: classification })
      .where(eq(agentRuns.id, context.agentRunId));
}

export async function assertRunInputsReadable(tx: Tx, context: AgentContext) {
  await assertRunInputsOpen(tx, context);
  const result = await tx.execute<{ readable: boolean }>(
    sql`select ai.run_inputs_readable(${context.agentRunId}::uuid,${context.membershipId}::uuid) as readable`,
  );
  if (!result.rows[0]?.readable) throw new AppError('NOT_FOUND');
}

export function inventoryFromObservations(input: {
  complete: boolean;
  fenced: boolean;
  workUnitId: string;
  observations: readonly ObservedInput[];
}) {
  if (
    !input.complete ||
    input.fenced ||
    input.observations.length > 1000 ||
    !input.observations.some((row) => row.kind === 'work_unit' && row.id === input.workUnitId)
  )
    return null;
  const artifacts = new Map<string, string>();
  for (const row of input.observations) {
    if (
      !['work_unit', 'project', 'client', 'artifact'].includes(row.kind) ||
      !idSchema.safeParse(row.id).success ||
      !/^[0-9a-f]{64}$/.test(row.sha256)
    )
      return null;
    if (row.kind === 'artifact') {
      const prior = artifacts.get(row.id);
      if (prior && prior !== row.sha256) return null;
      artifacts.set(row.id, row.sha256);
    }
  }
  return {
    artifactInputs: [...artifacts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([artifactId, sha256]) => ({ artifactId, sha256 })),
    recordInputs: input.observations
      .filter(
        (row): row is ObservedInput & { kind: 'work_unit' | 'project' | 'client' } =>
          row.kind !== 'artifact',
      )
      .map(({ kind, id, sha256 }) => ({ kind, id, sha256 })),
  };
}

export function createRunInputInventory(): ArtifactInputInventory {
  return {
    async inspectInTx(tx, context, input) {
      if (
        context.actorType !== 'agent' ||
        input.execution.kind !== 'agent_run' ||
        context.agentRunId !== input.execution.id
      )
        return { known: false };
      const [run] = await tx
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, input.execution.id),
            eq(agentRuns.workUnitId, input.workUnitId),
            eq(agentRuns.initiatorMembershipId, context.membershipId),
          ),
        );
      const [checkpoint] = await tx
        .select()
        .from(runInputCheckpoints)
        .where(eq(runInputCheckpoints.runId, input.execution.id));
      const admitted = await tx.execute<{ admitted: boolean; readable: boolean }>(
        sql`select ai.run_input_admitted(${input.execution.id}::uuid) as admitted,ai.run_inputs_readable(${input.execution.id}::uuid,${context.membershipId}::uuid) as readable`,
      );
      if (!run || !checkpoint || !admitted.rows[0]?.admitted || !admitted.rows[0]?.readable)
        return { known: false };
      const observations = await tx
        .select()
        .from(runInputObservations)
        .where(eq(runInputObservations.runId, input.execution.id))
        .limit(1001);
      const proof = inventoryFromObservations({
        complete: checkpoint.historyComplete,
        fenced: checkpoint.fencedAt !== null,
        workUnitId: run.workUnitId,
        observations: observations.map((row) => ({
          kind: row.inputKind as ObservedInput['kind'],
          id: row.inputId,
          sha256: row.inputSha256,
          classification: row.classification as AiClassification,
        })),
      });
      if (!proof) return { known: false };
      return {
        known: true,
        execution: input.execution,
        workUnitId: run.workUnitId,
        viewerMembershipId: run.initiatorMembershipId,
        classification: run.effectiveClassification as AiClassification,
        noKnowledge: false,
        ...proof,
      };
    },
  };
}

/** Fresh check immediately before model dispatch; never carries company text across the boundary. */
export const checkRunInputDispatch = (database: AppDatabase, context: AgentContext) =>
  withTenantTx(database, context, (tx) => assertRunInputsReadable(tx, context));
