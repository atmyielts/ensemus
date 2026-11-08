// Actual native agent control/Work purge adapter. Each database Tx is bounded and contains no
// provider/object call. Cursor progress is never completeness; every final proof uses the anti-join.
import {
  agentRuns,
  knowledgePurgeJobs,
  knowledgeSources,
  runInputCheckpoints,
  sourceRunClosures,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { closeRunWithoutContext } from '../ai/runs';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { redactDelegatedWorkInTx } from './delegated-work-redaction';
import type { DelegatedWorkPurge, DelegatedWorkPurgeCounts } from './ports';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const countsWire = z.strictObject({
  removed: count,
  remaining: count,
  unproven: count,
  receiptsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  controlsRemaining: count,
});
type SourceState = Awaited<ReturnType<typeof sourceState>>;
type Cursor = {
  sourceVersion: number;
  jobId: string;
  version: number | null;
  after: string | null;
  kind: 'run' | 'child';
};
function service(context: TenantContext) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
}
async function sourceState(tx: Tx, sourceId: string) {
  const [source] = await tx
    .select({
      id: knowledgeSources.id,
      version: knowledgeSources.version,
      state: knowledgeSources.state,
    })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, sourceId))
    .for('share', { noWait: true });
  if (!source || !['revoked', 'deleted'].includes(source.state))
    throw new AppError('INVALID_STATE');
  if (!Number.isSafeInteger(source.version) || source.version < 1)
    throw new AppError('INVALID_STATE');
  const [job] = await tx
    .select()
    .from(knowledgePurgeJobs)
    .where(eq(knowledgePurgeJobs.sourceId, sourceId));
  if (!job) throw new AppError('NOT_FOUND');
  return { source, job };
}
async function countsInTx(tx: Tx, state: SourceState) {
  const result =
    await tx.execute(sql`select removed,remaining,unproven,receipts_sha256 "receiptsSha256",
    ai.source_run_closure_remaining(${state.source.id}::uuid,${state.source.version}::bigint) "controlsRemaining"
    from ai.source_delegated_work_counts(${state.source.id}::uuid)`);
  const parsed = countsWire.safeParse(result.rows[0]);
  if (!parsed.success || result.rows.length !== 1) throw new AppError('INVALID_STATE');
  return parsed.data;
}
const cursorFor = (state: SourceState, kind: Cursor['kind']): Cursor => ({
  sourceVersion: state.source.version,
  jobId: state.job.id,
  version: state.job.delegatedWorkCursorSourceVersion,
  after:
    state.job.delegatedWorkCursorSourceVersion === state.source.version
      ? kind === 'run'
        ? state.job.delegatedWorkAfterRun
        : state.job.delegatedWorkAfterChild
      : null,
  kind,
});
async function advance(tx: Tx, cursor: Cursor, after: string | null) {
  const field =
    cursor.kind === 'run'
      ? knowledgePurgeJobs.delegatedWorkAfterRun
      : knowledgePurgeJobs.delegatedWorkAfterChild;
  const reset = cursor.version !== cursor.sourceVersion;
  const common = {
    delegatedWorkCursorSourceVersion: cursor.sourceVersion,
    ...(reset ? { delegatedWorkAfterRun: null, delegatedWorkAfterChild: null } : {}),
  };
  const rows = await tx
    .update(knowledgePurgeJobs)
    .set(
      cursor.kind === 'run'
        ? { ...common, delegatedWorkAfterRun: after }
        : { ...common, delegatedWorkAfterChild: after },
    )
    .where(
      and(
        eq(knowledgePurgeJobs.id, cursor.jobId),
        sql`${knowledgePurgeJobs.delegatedWorkCursorSourceVersion} is not distinct from ${cursor.version}::bigint`,
        ...(reset ? [] : [sql`${field} is not distinct from ${cursor.after}::uuid`]),
      ),
    )
    .returning({ id: knowledgePurgeJobs.id });
  if (rows.length !== 1) return false;
  cursor.version = cursor.sourceVersion;
  cursor.after = after;
  return true;
}

