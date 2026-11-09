// Fixed native app-service operation. SQL owns the actual admission, current holds/restore
// generations and exhaustive material proof. No UUID, caller boolean or GUC is proof by itself.
import { tombstones, type TenantContext, type Tx } from '@ensemus/database';
import { isRecordPurgeKind } from '@ensemus/domain/knowledge-events';
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
 * tombstone read barrier) ends the page early with `more`, keeping what this transaction already did.
 */
export async function closeDelegatedRecordInputsInTx(
  tx: Tx,
  context: TenantContext,
  input: { offboardingId: string },
): Promise<{ closed: number; more: boolean }> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const parsed = idSchema.safeParse(input.offboardingId);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const { row, finished } = await assertErasureAdmittedInTx(tx, context, parsed.data);
  // Erasing refuses new tombstones (0533); a finished erasure has nothing left to close.
  if (finished || row.state !== 'ready_for_erasure') return { closed: 0, more: false };
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
      if (pgCode(error) === '55P03') return { closed, more: true };
      throw error;
    }
    await emitRecordClosedInTx(tx, context, { kind, id: record.id });
    closed += 1;
  }
  return { closed, more: open.rows.length === DELEGATED_INPUT_CLOSURE_PAGE };
}
