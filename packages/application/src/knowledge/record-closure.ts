// ADR-028 open question 12, lifecycle item 8a: the typed-record deletion outbox.
//
// RULE: every code path that deletes or tombstones a Work Unit, project, client or custom object record
// calls emitRecordClosedInTx in the same transaction as the delete. That event is how the dispatcher
// starts knowledgeRecordPurgeWorkflow, which removes what a delegated child copied from the record.
// Today's producers: deleteObjectRecord, recordImportedTombstone and the offboarding input closure
// (closeDelegatedRecordInputsInTx). The event is the low-latency path only. Completeness comes from the
// tenant's knowledge sweep (listRecordPurgeCandidates, then the canonical PostgreSQL purge proof), which
// also reaches a tombstone written by SQL or by any path that forgot the event. A forged event is inert:
// the record purge refuses a live record (ai.lock_record_purge_snapshot returns NULL for it).
import { withTenantTx, type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import {
  isRecordPurgeKind,
  KNOWLEDGE_RECORD_CLOSED,
  RECORD_PURGE_KINDS,
  type RecordPurgeKind,
} from '@ensemus/domain/knowledge-events';
import { sql } from 'drizzle-orm';
import { AppError, LOCK_NOT_AVAILABLE, pgCode } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';

function recordOf(input: { kind: unknown; id: unknown }): { kind: RecordPurgeKind; id: string } {
  if (!isRecordPurgeKind(input.kind)) throw new AppError('INVALID_INPUT');
  const id = idSchema.safeParse(input.id);
  if (!id.success) throw new AppError('INVALID_INPUT');
  return { kind: input.kind, id: id.data };
}

/**
 * Writes `knowledge.record_closed` (and its outbox row) once per closure of a record. The payload is the
 * two IDs and nothing else, so the event is classified restricted and leaks no record class. Returns
 * whether it was written now: false means this closure already wrote it.
 *
 * "This closure" is the record's tombstone: an event counts as already written only if it is at least as
 * new as the tombstone. ensemus_app can write a domain event for a live record (a forged or early event,
 * which the purge ignores because a live record has no purge snapshot), and such an event must not
 * suppress the genuine one when the record really closes later. This relies on a tombstone never being
 * dated after the transaction that wrote it (its created_at defaults to now(), and recordImportedTombstone
 * clamps an archive's deletion time to now()): one dated in the future would make every emit look older
 * than its closure, and write again each time. A record with no tombstone has no
 * closure time, so any earlier event counts. A transaction-scoped advisory lock per record serializes the
 * check and the insert, so two concurrent closures write one event.
 */
export async function emitRecordClosedInTx(
  tx: Tx,
  context: TenantContext,
  input: { kind: RecordPurgeKind; id: string },
): Promise<boolean> {
  const record = recordOf(input);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge.record_closed:${context.organizationId}:${record.kind}:${record.id}`},0))`,
  );
  const prior = await tx.execute<{ written: number; current: boolean }>(sql`
    select count(*)::integer written,
      coalesce(bool_or(event.occurred_at>=coalesce((select tombstone.created_at from platform.tombstones tombstone
        where tombstone.organization_id=event.organization_id and tombstone.target_type=${record.kind}
          and tombstone.target_id=${record.id}::uuid),'-infinity'::timestamptz)),false) current
      from platform.domain_events event
     where event.organization_id=${context.organizationId}::uuid
       and event.event_type=${KNOWLEDGE_RECORD_CLOSED}
       and event.aggregate_type=${record.kind} and event.aggregate_id=${record.id}::uuid`);
  const row = prior.rows[0];
  if (row?.current === true) return false;
  await emit(tx, context, {
    eventType: KNOWLEDGE_RECORD_CLOSED,
    aggregateType: record.kind,
    aggregateId: record.id,
    aggregateVersion: Number(row?.written ?? 0) + 1,
    classification: 'restricted',
    payload: { record_kind: record.kind, record_id: record.id },
  });
  return true;
}

/** SQLSTATEs with which 0554's attestation, or a lock it needs, says "not completed (yet)". */
const COMPLETION_NOT_PROVEN = new Set(['EN119', LOCK_NOT_AVAILABLE]);

