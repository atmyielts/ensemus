// Recording SQL/transport doubles verify orchestration only. Native-role SQL cases are separate;
// none of these doubles is exported or bound into product runtime.
import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { ObjectStore } from '../artifacts';
import {
  createRawKnowledgeObjectPort,
  rawSourceMaterialCompleteInTx,
  withRawKnowledgeObjects,
} from './raw-objects';

vi.mock('@ensemus/database', async (original) => ({
  ...(await original<typeof import('@ensemus/database')>()),
  withTenantTx: (db: { tx: unknown }, _context: unknown, callback: (tx: unknown) => unknown) =>
    callback(db.tx),
}));
const dialect = new PgDialect();
const context = (actorType: 'user' | 'service' = 'service') =>
  ({
    organizationId: randomUUID(),
    actorType,
    membershipId: randomUUID(),
    userId: randomUUID(),
    role: 'owner',
  }) as unknown as TenantContext;
function fixture() {
  const owner = context('user'),
    service = { ...owner, actorType: 'service' } as unknown as TenantContext;
  const write = {
    documentId: randomUUID(),
    writeId: randomUUID(),
    sourceId: randomUUID(),
    generation: 1,
  };
  const body = Buffer.from('generated known raw bytes'),
    key = `${owner.organizationId}/knowledge/${write.documentId}`;
  const admission: Record<
    | 'state'
    | 'source_id'
    | 'object_key'
    | 'content_sha256'
    | 'size_bytes'
    | 'material_generation'
    | 'auth_generation'
    | 'token',
    string
  > = {
    state: 'send',
    source_id: write.sourceId,
    object_key: key,
    content_sha256: createHash('sha256').update(body).digest('hex'),
    size_bytes: String(body.length),
    material_generation: randomUUID(),
    auth_generation: randomUUID(),
    token: 'a'.repeat(64),
  };
  const calls: { sql: string; params: unknown[] }[] = [];
  let admitted = false;
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    calls.push(compiled);
    if (compiled.sql.includes('admit_raw_put')) {
      if (admitted) throw new Error('RAW_WRITE_ALREADY_ADMITTED');
      admitted = true;
      return { rows: [admission] };
    }
    if (compiled.sql.includes('finish_raw_put'))
      return { rows: [{ finished: compiled.params.at(-1) === 'written' }] };
    return { rows: [] };
  });
  const database = { tx: { execute } } as unknown as AppDatabase;
  const putSingleAttempt = vi.fn(async () => ({ transport: 'written' as 'written' | 'unknown' }));
  const ordinaryPut = vi.fn(async () => undefined),
    ordinaryDelete = vi.fn(async () => undefined);
  const store: ObjectStore = {
    put: ordinaryPut,
    delete: ordinaryDelete,
    get: async () => Buffer.from(body),
    exists: async () => true,
    putSingleAttempt,
  };
  return {
    owner,
    service,
    write,
    body,
    key,
    admission,
    calls,
    execute,
    database,
    store,
    putSingleAttempt,
    ordinaryPut,
    ordinaryDelete,
  };
}
describe('native raw object orchestration', () => {
  it('admits first, uses exactly one native PUT, then settles its exact token/generations', async () => {
    const f = fixture(),
      port = createRawKnowledgeObjectPort(f);
    await port.put(f.owner, f.write, f.body, 'text/plain');
    expect(f.putSingleAttempt).toHaveBeenCalledExactlyOnceWith(f.key, f.body, 'text/plain');
    expect(f.ordinaryPut).not.toHaveBeenCalled();
    expect(
      f.calls.map((call) => (call.sql.includes('finish_raw_put') ? 'finish' : 'admit')),
    ).toEqual(['admit', 'finish']);
    expect(f.calls[1]?.params).toEqual([
      f.write.documentId,
      f.write.writeId,
      1,
      f.admission.token,
      f.admission.material_generation,
      f.admission.auth_generation,
      'written',
    ]);
  });
  it('requires the native transport capability before it can consume admission', async () => {
    const f = fixture();
    delete f.store.putSingleAttempt;
    await expect(
      createRawKnowledgeObjectPort(f).put(f.owner, f.write, f.body, 'text/plain'),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.ordinaryPut).not.toHaveBeenCalled();
  });
  it.each([
    'source_id',
    'object_key',
    'content_sha256',
    'size_bytes',
    'material_generation',
    'token',
  ] as const)('does not send against a malformed or mismatched %s admission', async (field) => {
    const f = fixture();
    f.admission[field] = 'invalid';
    await expect(
      createRawKnowledgeObjectPort(f).put(f.owner, f.write, f.body, 'text/plain'),
    ).rejects.toThrow();
    expect(f.putSingleAttempt).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1); // An admitted-but-not-sent row is never silently labelled cancelled.
  });
  it.each(['unknown', 'rejected'] as const)(
    'records %s as UNKNOWN and never retries the admitted native mutation',
    async (mode) => {
      const f = fixture();
      if (mode === 'rejected')
        f.putSingleAttempt.mockRejectedValue(new Error('synthetic dropped response'));
      else f.putSingleAttempt.mockResolvedValue({ transport: 'unknown' });
      const port = createRawKnowledgeObjectPort(f);
      await expect(port.put(f.owner, f.write, f.body, 'text/plain')).rejects.toMatchObject({
        code: 'OBJECT_DELETE_UNCONFIRMED',
      });
      expect(f.calls[1]?.params.at(-1)).toBe('unknown');
      await expect(port.put(f.owner, f.write, f.body, 'text/plain')).rejects.toThrow(
        'RAW_WRITE_ALREADY_ADMITTED',
      );
      expect(f.putSingleAttempt).toHaveBeenCalledTimes(1);
    },
  );
  it('captures mutable bytes and writer identity before the SQL await', async () => {
    const f = fixture(),
      expected = Buffer.from(f.body),
      originalDocument = f.write.documentId;
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (query) => {
      const result = await execute(query);
      if (dialect.sqlToQuery(query).sql.includes('admit_raw_put')) {
        f.body.fill(0);
        f.write.documentId = randomUUID();
      }
      return result;
    });
    await createRawKnowledgeObjectPort(f).put(f.owner, f.write, f.body, 'text/plain');
    expect(f.putSingleAttempt).toHaveBeenCalledExactlyOnceWith(f.key, expected, 'text/plain');
    expect(f.calls[1]?.params[0]).toBe(originalDocument);
  });
  it('does not expose ordinary raw PUT or DELETE while preserving unrelated object methods', async () => {
    const f = fixture(),
      exposed = withRawKnowledgeObjects(f);
    expect(() => exposed.put(f.key, f.body, 'text/plain')).toThrow();
    expect(() => exposed.delete(f.key)).toThrow();
    expect(() => exposed.putSingleAttempt?.(f.key, f.body, 'text/plain')).toThrow();
    await exposed.put('other/artifacts/test', f.body, 'text/plain');
    expect(f.ordinaryPut).toHaveBeenCalledTimes(1);
    expect(f.ordinaryDelete).not.toHaveBeenCalled();
    expect(await exposed.get(f.key)).toEqual(f.body);
  });
  it('returns unconfirmed for a malformed deletion target before admitting any DELETE', async () => {
    const f = fixture();
    f.execute.mockResolvedValue({
      rows: [{ target: { kind: 'raw_source', documentId: f.write.documentId } }],
    } as never);
    await expect(
      createRawKnowledgeObjectPort(f).erase(f.service, { documentId: f.write.documentId }),
    ).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.ordinaryDelete).not.toHaveBeenCalled();
  });
  // 0532: a purge count is evidence. The port records once, before its single admitted DELETE,
  // whether the bytes are there; it never re-observes after that DELETE, which would report bytes
  // this purge removed as already gone.
  function erasable(f: ReturnType<typeof fixture>) {
    const target = {
      kind: 'raw_source',
      sourceId: f.write.sourceId,
      sourceVersion: '2',
      purgeJobId: randomUUID(),
      documentId: f.write.documentId,
      writeId: f.write.writeId,
      generation: 1,
      materialRestoreGeneration: randomUUID(),
      authRestoreGeneration: randomUUID(),
    };
    const claimId = randomUUID(),
      steps: string[] = [];
    let observed: boolean | null = null,
      claim: 'admitted' | 'deleted' = 'admitted';
    f.execute.mockImplementation((async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      f.calls.push(compiled);
      if (compiled.sql.includes('raw_document_delete_target')) return { rows: [{ target }] };
      if (compiled.sql.includes('update knowledge.documents set object_present_before_purge')) {
        steps.push(`observe:${String(compiled.params[0])}`);
        if (observed === null) observed = compiled.params[0] as boolean;
        return { rows: [] };
      }
      if (compiled.sql.includes('d.object_present_before_purge observed'))
        return { rows: [{ observed, state: 'deleted' }] };
      if (compiled.sql.includes('begin_object_deletion')) {
        steps.push(`begin:${claim}`);
        return { rows: [{ state: claim, claim_id: claimId, object_key: f.key }] };
      }
      if (compiled.sql.includes('object_delete_terminal')) {
        claim = 'deleted';
        return { rows: [] };
      }
      if (compiled.sql.includes('object_delete_absent')) return { rows: [{ proven: true }] };
      throw new Error('GENERATED_UNSCRIPTED_SQL');
    }) as never);
    let present = true;
    const exists = vi.fn(async () => {
      steps.push('head');
      return present;
    });
    const deleteForPurge = vi.fn(async () => {
      steps.push('delete');
      present = false;
      return { transport: 'deleted' as const, capabilityVerified: true };
    });
    const isPhysicallyAbsent = vi.fn(async () => !present);
    Object.assign(f.store, { exists, deleteForPurge, isPhysicallyAbsent });
    return {
      steps,
      exists,
      deleteForPurge,
      observed: () => observed,
      vanish: () => {
        present = false;
      },
    };
  }
  it('observes presence once before the single admitted DELETE and never after it', async () => {
    const f = fixture(),
      e = erasable(f),
      port = createRawKnowledgeObjectPort(f);
    expect(await port.erase(f.service, { documentId: f.write.documentId })).toEqual({
      state: 'purged',
      quiescent: true,
    });
    expect(await port.erase(f.service, { documentId: f.write.documentId })).toEqual({
      state: 'purged',
      quiescent: true,
    });
    expect(e.steps).toEqual(['head', 'observe:true', 'begin:admitted', 'delete', 'begin:deleted']);
    expect(e.observed()).toBe(true);
    expect(e.deleteForPurge).toHaveBeenCalledTimes(1);
    expect(f.ordinaryDelete).not.toHaveBeenCalled();
  });
  it('records bytes already gone before the DELETE as absent, never as present', async () => {
    const f = fixture(),
      e = erasable(f);
    e.vanish();
    expect(
      (await createRawKnowledgeObjectPort(f).erase(f.service, { documentId: f.write.documentId }))
        .state,
    ).toBe('purged');
    expect(e.steps).toEqual(['head', 'observe:false', 'begin:admitted', 'delete']);
    expect(e.observed()).toBe(false);
  });
  it('admits no DELETE while the store cannot answer the presence read', async () => {
    const f = fixture(),
      e = erasable(f);
    e.exists.mockRejectedValueOnce(new Error('Generated unavailable store'));
    const port = createRawKnowledgeObjectPort(f);
    await expect(port.erase(f.service, { documentId: f.write.documentId })).rejects.toThrow(
      'STORE_UNAVAILABLE',
    );
    expect(e.exists).toHaveBeenCalledTimes(1);
    expect(e.steps).toEqual([]); // No observation recorded, no claim admitted, no DELETE sent.
    expect(f.calls.some((call) => call.sql.includes('begin_object_deletion'))).toBe(false);
    expect(e.deleteForPurge).not.toHaveBeenCalled();
    expect((await port.erase(f.service, { documentId: f.write.documentId })).state).toBe('purged');
    expect(e.deleteForPurge).toHaveBeenCalledTimes(1);
    expect(e.observed()).toBe(true);
  });
  it('denies person capture/erase and invalid source versions before SQL', async () => {
    const f = fixture(),
      port = createRawKnowledgeObjectPort(f);
    await expect(port.erase(f.owner, { documentId: f.write.documentId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      port.captureSource(f.owner, {
        sourceId: f.write.sourceId,
        sourceVersion: 1,
        purgeJobId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      port.captureSource(f.service, {
        sourceId: f.write.sourceId,
        sourceVersion: 0,
        purgeJobId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('reports a held source capture as the hold refusal and passes every other refusal through', async () => {
    const f = fixture(),
      port = createRawKnowledgeObjectPort(f),
      input = { sourceId: f.write.sourceId, sourceVersion: 2, purgeJobId: randomUUID() };
    // The shape the driver gives a raised PL/pgSQL exception: the SQLSTATE and text on `cause`.
    const raised = (message: string) =>
      Object.assign(new Error('Failed query'), {
        cause: Object.assign(new Error(message), { code: 'EN850' }),
      });
    f.execute.mockRejectedValueOnce(raised('RAW_SOURCE_HOLD_UNCONFIRMED'));
    await expect(port.captureSource(f.service, input)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    const legacy = raised('RAW_LEGACY_INVENTORY_UNCONFIRMED');
    f.execute.mockRejectedValueOnce(legacy);
    await expect(port.captureSource(f.service, input)).rejects.toBe(legacy);
  });
  it.each([-1, 26, Number.MAX_SAFE_INTEGER + 1, null])(
    'refuses malformed recovery progress %s rather than reporting zero',
    async (changed) => {
      const f = fixture();
      f.execute.mockResolvedValue({ rows: [{ changed }] } as never);
      await expect(createRawKnowledgeObjectPort(f).reconcile(f.service)).rejects.toMatchObject({
        code: 'PREREQUISITES_INCOMPLETE',
      });
    },
  );
  it('missing or negative SQL authority never qualifies historical completed metadata', async () => {
    const f = fixture(),
      tx = { execute: f.execute } as unknown as Tx;
    f.execute.mockResolvedValue({ rows: [{ available: false }] } as never);
    expect(
      await rawSourceMaterialCompleteInTx(tx, {
        sourceId: f.write.sourceId,
        sourceVersion: 2,
        purgeJobId: randomUUID(),
      }),
    ).toBe(false);
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.execute
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ available: true }] } as never)
      .mockResolvedValueOnce({ rows: [{ complete: false }] } as never);
    expect(
      await rawSourceMaterialCompleteInTx(tx, {
        sourceId: f.write.sourceId,
        sourceVersion: 2,
        purgeJobId: randomUUID(),
      }),
    ).toBe(false);
  });
});