export async function confirmDelegatedWorkPurgeInTx(
  tx: Tx,
  context: TenantContext,
  input: { sourceId: string },
): Promise<DelegatedWorkPurgeCounts> {
  service(context);
  const state = await sourceState(tx, idSchema.parse(input.sourceId)),
    counts = await countsInTx(tx, state);
  const confirmed =
    counts.remaining === 0 &&
    counts.controlsRemaining === 0 &&
    counts.unproven === 0 &&
    state.job.delegatedWorkCheckedAt !== null &&
    state.job.delegatedWorkSourceVersion === state.source.version &&
    state.job.delegatedWorkReceiptsSha256 === counts.receiptsSha256 &&
    state.job.transcriptsCheckedAt !== null &&
    state.job.transcriptSourceVersion === state.source.version;
  return {
    removed: counts.removed,
    remaining: counts.remaining,
    controlsRemaining: counts.controlsRemaining,
    unproven: counts.unproven,
    confirmed,
  };
}
export function createDelegatedWorkPurge(deps: {
  database: AppDatabase;
  /** Bound to the actual Knowledge call store by agent composition, never supplied by DTO/model. */
  accounting: { reconcileRun(context: TenantContext, runId: string): Promise<void> };
}): DelegatedWorkPurge {
  const { database } = deps;
  if (!deps.accounting || typeof deps.accounting.reconcileRun !== 'function')
    throw new AppError('CAPABILITY_UNAVAILABLE');
  const inspect = async (tx: Tx, context: TenantContext, sourceId: string) =>
    confirmDelegatedWorkPurgeInTx(tx, context, { sourceId });
  return {
    async confirmInTx(tx, context, input) {
      service(context);
      return inspect(tx, context, idSchema.parse(input.sourceId));
    },
    async purgeSource(context, input) {
      service(context);
      const sourceId = idSchema.parse(input.sourceId);
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
        throw new AppError('INVALID_INPUT');
      await withTenantTx(database, context, async (tx) => {
        const native = await tx.execute<{ allowed: boolean }>(
          sql`select current_user='ensemus_agent' and session_user='ensemus_agent' allowed`,
        );
        if (native.rows[0]?.allowed !== true) throw new AppError('FORBIDDEN');
        const state = await sourceState(tx, sourceId),
          counts = await countsInTx(tx, state);
        if (
          state.job.state === 'completed' &&
          (counts.remaining !== 0 ||
            counts.controlsRemaining !== 0 ||
            counts.unproven !== 0 ||
            state.job.delegatedWorkCheckedAt === null ||
            state.job.delegatedWorkSourceVersion !== state.source.version ||
            state.job.delegatedWorkReceiptsSha256 !== counts.receiptsSha256)
        )
          await tx
            .update(knowledgePurgeJobs)
            .set({
              state: 'failed',
              completedAt: null,
              delegatedWorkCheckedAt: null,
              delegatedWorkSourceVersion: null,
              delegatedWorkReceiptsSha256: null,
            })
            .where(eq(knowledgePurgeJobs.id, state.job.id));
      });
      const controls = await withTenantTx(database, context, async (tx) => {
        const state = await sourceState(tx, sourceId),
          cursor = cursorFor(state, 'run');
        const rows = await tx.execute<{
          id: string;
        }>(sql`select actual.run_id id from ai.source_input_runs(${sourceId}::uuid) actual(run_id)
          left join ai.agent_runs run on run.organization_id=${context.organizationId}::uuid and run.id=actual.run_id
          left join ai.run_input_checkpoints checkpoint on checkpoint.organization_id=${context.organizationId}::uuid and checkpoint.run_id=actual.run_id
          where (${cursor.after}::uuid is null or actual.run_id>${cursor.after}::uuid) and(run.id is null or checkpoint.run_id is null or checkpoint.fenced_at is null
            or checkpoint.payloads_purged_at is null or checkpoint.purged_fence_generation is distinct from checkpoint.fence_generation
            or run.status not in('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')
            or not exists(select 1 from ai.source_run_closures closure where closure.organization_id=${context.organizationId}::uuid
              and closure.source_id=${sourceId}::uuid and closure.source_version=${state.source.version}::bigint and closure.run_id=actual.run_id
              and closure.fence_generation=checkpoint.fence_generation and closure.terminal_version<=run.version)) order by actual.run_id limit ${input.limit}`);
        if (!rows.rows.length && cursor.after !== null) await advance(tx, cursor, null);
        return { cursor, rows: rows.rows };
      });
      for (const row of controls.rows) {
        try {
          await closeRunWithoutContext(database, {
            organizationId: context.organizationId,
            agentRunId: row.id,
            status: 'cancelled',
            stopCode: 'POLICY_DENIED',
          });
          await deps.accounting.reconcileRun(context, row.id);
          await withTenantTx(database, context, async (tx) => {
            const state = await sourceState(tx, sourceId);
            if (state.source.version !== controls.cursor.sourceVersion)
              throw new AppError('VERSION_CONFLICT');
            const [run] = await tx
              .select({ version: agentRuns.version, status: agentRuns.status })
              .from(agentRuns)
              .where(eq(agentRuns.id, row.id));
            const [checkpoint] = await tx
              .select({ generation: runInputCheckpoints.fenceGeneration })
              .from(runInputCheckpoints)
              .where(eq(runInputCheckpoints.runId, row.id));
            if (!run || !checkpoint) throw new AppError('INVALID_STATE');
            await tx
              .insert(sourceRunClosures)
              .values({
                organizationId: context.organizationId,
                sourceId,
                sourceVersion: state.source.version,
                runId: row.id,
                terminalVersion: run.version,
                terminalStatus: run.status,
                fenceGeneration: checkpoint.generation,
              })
              .onConflictDoNothing();
          });
        } catch {
          /* Each failed Tx has ended. No aborted SQL transaction is reused or success recorded. */
        }
        const advanced = await withTenantTx(database, context, (tx) =>
          advance(tx, controls.cursor, row.id),
        );
        if (!advanced) break;
      }
      const bodies = await withTenantTx(database, context, async (tx) => {
        const state = await sourceState(tx, sourceId),
          counts = await countsInTx(tx, state),
          cursor = cursorFor(state, 'child');
        if (counts.controlsRemaining !== 0) return { cursor, rows: [], jobId: state.job.id };
        const rows = await tx.execute<{
          id: string;
          workUnitId: string;
        }>(sql`select receipt.child_run_id id,receipt.child_work_unit_id "workUnitId"
          from ai.delegated_input_receipts receipt where receipt.organization_id=${context.organizationId}::uuid
            and (${cursor.after}::uuid is null or receipt.child_run_id>${cursor.after}::uuid) and not ai.delegated_body_disposed(receipt.child_run_id)
            and exists(select 1 from ai.delegated_input_refs ref where ref.organization_id=receipt.organization_id and ref.child_run_id=receipt.child_run_id
              and((ref.ref_kind='source' and ref.ref_id=${sourceId}::uuid) or ref.source_id=${sourceId}::uuid)) order by receipt.child_run_id limit ${input.limit}`);
        if (!rows.rows.length && cursor.after !== null) await advance(tx, cursor, null);
        return { cursor, rows: rows.rows, jobId: state.job.id };
      });
      for (const row of bodies.rows) {
        try {
          await withTenantTx(database, context, (tx) =>
            redactDelegatedWorkInTx(tx, context, {
              childRunId: row.id,
              workUnitId: row.workUnitId,
              scopeKind: 'knowledge_source',
              scopeId: sourceId,
              purgeJobId: bodies.jobId,
            }),
          );
        } catch {
          /* Held/busy/failed records remain in the authoritative count and are retried next cycle. */
        }
        const advanced = await withTenantTx(database, context, (tx) =>
          advance(tx, bodies.cursor, row.id),
        );
        if (!advanced) break;
      }
      return withTenantTx(database, context, async (tx) => {
        const state = await sourceState(tx, sourceId),
          counts = await countsInTx(tx, state);
        const confirmed =
          counts.remaining === 0 &&
          counts.unproven === 0 &&
          counts.controlsRemaining === 0 &&
          state.job.transcriptsCheckedAt !== null &&
          state.job.transcriptSourceVersion === state.source.version;
        await tx
          .update(knowledgePurgeJobs)
          .set({
            delegatedWorkRemoved: counts.removed,
            delegatedWorkRemaining: counts.remaining,
            delegatedWorkUnknown: counts.unproven,
            delegatedWorkControlsRemaining: counts.controlsRemaining,
            delegatedWorkCheckedAt: confirmed ? new Date() : null,
            delegatedWorkSourceVersion: confirmed ? state.source.version : null,
            delegatedWorkReceiptsSha256: confirmed ? counts.receiptsSha256 : null,
            ...(!confirmed && state.job.state === 'completed'
              ? { state: 'failed', completedAt: null }
              : {}),
          })
          .where(eq(knowledgePurgeJobs.id, state.job.id));
        return inspect(tx, context, sourceId);
      });
    },
  };
}