/**
 * Records that one record's purge is complete, so the sweep stops proving it (ADR-028 item 8a, 0554).
 * Call it in the transaction whose composite proof (copied Work, then generated and archive files) just
 * read completed, after that proof. It passes no value: 0419's guard, as rewritten by 0554, re-runs
 * PostgreSQL's composite proof under the same locks and writes the completion for the record's current
 * snapshot and restore generation, or raises EN119 and writes nothing. It runs in a savepoint, so a proof
 * that does not hold (or a busy lock) rolls back only the attempt: the caller's transaction and result
 * stand, and the record simply stays a sweep candidate. Returns whether a completion was written; any
 * other error is a fault and is thrown.
 */
export async function recordRecordPurgeCompletionInTx(
  tx: Tx,
  context: TenantContext,
  input: { kind: RecordPurgeKind; id: string },
): Promise<boolean> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const record = recordOf(input);
  try {
    return await tx.transaction(async (attempt) => {
      const result = await attempt.execute<{ recorded: boolean }>(sql`
        with current_snapshot as (select ai.lock_record_purge_snapshot(${record.kind},${record.id}::uuid) snapshot)
        update ai.record_purge_jobs job set completed_restore_generation=ai.current_material_restore_generation()
          from current_snapshot
         where job.organization_id=${context.organizationId}::uuid and job.record_kind=${record.kind}
           and job.record_id=${record.id}::uuid and job.snapshot_sha256=current_snapshot.snapshot
        returning job.completed_restore_generation is not null recorded`);
      return result.rows.length === 1 && result.rows[0]?.recorded === true;
    });
  } catch (error) {
    const code = pgCode(error) ?? (error as { code?: unknown })?.code;
    if (typeof code === 'string' && COMPLETION_NOT_PROVEN.has(code)) return false;
    throw error;
  }
}

export type RecordPurgeCandidate = {
  kind: RecordPurgeKind;
  id: string;
  /** A purge pass already proved this record at the tenant's current restore generation. */
  checked: boolean;
};

/**
 * Dead or tombstoned typed records of one tenant, the ones a purge pass has not yet proved at the current
 * restore generation first, then the longest untouched. Metadata only. The order only ranks what the
 * sweep re-proves next; it is never itself a proof that anything is purged.
 *
 * A record with a current completion (0554 `ai.record_purge_completed`: its job for the record's current
 * snapshot was attested completed, by PostgreSQL's composite proof, at the current restore generation)
 * is not listed, so the sweep does not prove it again and takes no organization row lock for it. A new
 * restore generation, a changed snapshot or an agent purge pass reopens it.
 */
export async function listRecordPurgeCandidates(
  database: AppDatabase,
  context: TenantContext,
  input: { limit: number },
): Promise<readonly RecordPurgeCandidate[]> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)
    throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    const kinds = sql.join(
      RECORD_PURGE_KINDS.map((kind) => sql`${kind}`),
      sql`,`,
    );
    const result = await tx.execute<{ kind: string; id: string; checked: boolean }>(sql`
      with current_generation as (select ai.current_material_restore_generation() generation)
      select catalog.record_kind kind,catalog.record_id id,
        coalesce(bool_or(job.checked_at is not null
          and job.restore_generation is not distinct from (select generation from current_generation)),false) checked
      from knowledge.structured_record_catalog catalog
      left join ai.record_purge_jobs job on job.organization_id=catalog.organization_id
        and job.record_kind=catalog.record_kind and job.record_id=catalog.record_id
      where catalog.organization_id=${context.organizationId}::uuid and catalog.record_kind in (${kinds})
        and (not catalog.alive or exists(select 1 from platform.tombstones tombstone
          where tombstone.organization_id=catalog.organization_id and tombstone.target_type=catalog.record_kind
            and tombstone.target_id=catalog.record_id))
        and not ai.record_purge_completed(catalog.record_kind,catalog.record_id,
          (select generation from current_generation))
      group by catalog.record_kind,catalog.record_id
      order by 3,max(job.updated_at) nulls first,catalog.record_kind,catalog.record_id
      limit ${input.limit}`);
    return result.rows.flatMap((row) =>
      isRecordPurgeKind(row.kind) && idSchema.safeParse(row.id).success
        ? [{ kind: row.kind, id: row.id, checked: row.checked === true }]
        : [],
    );
  });
}
