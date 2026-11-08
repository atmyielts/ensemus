// SQL protocol doubles only; role/RLS/closure truth is tested separately through real PostgreSQL.
import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { closedRecordPurgeTargets, recordPurgeTargetForEvent, type DispatchableEvent, type RecordPurgeTarget } from './dispatcher';
const event = (): DispatchableEvent => ({ organizationId: randomUUID(), eventId: randomUUID(), eventType: 'knowledge.record_purge_requested', aggregateType: 'work_unit', aggregateId: randomUUID(), occurredAt: new Date(0), attempts: 0 });
function database(rows: RecordPurgeTarget[], admissionError?: unknown) {
  const commands: { sql: string; params: unknown[] }[] = [], dialect = new PgDialect();
  const db = { execute: async (query: SQL) => {
    const command = dialect.sqlToQuery(query); commands.push(command);
    if(command.sql.includes('app.assert_restore_admitted')) { if(admissionError) throw admissionError; return { rows: [] }; }
    return { rows };
  }} as unknown as Parameters<typeof recordPurgeTargetForEvent>[0];
  return { db, commands };
}
describe('record purge dispatcher metadata protocol', () => {
  it('checks the real ready gate before mapping only a persisted event ID', async () => {
    const e = event(), row: RecordPurgeTarget = { organizationId:e.organizationId, kind:'work_unit', id:e.aggregateId }, f = database([row]);
    expect(await recordPurgeTargetForEvent(f.db,e)).toEqual(row);
    expect(f.commands).toHaveLength(2);
    expect(f.commands[0]?.sql).toContain('app.assert_restore_admitted');
    expect(f.commands[1]?.params).toEqual([e.organizationId,e.eventId]);
    expect(f.commands[1]?.sql).toContain('knowledge.record_purge_event_target(');
    expect(f.commands[1]?.sql).not.toMatch(/payload|work\.work_units|objects\.records/);
  });
  it('does not call the mapper for a ledger event or unsupported aggregate', async () => {
    const f = database([]), e = event();
    expect(await recordPurgeTargetForEvent(f.db,{...e,eventType:'tombstone.recorded'})).toBeNull();
    expect(await recordPurgeTargetForEvent(f.db,{...e,aggregateType:'artifact'})).toBeNull();
    expect(f.commands).toEqual([]);
  });
  it('does not turn missing, foreign or mismatched native metadata into a purge target', async () => {
    const e = event();
    expect(await recordPurgeTargetForEvent(database([]).db,e)).toBeNull();
    for(const row of [{ organizationId:randomUUID(),kind:'work_unit' as const,id:e.aggregateId },{ organizationId:e.organizationId,kind:'client' as const,id:e.aggregateId },{ organizationId:e.organizationId,kind:'work_unit' as const,id:randomUUID() }])
      await expect(recordPurgeTargetForEvent(database([row]).db,e)).rejects.toThrow('RECORD_PURGE_METADATA_INVALID');
  });
  it('refuses pending restore before any discovery even when supplied rows look valid', async () => {
    const f = database([],Object.assign(new Error('TEST_PENDING'),{ code:'EN422' }));
    await expect(closedRecordPurgeTargets(f.db,null)).rejects.toMatchObject({code:'RESTORE_PENDING'});
    expect(f.commands).toHaveLength(1);
  });
  it('uses an exact keyset/lookahead and never skips the lookahead record', async () => {
    const organizationId = randomUUID(), rows: RecordPurgeTarget[] = [1,2,3].map((number)=>({organizationId,kind:'client',id:`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`}));
    const f = database(rows), page = await closedRecordPurgeTargets(f.db,null,2);
    expect(page).toEqual({targets:rows.slice(0,2),next:rows[1]});
    expect(f.commands[1]?.params).toEqual([null,null,null,3]);
    const next = database(rows.slice(2));
    expect(await closedRecordPurgeTargets(next.db,page.next,2)).toEqual({targets:[rows[2]],next:null});
    expect(next.commands[1]?.params).toEqual([organizationId,'client',rows[1]!.id,3]);
  });
  it('refuses duplicates/out-of-order or oversized metadata instead of looping a false cursor', async () => {
    const e = event(), row: RecordPurgeTarget = {organizationId:e.organizationId,kind:'work_unit',id:e.aggregateId};
    await expect(closedRecordPurgeTargets(database([row,row]).db,null,2)).rejects.toThrow('RECORD_PURGE_METADATA_INVALID');
    await expect(closedRecordPurgeTargets(database([row,row,row]).db,null,1)).rejects.toThrow('RECORD_PURGE_METADATA_INVALID');
  });
});
