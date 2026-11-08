// Recording SQL/transport doubles verify orchestration only. Native-role SQL cases are separate;
// none of these doubles is exported or bound into product runtime.
import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { ObjectStore } from '../artifacts';
import { createRawKnowledgeObjectPort, rawSourceMaterialCompleteInTx, withRawKnowledgeObjects } from './raw-objects';

vi.mock('@ensemus/database', async original => ({
  ...(await original<typeof import('@ensemus/database')>()),
  withTenantTx: (db: { tx: unknown }, _context: unknown, callback: (tx: unknown) => unknown) => callback(db.tx),
}));
const dialect = new PgDialect();
const context = (actorType: 'user' | 'service' = 'service') => ({
  organizationId: randomUUID(), actorType, membershipId: randomUUID(), userId: randomUUID(), role: 'owner',
}) as unknown as TenantContext;
function fixture() {
  const owner = context('user'), service = { ...owner, actorType: 'service' } as unknown as TenantContext;
  const write = { documentId: randomUUID(), writeId: randomUUID(), sourceId: randomUUID(), generation: 1 };
  const body = Buffer.from('generated known raw bytes'), key = `${owner.organizationId}/knowledge/${write.documentId}`;
  const admission = { state: 'send', source_id: write.sourceId, object_key: key, content_sha256: createHash('sha256').update(body).digest('hex'), size_bytes: String(body.length),
    material_generation: randomUUID(), auth_generation: randomUUID(), token: 'a'.repeat(64) };
  const calls: { sql: string; params: unknown[] }[] = [];
  let admitted = false;
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query); calls.push(compiled);
    if (compiled.sql.includes('admit_raw_put')) {
      if (admitted) throw new Error('RAW_WRITE_ALREADY_ADMITTED');
      admitted = true; return { rows: [admission] };
    }
    if (compiled.sql.includes('finish_raw_put')) return { rows: [{ finished: compiled.params.at(-1) === 'written' }] };
    return { rows: [] };
  });
  const database = { tx: { execute } } as unknown as AppDatabase;
  const putSingleAttempt = vi.fn(async () => ({ transport: 'written' as 'written' | 'unknown' }));
  const ordinaryPut = vi.fn(async () => undefined), ordinaryDelete = vi.fn(async () => undefined);
  const store: ObjectStore = { put: ordinaryPut, delete: ordinaryDelete, get: async () => Buffer.from(body), exists: async () => true, putSingleAttempt };
  return { owner, service, write, body, key, admission, calls, execute, database, store, putSingleAttempt, ordinaryPut, ordinaryDelete };
}
describe('native raw object orchestration', () => {
  it('admits first, uses exactly one native PUT, then settles its exact token/generations', async () => {
    const f = fixture(), port = createRawKnowledgeObjectPort(f);
    await port.put(f.owner, f.write, f.body, 'text/plain');
    expect(f.putSingleAttempt).toHaveBeenCalledExactlyOnceWith(f.key, f.body, 'text/plain');
    expect(f.ordinaryPut).not.toHaveBeenCalled();
    expect(f.calls.map(call => call.sql.includes('finish_raw_put') ? 'finish' : 'admit')).toEqual(['admit', 'finish']);
    expect(f.calls[1]?.params).toEqual([f.write.documentId, f.write.writeId, 1, f.admission.token, f.admission.material_generation, f.admission.auth_generation, 'written']);
  });
  it('requires the native transport capability before it can consume admission', async () => {
    const f = fixture(); delete f.store.putSingleAttempt;
    await expect(createRawKnowledgeObjectPort(f).put(f.owner, f.write, f.body, 'text/plain')).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.ordinaryPut).not.toHaveBeenCalled();
  });
  it.each(['source_id', 'object_key', 'content_sha256', 'size_bytes', 'material_generation', 'token'] as const)('does not send against a malformed or mismatched %s admission', async field => {
    const f = fixture(); f.admission[field] = 'invalid';
    await expect(createRawKnowledgeObjectPort(f).put(f.owner, f.write, f.body, 'text/plain')).rejects.toThrow();
    expect(f.putSingleAttempt).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1); // An admitted-but-not-sent row is never silently labelled cancelled.
  });
  it.each(['unknown', 'rejected'] as const)('records %s as UNKNOWN and never retries the admitted native mutation', async mode => {
    const f = fixture();
    if (mode === 'rejected') f.putSingleAttempt.mockRejectedValue(new Error('synthetic dropped response'));
    else f.putSingleAttempt.mockResolvedValue({ transport: 'unknown' });
    const port = createRawKnowledgeObjectPort(f);
    await expect(port.put(f.owner, f.write, f.body, 'text/plain')).rejects.toMatchObject({ code: 'OBJECT_DELETE_UNCONFIRMED' });
    expect(f.calls[1]?.params.at(-1)).toBe('unknown');
    await expect(port.put(f.owner, f.write, f.body, 'text/plain')).rejects.toThrow('RAW_WRITE_ALREADY_ADMITTED');
    expect(f.putSingleAttempt).toHaveBeenCalledTimes(1);
  });
  it('captures mutable bytes and writer identity before the SQL await', async () => {
    const f = fixture(), expected = Buffer.from(f.body), originalDocument = f.write.documentId;
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async query => {
      const result = await execute(query);
      if (dialect.sqlToQuery(query).sql.includes('admit_raw_put')) { f.body.fill(0); f.write.documentId = randomUUID(); }
      return result;
    });
    await createRawKnowledgeObjectPort(f).put(f.owner, f.write, f.body, 'text/plain');
    expect(f.putSingleAttempt).toHaveBeenCalledExactlyOnceWith(f.key, expected, 'text/plain');
    expect(f.calls[1]?.params[0]).toBe(originalDocument);
  });
  it('does not expose ordinary raw PUT or DELETE while preserving unrelated object methods', async () => {
    const f = fixture(), exposed = withRawKnowledgeObjects(f);
    expect(() => exposed.put(f.key, f.body, 'text/plain')).toThrow();
    expect(() => exposed.delete(f.key)).toThrow();
    expect(() => exposed.putSingleAttempt?.(f.key, f.body, 'text/plain')).toThrow();
    await exposed.put('other/artifacts/test', f.body, 'text/plain');
    expect(f.ordinaryPut).toHaveBeenCalledTimes(1); expect(f.ordinaryDelete).not.toHaveBeenCalled();
    expect(await exposed.get(f.key)).toEqual(f.body);
  });
  it('returns unconfirmed for a malformed deletion target before admitting any DELETE', async () => {
    const f = fixture(); f.execute.mockResolvedValue({ rows: [{ target: { kind: 'raw_source', documentId: f.write.documentId } }] } as never);
    await expect(createRawKnowledgeObjectPort(f).erase(f.service, { documentId: f.write.documentId })).resolves.toEqual({ state: 'unconfirmed' });
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.ordinaryDelete).not.toHaveBeenCalled();
  });
  it('denies person capture/erase and invalid source versions before SQL', async () => {
    const f = fixture(), port = createRawKnowledgeObjectPort(f);
    await expect(port.erase(f.owner, { documentId: f.write.documentId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(port.captureSource(f.owner, { sourceId: f.write.sourceId, sourceVersion: 1, purgeJobId: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(port.captureSource(f.service, { sourceId: f.write.sourceId, sourceVersion: 0, purgeJobId: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([-1, 26, Number.MAX_SAFE_INTEGER + 1, null])('refuses malformed recovery progress %s rather than reporting zero', async changed => {
    const f = fixture(); f.execute.mockResolvedValue({ rows: [{ changed }] } as never);
    await expect(createRawKnowledgeObjectPort(f).reconcile(f.service)).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
  });
  it('missing or negative SQL authority never qualifies historical completed metadata', async () => {
    const f = fixture(), tx = { execute: f.execute } as unknown as Tx;
    f.execute.mockResolvedValue({ rows: [{ available: false }] } as never);
    expect(await rawSourceMaterialCompleteInTx(tx, { sourceId: f.write.sourceId, sourceVersion: 2, purgeJobId: randomUUID() })).toBe(false);
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.execute.mockReset().mockResolvedValueOnce({ rows: [{ available: true }] } as never).mockResolvedValueOnce({ rows: [{ complete: false }] } as never);
    expect(await rawSourceMaterialCompleteInTx(tx, { sourceId: f.write.sourceId, sourceVersion: 2, purgeJobId: randomUUID() })).toBe(false);
  });
});
