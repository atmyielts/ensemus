// Scripted contributor ports exercise composition, not PostgreSQL/storage/lifecycle authority.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, Tx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  createKnowledgeArtifactPurge,
  type KnowledgeArtifactPurgePorts,
} from './purge-composition';
import type { StructuredRecordPurge } from './artifact-provenance';
import { AppError } from '../errors';

type Result = Awaited<ReturnType<StructuredRecordPurge['purgeSource']>>;
type RecordKind = Parameters<StructuredRecordPurge['purgeRecord']>[1]['kind'];
const context = createServiceContext(randomUUID()),
  sourceId = randomUUID();
const tx = {} as Tx;
function port(
  name: string,
  events: string[],
  initial: Result = { removed: 0, remaining: 0, held: 0, confirmed: true },
) {
  let next: unknown = initial;
  return {
    set(value: unknown) {
      next = value;
    },
    purgeSource: vi.fn(
      async (
        _context: TenantContext,
        _input: { sourceId: string; limit: number },
      ): Promise<Result> => {
        events.push(`${name}.source`);
        return next as Result;
      },
    ),
    confirmInTx: vi.fn(async (_tx: Tx, _context: TenantContext, _input: { sourceId: string }) => {
      events.push(`${name}.confirm`);
      return { remaining: (next as Result).remaining };
    }),
    purgeRecord: vi.fn(
      async (
        _context: TenantContext,
        _input: { kind: RecordKind; id: string; limit: number },
      ): Promise<Result> => {
        events.push(`${name}.record`);
        return next as Result;
      },
    ),
    confirmRecordInTx: vi.fn(
      async (_tx: Tx, _context: TenantContext, _input: { kind: RecordKind; id: string }) => {
        events.push(`${name}.record-confirm`);
        return { remaining: (next as Result).remaining };
      },
    ),
  };
}
function fixture() {
  const events: string[] = [],
    derived = port('derived', events),
    archive = port('archive', events);
  return { events, derived, archive, combined: createKnowledgeArtifactPurge({ derived, archive }) };
}
describe('required generated and archive purge composition', () => {
  it('sums distinct durable cumulative counters and confirms only both actual completions', async () => {
    const f = fixture();
    f.derived.set({ removed: 7, remaining: 0, held: 0, confirmed: true });
    f.archive.set({ removed: 3, remaining: 0, held: 0, confirmed: true });
    const input = { sourceId, limit: 25 };
    expect(await f.combined.purgeSource(context, input)).toEqual({
      removed: 10,
      remaining: 0,
      held: 0,
      confirmed: true,
    });
    expect(f.events).toEqual(['derived.source', 'archive.source']);
    expect(f.derived.purgeSource).toHaveBeenCalledWith(context, input);
    expect(f.archive.purgeSource).toHaveBeenCalledWith(context, input);
    expect(await f.combined.purgeSource(context, input)).toMatchObject({ removed: 10 });
  });
  it('gives the second category progress when the first is held or partially complete', async () => {
    const f = fixture();
    f.derived.set({ removed: 2, remaining: 3, held: 1, confirmed: false });
    f.archive.set({ removed: 5, remaining: 0, held: 0, confirmed: true });
    expect(await f.combined.purgeSource(context, { sourceId, limit: 25 })).toEqual({
      removed: 7,
      remaining: 3,
      held: 1,
      confirmed: false,
    });
    expect(f.archive.purgeSource).toHaveBeenCalledOnce();
  });
  it('never turns an unbound lifecycle false result into an empty confirmed success', async () => {
    const f = fixture();
    f.archive.set({ removed: 0, remaining: 0, held: 0, confirmed: false });
    expect(await f.combined.purgeSource(context, { sourceId, limit: 25 })).toMatchObject({
      remaining: 0,
      confirmed: false,
    });
  });
  it('bounds each category at25, at most50 selected headers per attempt', async () => {
    const f = fixture();
    await f.combined.purgeSource(context, { sourceId, limit: 100 });
    expect(f.derived.purgeSource).toHaveBeenCalledWith(context, { sourceId, limit: 25 });
    expect(f.archive.purgeSource).toHaveBeenCalledWith(context, { sourceId, limit: 25 });
  });
  it('keeps small caller bounds for both independent categories', async () => {
    const f = fixture();
    await f.combined.purgeSource(context, { sourceId, limit: 1 });
    expect(f.derived.purgeSource).toHaveBeenCalledWith(context, { sourceId, limit: 1 });
    expect(f.archive.purgeSource).toHaveBeenCalledWith(context, { sourceId, limit: 1 });
  });
  it.each([0, -1, 0.5, 101, NaN, Infinity])(
    'refuses invalid limit %s before either contributor',
    async (limit) => {
      const f = fixture();
      await expect(f.combined.purgeSource(context, { sourceId, limit })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(f.events).toEqual([]);
    },
  );
  it('executes contributors sequentially without starving the second', async () => {
    const f = fixture();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.derived.purgeSource.mockImplementation(async () => {
      await held;
      return { removed: 1, remaining: 0, held: 0, confirmed: true };
    });
    const running = f.combined.purgeSource(context, { sourceId, limit: 25 });
    expect(f.derived.purgeSource).toHaveBeenCalledOnce();
    expect(f.archive.purgeSource).not.toHaveBeenCalled();
    release();
    await running;
    expect(f.archive.purgeSource).toHaveBeenCalledOnce();
  });
  it.each(['derived', 'archive'] as const)(
    'retains independent progress and refuses when %s fails',
    async (selected) => {
      const f = fixture(),
        secret = 'GENERATED private error text';
      f[selected].purgeSource.mockRejectedValue(new Error(secret));
      await expect(f.combined.purgeSource(context, { sourceId, limit: 25 })).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
      expect(f.derived.purgeSource).toHaveBeenCalledOnce();
      expect(f.archive.purgeSource).toHaveBeenCalledOnce();
      await expect(f.combined.purgeSource(context, { sourceId, limit: 25 })).rejects.not.toThrow(
        secret,
      );
    },
  );
  it.each([
    null,
    {},
    { removed: -1, remaining: 0, held: 0, confirmed: true },
    { removed: NaN, remaining: 0, held: 0, confirmed: true },
    { removed: Infinity, remaining: 0, held: 0, confirmed: true },
    { removed: 0.5, remaining: 0, held: 0, confirmed: true },
    { removed: Number.MAX_SAFE_INTEGER + 1, remaining: 0, held: 0, confirmed: true },
    { removed: 0, remaining: -1, held: 0, confirmed: false },
    { removed: 0, remaining: 1, held: 2, confirmed: false },
    { removed: 0, remaining: 0, held: 0, confirmed: 'yes' },
    { removed: 0, remaining: 1, held: 0, confirmed: true },
  ])('refuses malformed contributor proof %#', async (invalid) => {
    const f = fixture();
    f.derived.set(invalid);
    await expect(f.combined.purgeSource(context, { sourceId, limit: 25 })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(f.archive.purgeSource).toHaveBeenCalledOnce();
  });
  it('refuses aggregate integer overflow rather than rounding a durable count', async () => {
    const f = fixture();
    f.derived.set({ removed: Number.MAX_SAFE_INTEGER, remaining: 0, held: 0, confirmed: true });
    f.archive.set({ removed: 1, remaining: 0, held: 0, confirmed: true });
    await expect(f.combined.purgeSource(context, { sourceId, limit: 25 })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
  it('rechecks both final inventories through the exact caller-held transaction', async () => {
    const f = fixture(),
      input = { sourceId };
    f.derived.set({ removed: 0, remaining: 2, held: 0, confirmed: false });
    f.archive.set({ removed: 0, remaining: 3, held: 0, confirmed: false });
    expect(await f.combined.confirmInTx(tx, context, input)).toEqual({ remaining: 5 });
    expect(f.derived.confirmInTx).toHaveBeenCalledWith(tx, context, input);
    expect(f.archive.confirmInTx).toHaveBeenCalledWith(tx, context, input);
    expect(f.events).toEqual(['derived.confirm', 'archive.confirm']);
  });
  it('never queries another port after the first SQL confirmation aborts', async () => {
    const f = fixture(),
      abort = new Error('GENERATED_SQL_ABORT');
    f.derived.confirmInTx.mockRejectedValue(abort);
    await expect(f.combined.confirmInTx(tx, context, { sourceId })).rejects.toBe(abort);
    expect(f.archive.confirmInTx).not.toHaveBeenCalled();
  });
  it('refuses a missing final counter instead of treating it as zero', async () => {
    const f = fixture();
    f.archive.confirmInTx.mockResolvedValue({} as { remaining: number });
    await expect(f.combined.confirmInTx(tx, context, { sourceId })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
  it('combines supported structured records with the same bounded/final protocol', async () => {
    const f = fixture(),
      input = { kind: 'client' as const, id: randomUUID(), limit: 100 };
    f.archive.set({ removed: 3, remaining: 1, held: 1, confirmed: false });
    expect(await f.combined.purgeRecord(context, input)).toEqual({
      removed: 3,
      remaining: 1,
      held: 1,
      confirmed: false,
    });
    expect(f.derived.purgeRecord).toHaveBeenCalledWith(context, { ...input, limit: 25 });
    expect(f.archive.purgeRecord).toHaveBeenCalledWith(context, { ...input, limit: 25 });
    const selected = { kind: input.kind, id: input.id };
    expect(await f.combined.confirmRecordInTx(tx, context, selected)).toEqual({ remaining: 1 });
    expect(f.derived.confirmRecordInTx).toHaveBeenCalledWith(tx, context, selected);
    expect(f.archive.confirmRecordInTx).toHaveBeenCalledWith(tx, context, selected);
  });
  // A deleted custom object record starts the typed-record purge (RECORD_PURGE_KINDS, ADR-028 item 8a).
  // Refusing it here kept it a sweep candidate that never completed, re-proved on every pass.
  it('proves a custom object record under its own kind through both contributors', async () => {
    const f = fixture(),
      input = { kind: 'object_record' as const, id: randomUUID(), limit: 100 };
    f.derived.set({ removed: 1, remaining: 0, held: 0, confirmed: true });
    expect(await f.combined.purgeRecord(context, input)).toEqual({
      removed: 1,
      remaining: 0,
      held: 0,
      confirmed: true,
    });
    // Never cast into a Work, project or client kind.
    expect(f.derived.purgeRecord).toHaveBeenCalledWith(context, { ...input, limit: 25 });
    expect(f.archive.purgeRecord).toHaveBeenCalledWith(context, { ...input, limit: 25 });
    const selected = { kind: input.kind, id: input.id };
    expect(await f.combined.confirmRecordInTx(tx, context, selected)).toEqual({ remaining: 0 });
    expect(f.derived.confirmRecordInTx).toHaveBeenCalledWith(tx, context, selected);
    expect(f.archive.confirmRecordInTx).toHaveBeenCalledWith(tx, context, selected);
    expect(f.events).toEqual([
      'derived.record',
      'archive.record',
      'derived.record-confirm',
      'archive.record-confirm',
    ]);
  });
  it('never certifies a custom object record from archive cleanup alone', async () => {
    const f = fixture(),
      input = { kind: 'object_record' as const, id: randomUUID(), limit: 25 },
      selected = { kind: input.kind, id: input.id };
    // A generated file still depends on the record: the archive's zero does not complete it.
    f.derived.set({ removed: 0, remaining: 1, held: 0, confirmed: false });
    expect(await f.combined.purgeRecord(context, input)).toMatchObject({
      remaining: 1,
      confirmed: false,
    });
    expect(await f.combined.confirmRecordInTx(tx, context, selected)).toEqual({ remaining: 1 });
    // A generated proof that fails is never replaced by the archive's result.
    f.derived.purgeRecord.mockRejectedValue(new Error('GENERATED_LINEAGE_UNAVAILABLE'));
    await expect(f.combined.purgeRecord(context, input)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    const abort = new AppError('INVALID_STATE');
    f.derived.confirmRecordInTx.mockRejectedValue(abort);
    f.archive.confirmRecordInTx.mockClear();
    await expect(f.combined.confirmRecordInTx(tx, context, selected)).rejects.toBe(abort);
    expect(f.archive.confirmRecordInTx).not.toHaveBeenCalled();
  });
  it.each(['artifact', 'knowledge_source', 'custom_object_record', '', undefined])(
    'refuses record kind %s before either contributor runs',
    async (kind) => {
      const f = fixture(),
        id = randomUUID(),
        input = { kind, id, limit: 25 } as unknown as Parameters<
          StructuredRecordPurge['purgeRecord']
        >[1];
      await expect(f.combined.purgeRecord(context, input)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(
        f.combined.confirmRecordInTx(tx, context, { kind: input.kind, id }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(f.events).toEqual([]);
    },
  );
  it('requires both complete port objects at construction', () => {
    const f = fixture();
    expect(() =>
      createKnowledgeArtifactPurge({
        derived: f.derived,
      } as unknown as KnowledgeArtifactPurgePorts),
    ).toThrow();
    expect(() =>
      createKnowledgeArtifactPurge({
        archive: f.archive,
      } as unknown as KnowledgeArtifactPurgePorts),
    ).toThrow();
  });
  it('refuses a person before either worker capability runs', async () => {
    const f = fixture(),
      person = { ...context, actorType: 'user' as const };
    await expect(f.combined.purgeSource(person, { sourceId, limit: 25 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.events).toEqual([]);
  });
});
