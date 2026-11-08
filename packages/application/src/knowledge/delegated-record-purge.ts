// Native agent role only for effects. Each transaction locks the actual closed record snapshot;
// no transaction crosses accounting/network work, and every final decision uses the global anti-join.
import {
  agentRuns, recordPurgeJobs, recordRunClosures, runInputCheckpoints, withTenantTx,
  type AppDatabase, type TenantContext, type Tx,
} from '@ensemus/database';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { closeRunWithoutContext } from '../ai/runs';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { redactDelegatedWorkInTx } from './delegated-work-redaction';
import type { DelegatedRecordPurge, RecordPurgeKind, RunTranscriptPurge } from './ports';

const kindSchema = z.enum(['work_unit','project','client','object_record']);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const countsSchema = z.strictObject({ removed: count, remaining: count, unproven: count,
  controlsRemaining: count, receiptsSha256: z.string().regex(/^[0-9a-f]{64}$/) });
type Scope = { kind: RecordPurgeKind; id: string; snapshot: string };
type Cursor = Scope & { kindOfPage: 'run' | 'child'; after: string | null };
function service(context: TenantContext) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
}
async function snapshot(tx: Tx, scope: { kind: RecordPurgeKind; id: string }): Promise<Scope> {
  const result = await tx.execute<{ hash: string | null }>(
    sql`select ai.lock_record_purge_snapshot(${scope.kind},${scope.id}::uuid) hash`,
  );
  const hash = result.rows[0]?.hash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new AppError('INVALID_STATE');
  return { ...scope, snapshot: hash };
}
async function sameSnapshot(tx: Tx, scope: Scope) {
  if ((await snapshot(tx, scope)).snapshot !== scope.snapshot) throw new AppError('VERSION_CONFLICT');
}
async function counts(tx: Tx, scope: Scope) {
  const result = await tx.execute(sql`select removed,remaining,unproven,receipts_sha256 "receiptsSha256",
    ai.record_run_closure_remaining(${scope.kind},${scope.id}::uuid,${scope.snapshot}) "controlsRemaining"
    from ai.record_work_counts(${scope.kind},${scope.id}::uuid)`);
  const parsed = countsSchema.safeParse(result.rows[0]);
  if (!parsed.success || result.rows.length !== 1) throw new AppError('INVALID_STATE');
  return parsed.data;
}
const target = (scope: Scope) => and(eq(recordPurgeJobs.recordKind,scope.kind),eq(recordPurgeJobs.recordId,scope.id),eq(recordPurgeJobs.snapshotSha256,scope.snapshot));
async function cursor(tx: Tx, scope: Scope, kindOfPage: Cursor['kindOfPage']): Promise<Cursor> {
  const [job] = await tx.select({ afterRun: recordPurgeJobs.afterRun, afterChild: recordPurgeJobs.afterChild })
    .from(recordPurgeJobs).where(target(scope));
  if (!job) throw new AppError('NOT_FOUND');
  return { ...scope, kindOfPage, after: kindOfPage === 'run' ? job.afterRun : job.afterChild };
}
async function advance(tx: Tx, current: Cursor, next: string | null) {
  await sameSnapshot(tx,current);
  const field = current.kindOfPage === 'run' ? recordPurgeJobs.afterRun : recordPurgeJobs.afterChild;
  const changed = await tx.update(recordPurgeJobs)
    .set(current.kindOfPage === 'run' ? { afterRun: next } : { afterChild: next })
    .where(and(target(current),sql`${field} is not distinct from ${current.after}::uuid`))
    .returning({ id: recordPurgeJobs.recordId });
  if (changed.length !== 1) return false;
  current.after=next; return true;
}
export async function confirmRecordWorkPurgeInTx(tx: Tx, context: TenantContext, input: { kind: RecordPurgeKind; id: string }) {
  service(context);
  const scope = await snapshot(tx,{ kind: kindSchema.parse(input.kind),id: idSchema.parse(input.id) });
  const actual = await counts(tx,scope);
  const proof = await tx.execute<{ confirmed: boolean }>(sql`select ai.record_work_purge_confirmed(${scope.kind},${scope.id}::uuid) confirmed`);
  return { removed: actual.removed,remaining: actual.remaining,unproven: actual.unproven,
    controlsRemaining: actual.controlsRemaining,confirmed: proof.rows[0]?.confirmed === true };
}

