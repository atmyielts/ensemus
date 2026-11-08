// Explicit scripted SQL/store ports verify orchestration only. Actual native authority, encrypted
// parser receipts, forced RLS and concurrency are tests/integration/archive-file-quarantine.test.ts.
import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { AppDatabase, Tx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { quarantineArchiveFile } from '@ensemus/application';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const organizationId = randomUUID(),
    importId = randomUUID(),
    sourceId = randomUUID(),
    token = randomUUID(),
    bytes = Buffer.from('GENERATED inert archived bytes');
  const context = createServiceContext(organizationId),
    key = `${organizationId}/archive-quarantine/${importId}/${sourceId}/${token}`;
  const record = {
    kind: 'artifact' as const,
    id: sourceId,
    name: 'Generated review.txt',
    mime_type: 'text/plain',
    size_bytes: bytes.length,
    sha256: sha(bytes),
    classification: 'internal' as const,
    created_by_membership_id: null,
    created_at: '2026-11-07T00:00:00.000Z',
  };
  const input = {
    importId,
    record,
    bytes,
    sourcePart: { path: 'artifacts/artifacts-000001.jsonl.sealed', sha256: 'a'.repeat(64) },
  };
  let state: 'new' | 'writing' | 'unknown' | 'quarantined' | 'closing' = 'new',
    depth = 0,
    failBegin = false,
    failPut = false,
    failGet = false,
    changed = false,
    finishAllowed = true,
    readyAllowed = true,
    wrongClaim = false;
  const events: string[] = [],
    scope = new Map<string, string>(),
    objects = new Map<string, Buffer>();
  const tx = {
    execute: async (query: SQL) => {
      const { sql: text, params } = new PgDialect().sqlToQuery(query);
      if (text.includes('current_setting(name,true)'))
        return {
          rows: (params[0] as string[]).map((name) => ({ name, value: scope.get(name) ?? null })),
        };
      if (text.includes('set_config')) {
        scope.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      expect(scope.get('app.portability_import_id')).toBe(importId);
      expect(scope.get('app.portability_part_path')).toBe(input.sourcePart.path);
      expect(scope.get('app.portability_part_sha256')).toBe(input.sourcePart.sha256);
      if (text.includes('begin_archive_file')) {
        events.push('begin');
        if (failBegin || !['new', 'quarantined'].includes(state))
          throw Object.assign(new Error('GENERATED_ADMISSION_REFUSAL'), { code: 'EN415' });
        const claimed = state === 'new';
        if (claimed) state = 'writing';
        return {
          rows: [
            {
              claimed,
              object_key: key,
              write_token: token,
              state,
              binary_sha256: wrongClaim ? '0'.repeat(64) : record.sha256,
              size_bytes: record.size_bytes,
            },
          ],
        };
      }
      if (text.includes('finish_archive_file')) {
        events.push('finish');
        state = finishAllowed ? 'quarantined' : 'closing';
        return { rows: [{ ready: finishAllowed }] };
      }
      if (text.includes('unknown_archive_file')) {
        events.push('unknown');
        state = 'unknown';
        return { rows: [] };
      }
      if (text.includes('close_finished_archive_file')) {
        events.push('close_finished');
        state = 'closing';
        return { rows: [] };
      }
      if (text.includes('archive_file_ready')) {
        events.push('ready');
        return { rows: [{ ready: readyAllowed && state === 'quarantined' }] };
      }
      throw new Error('GENERATED_SQL_NOT_SCRIPTED');
    },
    transaction: <T>(run: (inner: Tx) => Promise<T>) => run(tx as unknown as Tx),
  };
  const database = {
    transaction: async <T>(_bindings: Record<string, string>, run: (inner: Tx) => Promise<T>) => {
      depth++;
      try {
        return await run(tx as unknown as Tx);
      } finally {
        depth--;
      }
    },
  } as unknown as AppDatabase;
  const store = {
    put: async (objectKey: string, body: Buffer, mime: string) => {
      expect(depth).toBe(0);
      expect(objectKey).toBe(key);
      expect(mime).toBe('application/octet-stream');
      events.push('put');
      if (failPut) throw new Error('GENERATED_PUT_UNKNOWN');
      objects.set(objectKey, Buffer.from(body));
    },
    get: async (objectKey: string, max?: number) => {
      expect(depth).toBe(0);
      expect(max).toBe(bytes.length);
      events.push('get');
      if (failGet) throw new Error('GENERATED_READBACK_FAILURE');
      const actual = objects.get(objectKey);
      if (!actual) throw new Error('GENERATED_NO_OBJECT');
      return changed ? Buffer.alloc(bytes.length) : actual;
    },
  };
  return {
    context,
    input,
    events,
    objects,
    key,
    run: () => quarantineArchiveFile(database, store, context, input),
    state: () => state,
    options: (options: {
      failBegin?: boolean;
      failPut?: boolean;
      failGet?: boolean;
      changed?: boolean;
      finishAllowed?: boolean;
      readyAllowed?: boolean;
      wrongClaim?: boolean;
    }) => {
      if (options.failBegin !== undefined) failBegin = options.failBegin;
      if (options.failPut !== undefined) failPut = options.failPut;
      if (options.failGet !== undefined) failGet = options.failGet;
      if (options.changed !== undefined) changed = options.changed;
      if (options.finishAllowed !== undefined) finishAllowed = options.finishAllowed;
      if (options.readyAllowed !== undefined) readyAllowed = options.readyAllowed;
      if (options.wrongClaim !== undefined) wrongClaim = options.wrongClaim;
    },
  };
}
describe('inert archive file orchestration', () => {
  it('admits before putting, verifies read-back before settlement, and never holds SQL over object I/O', async () => {
    const f = fixture();
    expect(await f.run()).toEqual({
      sourceArtifactId: f.input.record.id,
      disposition: 'awaiting_human_review',
    });
    expect(f.events).toEqual(['begin', 'put', 'get', 'finish']);
    expect(f.state()).toBe('quarantined');
  });
  it('does not put bytes when actual admission refuses', async () => {
    const f = fixture();
    f.options({ failBegin: true });
    await expect(f.run()).rejects.toThrow();
    expect(f.events).toEqual(['begin']);
    expect(f.objects.size).toBe(0);
  });
  it('does not use a receipt that returns a different byte hash', async () => {
    const f = fixture();
    f.options({ wrongClaim: true });
    await expect(f.run()).rejects.toThrow();
    expect(f.events).toEqual(['begin']);
  });
  it('retains an unknown writer and refuses to resend on replay even while the object is absent', async () => {
    const f = fixture();
    f.options({ failPut: true });
    await expect(f.run()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(f.state()).toBe('unknown');
    expect(f.objects.size).toBe(0);
    f.options({ failPut: false });
    await expect(f.run()).rejects.toThrow();
    expect(f.events).toEqual(['begin', 'put', 'unknown', 'begin']);
  });
  it('settles a finished put as closed when actual read-back fails', async () => {
    const f = fixture();
    f.options({ failGet: true });
    await expect(f.run()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(f.events).toEqual(['begin', 'put', 'get', 'close_finished']);
    expect(f.state()).toBe('closing');
    expect(f.objects.size).toBe(1);
  });
  it('closes a finished writer on a changed read-back without claiming it verified', async () => {
    const f = fixture();
    f.options({ changed: true });
    await expect(f.run()).rejects.toMatchObject({ code: 'PART_CHANGED' });
    expect(f.events).toEqual(['begin', 'put', 'get', 'close_finished']);
    expect(f.state()).toBe('closing');
  });
  it('keeps finished bytes closed if live authority is lost at settlement', async () => {
    const f = fixture();
    f.options({ finishAllowed: false });
    await expect(f.run()).rejects.toThrow();
    expect(f.events).toEqual(['begin', 'put', 'get', 'finish', 'close_finished']);
    expect(f.state()).toBe('closing');
  });
  it('reuses only a previously settled object and rechecks bytes and live SQL readiness', async () => {
    const f = fixture();
    await f.run();
    f.events.length = 0;
    await f.run();
    expect(f.events).toEqual(['begin', 'get', 'ready']);
    f.options({ readyAllowed: false });
    await expect(f.run()).rejects.toThrow();
    expect(f.events.filter((event) => event === 'put')).toEqual([]);
  });
  it('refuses a changed previously settled object without resending or fabricating a new writer', async () => {
    const f = fixture();
    await f.run();
    f.events.length = 0;
    f.options({ changed: true });
    await expect(f.run()).rejects.toMatchObject({ code: 'PART_CHANGED' });
    expect(f.events).toEqual(['begin', 'get']);
    expect(f.state()).toBe('quarantined');
  });
});
