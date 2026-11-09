// Fixed native app-service operation. SQL owns the actual admission, current holds/restore
// generations and exhaustive material proof. No UUID, caller boolean or GUC is proof by itself.
import { tombstones, type TenantContext, type Tx } from '@ensemus/database';
import { isRecordPurgeKind, type RecordPurgeKind } from '@ensemus/domain/knowledge-events';
import { sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { idSchema } from '../ids';
import { assertErasureAdmittedInTx } from '../saas/offboarding';
import { emitRecordClosedInTx } from './record-closure';

export async function sealDelegatedErasureInTx(
  tx: Tx,
  context: TenantContext,
  input: { offboardingId: string },
): Promise<boolean> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const parsed = idSchema.safeParse(input.offboardingId);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const offboardingId = parsed.data;
  const capability = await tx.execute<{ available: boolean }>(
    sql`select to_regprocedure('lifecycle.seal_delegated_erasure(uuid)') is not null available`,
  );
  if (capability.rows[0]?.available !== true) return false;
  const result = await tx.execute<{ sealed: boolean }>(
    sql`select case when app.current_organization_id()=${context.organizationId}::uuid
      then lifecycle.seal_delegated_erasure(${offboardingId}::uuid) else false end sealed`,
  );
  return result.rows[0]?.sealed === true;
}

/** One page of the closure below. The operator command loops pages, one transaction each. */
export const DELEGATED_INPUT_CLOSURE_PAGE = 100;

/**
 * ADR-028 lifecycle item 8b. 0515's lifecycle.current_delegated_material_proof seals a tenant only when
 * every delegated child receipt is redacted, and redaction needs a closed scope. Offboarding tombstones
 * only artifacts, and 0533 refuses every platform insert (tombstones included) once the offboarding is
 * erasing. So, after the admission beginErasure itself checks and strictly before erasing, this
 * tombstones every Work Unit, project, client and custom object record that an unredacted receipt names
 * (the parent's Work included) and writes knowledge.record_closed for each, which starts its
 * typed-record purge. Metadata only: no body is read. Idempotent: a record already tombstoned is not
 * listed again, and the event is written once per record. A busy record lock (55P03 from the 0419
 * tombstone read barrier) ends the page early with `more` and `busy`, keeping what this transaction
 * already did; a full page without contention is `more` alone, so the caller can tell the two apart.
 *
 * This is irreversible, and it runs before the move to `erasing`: once it has tombstoned anything,
 * `cancelOffboarding` refuses (OFFBOARDING_NOT_CANCELLABLE), so a stop at this point (a hold placed
 * afterwards, a crash, a busy lock) leaves the tenant waiting for erasure, never back in service with
 * permanently tombstoned records.
 */
export async function closeDelegatedRecordInputsInTx(
  tx: Tx,
  context: TenantContext,
  input: { offboardingId: string },
): Promise<{ closed: number; more: boolean; busy: boolean }> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const parsed = idSchema.safeParse(input.offboardingId);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const { row, finished } = await assertErasureAdmittedInTx(tx, context, parsed.data);
  // Erasing refuses new tombstones (0533); a finished erasure has nothing left to close.
  if (finished || row.state !== 'ready_for_erasure') return { closed: 0, more: false, busy: false };
  const open = await tx.execute<{ kind: string; id: string }>(sql`
    select distinct ref.ref_kind kind,ref.ref_id id
      from ai.delegated_input_refs ref
      join ai.delegated_input_receipts receipt
        on receipt.organization_id=ref.organization_id and receipt.child_run_id=ref.child_run_id
     where ref.organization_id=${context.organizationId}::uuid
       and receipt.redacted_at is null
       and ref.ref_kind in ('work_unit','project','client','object_record')
       and not exists(select 1 from platform.tombstones tombstone
         where tombstone.organization_id=ref.organization_id and tombstone.target_type=ref.ref_kind
           and tombstone.target_id=ref.ref_id)
     order by 1,2
     limit ${DELEGATED_INPUT_CLOSURE_PAGE}`);
  let closed = 0;
  for (const record of open.rows) {
    if (!isRecordPurgeKind(record.kind)) throw new AppError('PREREQUISITES_INCOMPLETE');
    const kind = record.kind;
    try {
      // A savepoint, so a busy record lock leaves this transaction usable for what it already closed.
      await tx.transaction((savepoint) =>
        savepoint
          .insert(tombstones)
          .values({
            organizationId: context.organizationId,
            targetType: kind,
            targetId: record.id,
            reasonCode: 'TENANT_ERASURE',
          })
          .onConflictDoNothing(),
      );
    } catch (error) {
      if (pgCode(error) === '55P03') return { closed, more: true, busy: true };
      throw error;
    }
    await emitRecordClosedInTx(tx, context, { kind, id: record.id });
    closed += 1;
  }
  return { closed, more: open.rows.length === DELEGATED_INPUT_CLOSURE_PAGE, busy: false };
}

/** At most this many record purges the erase command restarts per run. */
export const DELEGATED_RECORD_RESTART_LIMIT = 100;

/**
 * ADR-028 lifecycle items 8a and 8b. An offboarding tenant has no knowledge sweep (its schedules end before
 * `ready_for_erasure`), so the one-shot `knowledge.record_closed` start is not enough on its own: a pass
 * that hits its page limit, a busy lock, a hold or an outage would never be restarted, and the seal would
 * stay false. The erase command therefore restarts, on every run whose seal is not yet possible, the purge
 * of every closed record an unredacted delegated child receipt still names. Metadata only; it writes
 * nothing (so it is allowed while `erasing`, when 0533 refuses inserts). A record still open is not
 * listed: its purge could prove nothing.
 */
export async function listDelegatedRecordPurgeRestartsInTx(
  tx: Tx,
  context: TenantContext,
  input: { offboardingId: string },
): Promise<readonly { kind: RecordPurgeKind; id: string }[]> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const parsed = idSchema.safeParse(input.offboardingId);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const { finished } = await assertErasureAdmittedInTx(tx, context, parsed.data);
  if (finished) return [];
  const due = await tx.execute<{ kind: string; id: string }>(sql`
    select distinct ref.ref_kind kind,ref.ref_id id
      from ai.delegated_input_refs ref
      join ai.delegated_input_receipts receipt
        on receipt.organization_id=ref.organization_id and receipt.child_run_id=ref.child_run_id
     where ref.organization_id=${context.organizationId}::uuid
       and receipt.redacted_at is null
       and ref.ref_kind in ('work_unit','project','client','object_record')
       and exists(select 1 from platform.tombstones tombstone
         where tombstone.organization_id=ref.organization_id and tombstone.target_type=ref.ref_kind
           and tombstone.target_id=ref.ref_id)
     order by 1,2
     limit ${DELEGATED_RECORD_RESTART_LIMIT}`);
  return due.rows.map((record) => {
    if (!isRecordPurgeKind(record.kind) || !idSchema.safeParse(record.id).success)
      throw new AppError('PREREQUISITES_INCOMPLETE');
    return { kind: record.kind, id: record.id };
  });
}