export function createDelegatedRecordPurge(deps: {
  database: AppDatabase;
  transcripts: RunTranscriptPurge;
  accounting: { reconcileRun(context: TenantContext,runId: string): Promise<void> };
}): DelegatedRecordPurge {
  if (typeof deps.transcripts?.fenceUsing !== 'function' || typeof deps.transcripts?.purgeUsing !== 'function'
    || typeof deps.accounting?.reconcileRun !== 'function') throw new AppError('CAPABILITY_UNAVAILABLE');
  const fence = deps.transcripts.fenceUsing;
  return {
    confirmRecordInTx: confirmRecordWorkPurgeInTx,
    async purgeRecord(context,input) {
      service(context);
      const record = { kind: kindSchema.parse(input.kind),id: idSchema.parse(input.id) };
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new AppError('INVALID_INPUT');
      const scope = await withTenantTx(deps.database,context,async tx => {
        const native = await tx.execute<{ allowed: boolean }>(sql`select current_user='ensemus_agent' and session_user='ensemus_agent' allowed`);
        if (native.rows[0]?.allowed !== true) throw new AppError('FORBIDDEN');
        const actual = await snapshot(tx,record);
        await tx.insert(recordPurgeJobs).values({ organizationId: context.organizationId,
          recordKind: actual.kind,recordId: actual.id,snapshotSha256: actual.snapshot }).onConflictDoNothing();
        // A later consumer/hold reopens verification, not historical observations or body rights.
        // Clear only the mutable progress attestation before any cursor mutation; real disposition
        // receipts and prior terminal closures remain immutable and are rechecked in the anti-join.
        await tx.update(recordPurgeJobs).set({ checkedAt: null,receiptsSha256: null }).where(target(actual));
        return actual;
      });
      const controls = await withTenantTx(deps.database,context,async tx => {
        await sameSnapshot(tx,scope);
        const page = await cursor(tx,scope,'run');
        const rows = await tx.execute<{ id: string }>(sql`select actual.run_id id from ai.record_input_runs(${scope.kind},${scope.id}::uuid) actual(run_id)
          left join ai.agent_runs run on run.organization_id=${context.organizationId}::uuid and run.id=actual.run_id
          left join ai.run_input_checkpoints checkpoint on checkpoint.organization_id=${context.organizationId}::uuid and checkpoint.run_id=actual.run_id
          where (${page.after}::uuid is null or actual.run_id>${page.after}::uuid) and(run.id is null or checkpoint.run_id is null or checkpoint.fenced_at is null
            or checkpoint.payloads_purged_at is null or checkpoint.purged_fence_generation is distinct from checkpoint.fence_generation
            or checkpoint.purged_restore_generation is distinct from ai.current_material_restore_generation()
            or run.status not in('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')
            or not exists(select 1 from ai.record_run_closures closure where closure.organization_id=${context.organizationId}::uuid
              and closure.record_kind=${scope.kind} and closure.record_id=${scope.id}::uuid and closure.snapshot_sha256=${scope.snapshot}
              and closure.restore_generation=ai.current_material_restore_generation()
              and closure.run_id=actual.run_id and closure.fence_generation=checkpoint.fence_generation and closure.terminal_version<=run.version))
          order by actual.run_id limit ${input.limit}`);
        if (!rows.rows.length && page.after !== null) await advance(tx,page,null);
        return { page, rows: rows.rows };
      });
      for (const row of controls.rows) {
        try {
          await withTenantTx(deps.database,context,async tx => {
            await sameSnapshot(tx,scope);
            const query = { runIds: [row.id] };
            if (!(await fence(tx,context,query)).fenced) throw new AppError('INVALID_STATE');
          });
          // The fence has committed before deletion. A failed/unknown purge cannot roll it back
          // or allow an in-flight older worker to materialize another private result.
          await withTenantTx(deps.database,context,async tx => {
            await sameSnapshot(tx,scope);
            const query = { runIds: [row.id] };
            const erased = await deps.transcripts.purgeUsing(tx,context,query);
            if (erased.remaining !== 0 || !(await fence(tx,context,query)).fenced) throw new AppError('INVALID_STATE');
          });
          await closeRunWithoutContext(deps.database,{ organizationId: context.organizationId,agentRunId: row.id,status: 'cancelled',stopCode: 'POLICY_DENIED' });
          await deps.accounting.reconcileRun(context,row.id);
          await withTenantTx(deps.database,context,async tx => {
            await sameSnapshot(tx,scope);
            const [run] = await tx.select({ version: agentRuns.version,status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id,row.id));
            const [checkpoint] = await tx.select({ generation: runInputCheckpoints.fenceGeneration }).from(runInputCheckpoints).where(eq(runInputCheckpoints.runId,row.id));
            if (!run || !checkpoint) throw new AppError('INVALID_STATE');
            await tx.insert(recordRunClosures).values({ organizationId: context.organizationId,recordKind: scope.kind,recordId: scope.id,
              snapshotSha256: scope.snapshot,runId: row.id,terminalVersion: run.version,terminalStatus: run.status,fenceGeneration: checkpoint.generation }).onConflictDoNothing();
          });
        } catch {
          // Unknown/held/failed evidence stays in the exact anti-join. No aborted transaction reuse,
          // paid retry, synthetic settlement or object quiescence is inferred from this control path.
        }
        if (!(await withTenantTx(deps.database,context,tx => advance(tx,controls.page,row.id)))) break;
      }
      const work = await withTenantTx(deps.database,context,async tx => {
        await sameSnapshot(tx,scope);
        const actual = await counts(tx,scope),page = await cursor(tx,scope,'child');
        if (actual.controlsRemaining !== 0) return { page,rows: [] };
        const rows = await tx.execute<{ id: string; workUnitId: string }>(sql`select receipt.child_run_id id,receipt.child_work_unit_id "workUnitId"
          from ai.delegated_input_receipts receipt where receipt.organization_id=${context.organizationId}::uuid
            and (${page.after}::uuid is null or receipt.child_run_id>${page.after}::uuid) and not ai.delegated_body_disposed(receipt.child_run_id)
            and ai.delegated_record_ref(receipt.child_run_id,${scope.kind},${scope.id}::uuid) order by receipt.child_run_id limit ${input.limit}`);
        if (!rows.rows.length && page.after !== null) await advance(tx,page,null);
        return { page,rows: rows.rows };
      });
      for (const row of work.rows) {
        try {
          await withTenantTx(deps.database,context,async tx => {
            await sameSnapshot(tx,scope);
            await redactDelegatedWorkInTx(tx,context,{ childRunId: row.id,workUnitId: row.workUnitId,scopeKind: scope.kind,scopeId: scope.id,purgeJobId: null });
          });
        } catch {
          // The mandatory0510 guard is the authority, including current holds and exact original refs.
        }
        if (!(await withTenantTx(deps.database,context,tx => advance(tx,work.page,row.id)))) break;
      }
      return withTenantTx(deps.database,context,async tx => {
        await sameSnapshot(tx,scope);
        const actual = await counts(tx,scope);
        const available = await tx.execute<{ available: boolean }>(sql`select to_regprocedure('lifecycle.record_purge_hold_free(text,uuid,text)') is not null available`);
        const holdFree = available.rows[0]?.available === true && (await tx.execute<{ allowed: boolean }>(
          sql`select lifecycle.record_purge_hold_free(${scope.kind},${scope.id}::uuid,${scope.snapshot}) allowed`,
        )).rows[0]?.allowed === true;
        const confirmed = holdFree && actual.remaining === 0 && actual.controlsRemaining === 0 && actual.unproven === 0;
        await tx.update(recordPurgeJobs).set({ workRemoved: actual.removed,workRemaining: actual.remaining,unknownWork: actual.unproven,
          controlsRemaining: actual.controlsRemaining,checkedAt: confirmed ? new Date() : null,receiptsSha256: confirmed ? actual.receiptsSha256 : null }).where(target(scope));
        return confirmRecordWorkPurgeInTx(tx,context,scope);
      });
    },
  };
}
