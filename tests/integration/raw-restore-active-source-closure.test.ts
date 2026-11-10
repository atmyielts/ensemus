// The closure of an ACTIVE Knowledge source a restore left in raw debt (0551, check findings 1 and 4),
// against real RLS, the real raw object authority and the native raw object port. FLAGGED FOR HUMAN
// SECURITY REVIEW, not yet reviewed by a person. raw-restore-active-source.test.ts covers 0550's
// re-proof and the ordinary purge of a requalified source once closed; this file covers what 0551
// adds: the corrected write predicate (finding 1), the closure observation of a source with a missing
// or changed object (finding 4 (ii)), and the supersede of a lost upload on a requalified source
// (finding 4 (iii)). It also runs 0551's postcondition with each of 0551's rewrites, wraps and grants
// undone in turn (r10 check finding 7), and records that 0550's own postcondition, which ran once when
// 0550 was applied, no longer holds after 0551 and that nothing runs it again (r10 check finding 13).
// The material restore generation is rotated the way the native restore rotates it,
// which is global: this file runs serially, as the whole integration project does
// (fileParallelism: false). Storage is an explicit memory test double; nothing here qualifies a provider.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  AppError,
  recordRawRestoreActiveSourceClosure,
  requalifyRawRestoreActiveSource,
  requalifyRawRestoreOrganization,
  type ObjectStore,
} from '@ensemus/application';
import { ingestDocument, type IngestDeps } from '@ensemus/application/knowledge/ingest';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import {
  addDocumentVersion,
  addUploadedSource,
  getSource,
} from '@ensemus/application/knowledge/sources';
import { openAppDatabase, withTenantTx, type TenantContext } from '@ensemus/database';
import { openAgentDatabase } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { knowledgeObjectKey } from '@ensemus/domain/knowledge';
import { parseDocument } from '@ensemus/knowledge/parsing';
import { pgCode } from '../../packages/application/src/errors';
import { seedAiTenant } from '../helpers/ai/fixtures';
import { nativeKnowledgeStore, runNativeKnowledgePurge } from '../helpers/knowledge-native';
import { repoRoot, urls } from '../helpers/stack';

/** A memory bucket with the single-attempt and physical-absence capabilities the runtime store has. */
class Bucket implements ObjectStore {
  objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.objects.set(key, Buffer.from(body));
  }
  async putSingleAttempt(key: string, body: Buffer): Promise<{ transport: 'written' }> {
    this.objects.set(key, Buffer.from(body));
    return { transport: 'written' };
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error('MISSING');
    return Buffer.from(bytes);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async deleteForPurge(key: string): Promise<{ transport: 'deleted'; capabilityVerified: true }> {
    this.objects.delete(key);
    return { transport: 'deleted', capabilityVerified: true };
  }
  async isPhysicallyAbsent(key: string) {
    return !this.objects.has(key);
  }
}

/** The same bucket, whose single-attempt PUT loses its response: the native outcome is unknown. */
const losingResponses = (bucket: Bucket): ObjectStore => ({
  put: (key, body) => bucket.put(key, body),
  get: (key) => bucket.get(key),
  exists: (key) => bucket.exists(key),
  delete: (key) => bucket.delete(key),
  putSingleAttempt: async () => {
    throw new Error('Generated lost response');
  },
  deleteForPurge: (key) => bucket.deleteForPurge(key),
  isPhysicallyAbsent: (key) => bucket.isPhysicallyAbsent(key),
});

/** The same bucket without the single-attempt PUT: a writer is begun, and never admitted. */
const neverAdmitting = (bucket: Bucket): ObjectStore => ({
  put: (key, body) => bucket.put(key, body),
  get: (key) => bucket.get(key),
  exists: (key) => bucket.exists(key),
  delete: (key) => bucket.delete(key),
});

type Active = {
  bucket: Bucket;
  owner: TenantContext;
  service: TenantContext;
  organizationId: string;
  sourceId: string;
  documentId: string;
  key: string;
  bytes: Buffer;
};

/** The SQL refusal behind an error: its code and the exception the migration raised. */
const refusal = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => ({
      code: pgCode(error),
      reason: (error as { cause?: { message?: string } }).cause?.message,
    }),
  );
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const ingestDeps: IngestDeps = {
  parse: async (body, type) => parseDocument(body, type),
  contentScan: { scan: () => ({ raiseTo: null, codes: [] }) },
};

describe('closing an active source a restore left in raw debt (0551)', () => {
  let app: ReturnType<typeof openAppDatabase>,
    agent: ReturnType<typeof openAgentDatabase>,
    migrator: pg.Client,
    control: pg.Client;
  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    agent = openAgentDatabase(urls.agent());
    migrator = new pg.Client({ connectionString: urls.migrator() });
    control = new pg.Client({ connectionString: urls.superuser() });
    await migrator.connect();
    await control.connect();
  });
  afterAll(async () => {
    await migrator?.end();
    await control?.end();
    await agent?.close();
    await app?.close();
  });

  /** The native restore's material rotation, exactly as raw-restore-active-source.test.ts drives it. */
  const rotate = async () => {
    const prior = {
      'app.organization_id': randomUUID(),
      'app.actor_type': 'user',
      'app.membership_id': randomUUID(),
      'app.user_id': randomUUID(),
      'sovereign.material_restore_mode': 'previous',
      'sovereign.material_restore_org': randomUUID(),
      'sovereign.material_restore_generation': randomUUID(),
    };
    await migrator.query('begin');
    try {
      for (const [key, value] of Object.entries(prior))
        await migrator.query('select set_config($1,$2,true)', [key, value]);
      const rotation = await migrator.query<{ tenants: number }>(
        'select sovereign.rotate_material_restore_generation() tenants',
      );
      expect(rotation.rows[0]?.tenants).toBeGreaterThan(0);
      await migrator.query('commit');
    } catch (error) {
      await migrator.query('rollback');
      throw error;
    }
  };
  const inventory = async (f: Active) =>
    (
      await control.query<{ state: string; sealed: boolean; job: string | null }>(
        `select i.state,i.sealed_at is not null sealed,i.purge_job_id::text job
         from lifecycle.raw_source_inventories i
         where i.organization_id=$1 and i.scope_kind='source' and i.source_id=$2`,
        [f.organizationId, f.sourceId],
      )
    ).rows[0];
  const observations = async (f: Active) =>
    (
      await control.query<{ absent: string[]; changed: string[]; current: boolean }>(
        `select e.absent_document_ids::text[] absent,e.changed_document_ids::text[] changed,
          e.material_restore_generation=o.material_restore_generation current
         from lifecycle.raw_active_source_closure_observations e join org.organizations o on o.id=e.organization_id
         where e.organization_id=$1 and e.source_id=$2`,
        [f.organizationId, f.sourceId],
      )
    ).rows;
  const headers = async (f: Active) =>
    (
      await control.query<{ documents: number; chunks: number }>(
        `select (select count(*)::int from knowledge.documents where organization_id=$1 and source_id=$2) documents,
          (select count(*)::int from knowledge.chunks where organization_id=$1 and source_id=$2) chunks`,
        [f.organizationId, f.sourceId],
      )
    ).rows[0];
  /**
   * 0551's corrected write predicate, asked directly inside the raw metadata scope the fixed writer
   * functions read it in, for the current material generation. Nothing is written: rolled back.
   */
  const writable = async (f: Active) => {
    const material = (
      await control.query<{ material: string }>(
        'select material_restore_generation::text material from org.organizations where id=$1',
        [f.organizationId],
      )
    ).rows[0]!.material;
    await migrator.query('begin');
    try {
      await migrator.query(
        "select set_config('app.organization_id',$1,true),set_config('lifecycle.raw_object_org',$1,true)",
        [f.organizationId],
      );
      return (
        await migrator.query<{ answer: boolean }>(
          'select lifecycle.raw_active_source_requalified($1::uuid,$2::uuid) answer',
          [f.sourceId, material],
        )
      ).rows[0]?.answer;
    } finally {
      await migrator.query('rollback');
    }
  };
  const version = async (f: Active) => (await getSource(app.db, f.owner, f.sourceId)).version;
  const revoke = async (f: Active) =>
    revokeSource(app.db, f.owner, {
      sourceId: f.sourceId,
      expectedVersion: await version(f),
      reason: 'Generated closure after a restore',
    });
  const newVersion = async (f: Active, body: Buffer, store: ObjectStore = f.bucket) =>
    addDocumentVersion(app.db, nativeKnowledgeStore(app.db, store), f.owner, {
      sourceId: f.sourceId,
      expectedVersion: await version(f),
      title: 'Generated next version',
      mediaType: 'text/plain',
      body,
    });
  const purge = (f: Active) =>
    runNativeKnowledgePurge({
      app: app.db,
      agent: agent.db,
      store: nativeKnowledgeStore(app.db, f.bucket),
      organizationId: f.organizationId,
      sourceId: f.sourceId,
    });
  const observe = (
    f: Active,
    present: { documents: string[]; hashes: string[]; sizes: number[] },
    absent: string[],
    database = app.db,
    context = f.service,
  ) =>
    withTenantTx(database, context, (tx) =>
      tx.execute(
        sql`select lifecycle.record_raw_restore_active_source_closure(${f.sourceId}::uuid,
          ${`{${present.documents.join(',')}}`}::uuid[],${`{${present.hashes.join(',')}}`}::text[],
          ${`{${present.sizes.join(',')}}`}::bigint[],${`{${absent.join(',')}}`}::uuid[])`,
      ),
    );

  /** An open source with one raw object, uploaded natively and ingested before the restore. */
  const prepare = async (title: string): Promise<Active> => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const bucket = new Bucket();
    const store = nativeKnowledgeStore(app.db, bucket);
    const source = await addUploadedSource(app.db, store, tenant.owner, {
      title,
      mediaType: 'text/plain',
      body: Buffer.from(`Generated ${title}.`),
      classification: 'internal',
      grants: [],
    });
    const key = knowledgeObjectKey(tenant.organizationId, source.documentId);
    const bytes = bucket.objects.get(key);
    expect(bytes).toBeDefined();
    const service = createServiceContext(tenant.organizationId);
    expect(
      await ingestDocument(app.db, store, service, ingestDeps, { documentId: source.documentId }),
    ).toMatchObject({ outcome: 'searchable' });
    return {
      bucket,
      owner: tenant.owner,
      service,
      organizationId: tenant.organizationId,
      sourceId: source.sourceId,
      documentId: source.documentId,
      key,
      bytes: bytes!,
    };
  };

  // E is requalified (0550); M has a missing object and C a changed one, so neither can be.
  let e: Active, m: Active, c: Active;

  it('prepares three open sources and leaves each in restore debt', async () => {
    e = await prepare('requalified then closed');
    m = await prepare('missing object');
    c = await prepare('changed object');
    await rotate();
    for (const f of [e, m, c]) {
      expect(await inventory(f)).toMatchObject({ state: 'restore_debt', sealed: false, job: null });
      expect(await requalifyRawRestoreOrganization(app.db, f.service)).toEqual({
        state: 'requalified',
      });
    }
    expect(await requalifyRawRestoreActiveSource(app.db, e.bucket, e.service, e.sourceId)).toEqual({
      state: 'requalified',
      observed: 'present',
    });
    // Present and unchanged is 0550's re-proof, never a closure observation.
    expect(
      await recordRawRestoreActiveSourceClosure(app.db, e.bucket, e.service, e.sourceId),
    ).toEqual({ state: 'unchanged' });
    expect(await observations(e)).toEqual([]);
  });

  it('retries a requalified upload whose admitted PUT lost its response (finding 4 (iii))', async () => {
    const body = Buffer.from('Generated version whose first response was lost.');
    await expect(newVersion(e, body, losingResponses(e.bucket))).rejects.toEqual(
      new AppError('INVALID_STATE'),
    );
    const lost = await control.query<{ document: string; state: string }>(
      `select w.document_id::text document,w.state from lifecycle.raw_object_writes w
       where w.organization_id=$1 and w.source_id=$2 and w.generation=1 and w.state='unknown'`,
      [e.organizationId, e.sourceId],
    );
    expect(lost.rows).toHaveLength(1);
    const documentId = lost.rows[0]!.document;
    // 0523's supersede required an 'open' inventory of this generation; 0551 accepts the requalified
    // one, so the same upload resends the same bytes as its next generation.
    const retried = await newVersion(e, body);
    expect(retried).toEqual({ documentId, unchanged: true });
    expect(e.bucket.objects.get(knowledgeObjectKey(e.organizationId, documentId))).toEqual(body);
    const writes = await control.query<{ generation: string; state: string }>(
      `select w.generation::text generation,w.state from lifecycle.raw_object_writes w
       where w.organization_id=$1 and w.document_id=$2 and w.generation>0 order by w.generation`,
      [e.organizationId, documentId],
    );
    expect(writes.rows).toEqual([
      { generation: '1', state: 'unknown' },
      { generation: '2', state: 'finished' },
    ]);
    expect(
      await ingestDocument(app.db, nativeKnowledgeStore(app.db, e.bucket), e.service, ingestDeps, {
        documentId,
      }),
    ).toMatchObject({ outcome: 'searchable' });
  });

  it('refuses every write to a requalified source once it is closed (finding 1)', async () => {
    // A writer begun before the closure and never admitted.
    await expect(
      newVersion(e, Buffer.from('Generated never admitted.'), neverAdmitting(e.bucket)),
    ).rejects.toEqual(new AppError('INVALID_STATE'));
    const pending = await control.query<{ document: string; write: string; generation: string }>(
      `select a.document_id::text document,a.write_id::text write,a.generation::text generation
       from knowledge.object_writers a join lifecycle.raw_object_writes w
        on w.organization_id=a.organization_id and w.document_id=a.document_id and w.write_id=a.write_id and w.generation=a.generation
       where a.organization_id=$1 and a.source_id=$2 and a.state='active' and w.state='intent'`,
      [e.organizationId, e.sourceId],
    );
    expect(pending.rows).toHaveLength(1);
    // Active, requalified, no purge job: the write predicate answers yes.
    expect(await writable(e)).toBe(true);
    const { purgeJobId } = await revoke(e);
    expect(await inventory(e)).toMatchObject({ state: 'restore_debt', job: purgeJobId });
    // 0550's predicate still answered yes here: the inventory is restore debt and the proof matches.
    // 0551's answers no once the source is closed and has a purge job.
    expect(await writable(e)).toBe(false);
    const { document, write, generation } = pending.rows[0]!;
    expect(
      await refusal(
        withTenantTx(app.db, e.owner, (tx) =>
          tx.execute(
            sql`select * from lifecycle.admit_raw_put(${document}::uuid,${write}::uuid,${generation}::bigint)`,
          ),
        ),
      ),
    ).toMatchObject({ code: 'EN850' });
    const before = e.bucket.objects.size;
    await expect(newVersion(e, Buffer.from('Generated after the closure.'))).rejects.toEqual(
      new AppError('KNOWLEDGE_SOURCE_CLOSED'),
    );
    expect(e.bucket.objects.size).toBe(before);
  });

  it('cannot re-prove or close a source whose object is missing until it is observed (finding 4 (ii))', async () => {
    m.bucket.objects.delete(m.key);
    expect(await requalifyRawRestoreActiveSource(app.db, m.bucket, m.service, m.sourceId)).toEqual({
      state: 'missing',
      documentIds: [m.documentId],
    });
    expect(await refusal(revoke(m))).toEqual({ code: '42501', reason: 'RAW_INVENTORY_IMMUTABLE' });
  });

  it('refuses a person, the agent login and an inexact observation, recording nothing', async () => {
    await expect(
      recordRawRestoreActiveSourceClosure(app.db, m.bucket, m.owner, m.sourceId),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    const none = { documents: [], hashes: [], sizes: [] };
    expect(await refusal(observe(m, none, [m.documentId], app.db, m.owner))).toEqual({
      code: '42501',
      reason: 'RAW_ACTIVE_RESTORE_CLOSURE_SERVICE_REQUIRED',
    });
    // The agent login inherits EXECUTE through ensemus_app, so the function's opening session_user
    // check is what refuses it, even with a service actor.
    expect(await refusal(observe(m, none, [m.documentId], agent.db))).toEqual({
      code: '42501',
      reason: 'RAW_ACTIVE_RESTORE_CLOSURE_SERVICE_REQUIRED',
    });
    const hash = sha256(m.bytes);
    for (const [present, absent] of [
      [none, []],
      [{ documents: [m.documentId], hashes: [hash], sizes: [m.bytes.length] }, [m.documentId]],
      [none, [m.documentId, m.documentId]],
      [none, [randomUUID()]],
      [{ documents: [m.documentId], hashes: ['g'.repeat(64)], sizes: [m.bytes.length] }, []],
    ] as [typeof none, string[]][])
      expect(await refusal(observe(m, present, absent))).toEqual({
        code: 'EN850',
        reason: 'RAW_ACTIVE_RESTORE_CLOSURE_UNCONFIRMED',
      });
    expect(await observations(m)).toEqual([]);
  });

  it('records the missing object as evidence, never as a write, and lets the source close and be purged', async () => {
    const recorded = { state: 'recorded', absentDocumentIds: [m.documentId] };
    expect(
      await recordRawRestoreActiveSourceClosure(app.db, m.bucket, m.service, m.sourceId),
    ).toEqual(recorded);
    // The same observation again changes nothing.
    expect(
      await recordRawRestoreActiveSourceClosure(app.db, m.bucket, m.service, m.sourceId),
    ).toEqual(recorded);
    expect(await observations(m)).toEqual([{ absent: [m.documentId], changed: [], current: true }]);
    // Never a write: the writer predicate does not read the observation.
    expect(await writable(m)).toBe(false);
    expect(await refusal(newVersion(m, Buffer.from('Generated refused version.')))).toEqual({
      code: 'EN850',
      reason: 'RAW_LEGACY_WRITER_UNCONFIRMED',
    });
    const { purgeJobId } = await revoke(m);
    expect((await getSource(app.db, m.owner, m.sourceId)).state).toBe('revoked');
    expect(await inventory(m)).toMatchObject({
      state: 'restore_debt',
      sealed: false,
      job: purgeJobId,
    });
    expect(await purge(m)).toMatchObject({ state: 'completed' });
    expect(await headers(m)).toEqual({ documents: 0, chunks: 0 });
    // A closed source is observed no more.
    expect(
      await refusal(observe(m, { documents: [], hashes: [], sizes: [] }, [m.documentId])),
    ).toEqual({ code: 'EN850', reason: 'RAW_ACTIVE_SOURCE_REQUIRED' });
  });

  it('records a changed object, closes the source and deletes whatever is at its key', async () => {
    c.bucket.objects.set(c.key, Buffer.from('Generated bytes that are not the catalogued ones.'));
    expect(
      await refusal(requalifyRawRestoreActiveSource(app.db, c.bucket, c.service, c.sourceId)),
    ).toEqual({ code: 'EN850', reason: 'RAW_ACTIVE_RESTORE_REQUALIFICATION_UNCONFIRMED' });
    expect(await refusal(revoke(c))).toEqual({ code: '42501', reason: 'RAW_INVENTORY_IMMUTABLE' });
    expect(
      await recordRawRestoreActiveSourceClosure(app.db, c.bucket, c.service, c.sourceId),
    ).toEqual({
      state: 'recorded',
      absentDocumentIds: [],
    });
    expect(await observations(c)).toEqual([{ absent: [], changed: [c.documentId], current: true }]);
    await revoke(c);
    expect(await purge(c)).toMatchObject({ state: 'completed' });
    expect(c.bucket.objects.has(c.key)).toBe(false);
    expect(await headers(c)).toEqual({ documents: 0, chunks: 0 });
  });

  // 0551's postcondition (its last statement-breakpoint block), run again in a rolled-back
  // transaction as the migrator after each of 0551's rewrites, wraps or grants is undone in turn
  // (check finding 7). Each case first runs the block on the migrated database, where it must hold,
  // so the refusal that follows is the undoing's alone.
  const migration = (file: string) =>
    readFileSync(join(repoRoot, 'packages/database/migrations', file), 'utf8');
  const lastBlock = (file: string) => migration(file).split('--> statement-breakpoint').at(-1)!;
  const file0550 = '0550_raw_restore_active_source_r8restore.sql';
  const postcondition = lastBlock('0551_raw_restore_active_source_closure_r9restore.sql');
  const definition = async (signature: string) =>
    (
      await migrator.query<{ definition: string }>(
        'select pg_get_functiondef($1::regprocedure) definition',
        [signature],
      )
    ).rows[0]!.definition;
  type Refusal = {
    code: string | undefined;
    message: string | undefined;
    detail: string | undefined;
  } | null;
  /** Runs work as the migrator in a transaction that is always rolled back: null, or its refusal. */
  const rolledBack = async (work: () => Promise<unknown>): Promise<Refusal> => {
    await migrator.query('begin');
    try {
      await work();
      return null;
    } catch (error) {
      const { code, message, detail } = error as Exclude<Refusal, null>;
      return { code, message, detail };
    } finally {
      await migrator.query('rollback');
    }
  };
  /**
   * 0551's postcondition holds, the undoing is applied, and the postcondition is run again. 0551
   * always sends DETAIL: the failing signatures for a predicate or entry point, otherwise ''.
   */
  const withDetail = (result: Refusal) => result && { ...result, detail: result.detail ?? '' };
  const undone = async (undo: () => Promise<unknown>) =>
    withDetail(
      await rolledBack(async () => {
        await migrator.query(postcondition);
        await undo();
        await migrator.query(postcondition);
      }),
    );
  const refused = (detail = '') => ({
    code: 'EN850',
    message: 'RAW_ACTIVE_CLOSURE_POSTCONDITION',
    detail,
  });
  /** Redefines a function from its current definition, which the change must alter. */
  const redefined = (signature: string, change: (text: string) => string) => async () => {
    const before = await definition(signature);
    const after = change(before);
    expect(after).not.toBe(before);
    await migrator.query(after);
  };
  const judged = (signature: string, change: (text: string) => string) =>
    undone(redefined(signature, change));
  const occurrences = (text: string, find: string) => text.split(find).length - 1;
  /** Replaces the nth of exactly `count` occurrences of a text 0551 wrote. */
  const swap =
    (find: string, replacement: string, nth = 1, count = 1) =>
    (text: string) => {
      expect(occurrences(text, find)).toBe(count);
      const parts = text.split(find);
      return parts.slice(0, nth).join(find) + replacement + parts.slice(nth).join(find);
    };
  /** Puts back the definition 0551 cloned before wrapping it: the wrap undone whole. */
  const unwrapped = (name: string, clone: string, signature: string) =>
    undone(async () => {
      const before = await definition(`lifecycle.${clone}${signature}`);
      const after = swap(
        `CREATE OR REPLACE FUNCTION lifecycle.${clone}(`,
        `CREATE OR REPLACE FUNCTION lifecycle.${name}(`,
      )(before);
      await migrator.query(after);
      const same = await migrator.query<{ same: boolean }>(
        `select w.prosrc=c.prosrc same from pg_proc w,pg_proc c
         where w.oid=$1::regprocedure and c.oid=$2::regprocedure`,
        [`lifecycle.${name}${signature}`, `lifecycle.${clone}${signature}`],
      );
      expect(same.rows).toEqual([{ same: true }]);
    });
  // 0516's revoke transition as 0550 wrote it, and as 0551 swapped it (check finding 1).
  const requalifiedTransition =
    "lifecycle.raw_active_source_requalified(NEW.source_id,material) IS TRUE THEN 'restore_debt'";
  const closableTransition =
    "lifecycle.raw_active_source_closable(NEW.source_id,NEW.id,material) IS TRUE THEN 'restore_debt'";

  it("holds on the migrated database and refuses each of 0551's rewrites or wraps undone", async () => {
    expect(await rolledBack(() => migrator.query(postcondition))).toBeNull();
    // An entry point that does anything before its refusal.
    expect(
      await judged(
        'lifecycle.record_raw_restore_active_source_closure(uuid,uuid[],text[],bigint[],uuid[])',
        (text) => text.replace(/\r?\nBEGIN\r?\n/, '\nBEGIN\n PERFORM 1;\n'),
      ),
    ).toEqual(
      refused(
        'lifecycle.record_raw_restore_active_source_closure(uuid,uuid[],text[],bigint[],uuid[])',
      ),
    );
    // Finding 1: the write predicate without each of its closure conditions (0550's gap), or
    // reading the closure observation, which is never a write proof.
    const requalified = 'lifecycle.raw_active_source_requalified(uuid,uuid)';
    for (const change of [
      swap('AND i.purge_job_id IS NULL AND i.source_version IS NULL', ''),
      swap(
        "AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=q.organization_id AND s.id=p_source AND s.state='active')",
        '',
      ),
      swap(
        'AND NOT EXISTS(SELECT 1 FROM knowledge.purge_jobs j WHERE j.organization_id=q.organization_id AND j.source_id=p_source)',
        '',
      ),
      swap(
        'AND i.purge_job_id IS NULL AND i.source_version IS NULL',
        'AND i.purge_job_id IS NULL AND i.source_version IS NULL AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_active_source_closure_observations e WHERE e.organization_id=q.organization_id AND e.source_id=p_source)',
      ),
    ])
      expect(await judged(requalified, change)).toEqual(refused());
    // Finding 1: the revoke transition swapped back from the closure question to 0550's write
    // predicate, which answered true for a closed source.
    expect(
      await judged(
        'lifecycle.record_raw_native_birth()',
        swap(closableTransition, requalifiedTransition),
      ),
    ).toEqual(refused());
    // 0550's admission of a requalified source's PUT, which 0551's postcondition keeps checking.
    expect(
      await judged(
        'lifecycle.admit_raw_put(uuid,uuid,bigint)',
        swap('lifecycle.raw_active_source_requalified(w.source_id,material) IS TRUE', 'false'),
      ),
    ).toEqual(refused());
    // Finding 4 (iii): 0523's supersede, back to an 'open' inventory only, in part or exactly.
    for (const change of [
      swap(
        "OR(source_scope.state='restore_debt' AND lifecycle.raw_active_source_requalified(NEW.source_id,material) IS TRUE)",
        '',
      ),
      swap(
        "OR NOT coalesce((source_scope.state='open' AND source_scope.material_restore_generation=material) OR(source_scope.state='restore_debt' AND lifecycle.raw_active_source_requalified(NEW.source_id,material) IS TRUE),false)",
        "OR source_scope.state<>'open' OR source_scope.material_restore_generation IS DISTINCT FROM material",
      ),
    ])
      expect(await judged('lifecycle.record_raw_supersede()', change)).toEqual(refused());
    // Finding 4 (i): 0547's survivor claim without the sealed inventory 0551 added.
    expect(
      await judged(
        'lifecycle.raw_restore_survivor_claim(uuid)',
        swap(
          "AND i.state='restore_debt' AND i.material_restore_generation<>material AND i.sealed_at IS NOT NULL",
          "AND i.state='restore_debt' AND i.material_restore_generation<>material",
        ),
      ),
    ).toEqual(refused());
    // Finding 4 (i): each wrap undone whole, by putting back the definition 0551 cloned.
    for (const [name, signature] of [
      ['capture_raw_source_inventory', '(uuid,bigint,uuid)'],
      ['raw_document_writers_ready', '(uuid,uuid,uuid)'],
      ['raw_source_inventory_complete', '(uuid,bigint,uuid,uuid,uuid)'],
    ] as const)
      expect(await unwrapped(name, `${name}_before_active_closure`, signature)).toEqual(refused());
    // ... or each wrapper without the branch it added, or the closed-source capture without its
    // hold recheck.
    expect(
      await judged(
        'lifecycle.raw_document_writers_ready(uuid,uuid,uuid)',
        swap(
          'OR coalesce(lifecycle.raw_active_closure_document_ready(p_document,p_material,p_auth),false)',
          '',
        ),
      ),
    ).toEqual(refused());
    expect(
      await judged(
        'lifecycle.raw_source_inventory_complete(uuid,bigint,uuid,uuid,uuid)',
        swap(
          'OR coalesce(p_auth IS NOT NULL AND lifecycle.raw_active_closure_complete(p_source,p_version,p_job,p_material,p_auth),false)',
          '',
        ),
      ),
    ).toEqual(refused());
    expect(
      await judged(
        'lifecycle.capture_raw_source_inventory(uuid,bigint,uuid)',
        swap(
          'lifecycle.source_projection_hold_free(p_source,p_version,p_job) IS DISTINCT FROM true',
          'false',
        ),
      ),
    ).toEqual(refused());
    // The clones keep what they cloned: 0543's wrapper, and 0516's catalogue check in the capture.
    expect(
      await judged(
        'lifecycle.raw_source_inventory_complete_before_active_closure(uuid,bigint,uuid,uuid,uuid)',
        swap(
          'lifecycle.raw_source_inventory_complete_before_requalify(p_source,p_version,p_job,p_material,p_auth)',
          'false',
        ),
      ),
    ).toEqual(refused());
    expect(
      await judged(
        'lifecycle.capture_raw_source_inventory_before_active_closure(uuid,bigint,uuid)',
        (text) => {
          expect(occurrences(text, 'RAW_INVENTORY_INCOMPLETE')).toBeGreaterThan(0);
          return text.split('RAW_INVENTORY_INCOMPLETE').join('RAW_CATALOGUE_UNCONFIRMED');
        },
      ),
    ).toEqual(refused());
    // Finding 4 (i): the completion sweep's rewrite undone.
    expect(
      await judged(
        'lifecycle.reconcile_raw_source_completions(uuid)',
        swap(
          'AND lifecycle.raw_source_requalified(x.source_id,i.source_version,x.id,material) IS NOT TRUE AND lifecycle.raw_active_closure_complete(x.source_id,i.source_version,x.id,material,app.current_auth_restore_generation()) IS NOT TRUE)',
          'AND lifecycle.raw_source_requalified(x.source_id,i.source_version,x.id,material) IS NOT TRUE)',
        ),
      ),
    ).toEqual(refused());
    // Finding 4 (i): each of the tenant erasure witness's three rewrites undone in turn.
    for (const nth of [1, 2, 3])
      expect(
        await judged(
          'lifecycle.raw_tenant_inventory_complete()',
          swap(
            '(lifecycle.raw_source_requalified(i.source_id,i.source_version,i.purge_job_id,material) IS TRUE OR lifecycle.raw_active_closure_complete(i.source_id,i.source_version,i.purge_job_id,material,auth) IS TRUE)',
            'lifecycle.raw_source_requalified(i.source_id,i.source_version,i.purge_job_id,material) IS TRUE',
            nth,
            3,
          ),
        ),
      ).toEqual(refused());
  });

  it("refuses the new table without forced RLS or with a runtime grant, and any predicate's EXECUTE regained", async () => {
    const table = 'lifecycle.raw_active_source_closure_observations';
    for (const statement of [
      `alter table ${table} no force row level security`,
      `alter table ${table} disable row level security`,
    ])
      expect(await undone(() => migrator.query(statement))).toEqual(refused());
    const runtime = [
      'public',
      'ensemus_app',
      'ensemus_agent',
      'ensemus_eraser',
      'ensemus_auth',
      'ensemus_dispatcher',
      'ensemus_secrets',
    ];
    for (const grantee of runtime)
      for (const privilege of ['select', 'insert', 'update', 'delete'])
        expect(
          await undone(() => migrator.query(`grant ${privilege} on ${table} to ${grantee}`)),
        ).toEqual(refused());
    // Every new predicate and clone, named in DETAIL when any runtime role can execute it.
    for (const signature of [
      'lifecycle.raw_active_source_requalified(uuid,uuid)',
      'lifecycle.raw_active_source_proof_pinned(uuid,uuid,uuid)',
      'lifecycle.raw_active_source_closable(uuid,uuid,uuid)',
      'lifecycle.raw_active_source_closed(uuid,bigint,uuid,uuid)',
      'lifecycle.raw_active_closure_document_ready(uuid,uuid,uuid)',
      'lifecycle.raw_active_closure_complete(uuid,bigint,uuid,uuid,uuid)',
      'lifecycle.raw_document_writers_ready_before_active_closure(uuid,uuid,uuid)',
      'lifecycle.raw_source_inventory_complete_before_active_closure(uuid,bigint,uuid,uuid,uuid)',
      'lifecycle.capture_raw_source_inventory_before_active_closure(uuid,bigint,uuid)',
    ])
      for (const grantee of runtime)
        expect(
          await undone(() =>
            migrator.query(`grant execute on function ${signature} to ${grantee}`),
          ),
        ).toEqual(refused(signature));
    // The wrapped predicates stay without runtime access, and the public capture with ensemus_app's.
    for (const statement of [
      'grant execute on function lifecycle.raw_document_writers_ready(uuid,uuid,uuid) to ensemus_app',
      'grant execute on function lifecycle.raw_source_inventory_complete(uuid,bigint,uuid,uuid,uuid) to ensemus_app',
      'revoke execute on function lifecycle.capture_raw_source_inventory(uuid,bigint,uuid) from ensemus_app',
      'grant execute on function lifecycle.capture_raw_source_inventory(uuid,bigint,uuid) to ensemus_eraser',
      'revoke execute on function lifecycle.admit_raw_put(uuid,uuid,bigint) from ensemus_app',
      'grant execute on function lifecycle.admit_raw_put(uuid,uuid,bigint) to ensemus_eraser',
    ])
      expect(await undone(() => migrator.query(statement))).toEqual(refused());
  });

  it('refuses a service-only entry point or rewritten trigger that lost its definer, setting, grant or opening', async () => {
    for (const signature of [
      'lifecycle.raw_active_restore_requalification_documents(uuid)',
      'lifecycle.requalify_raw_restore_active_source(uuid,uuid[],text[],bigint[])',
      'lifecycle.record_raw_restore_active_source_closure(uuid,uuid[],text[],bigint[],uuid[])',
    ]) {
      for (const statement of [
        `alter function ${signature} security invoker`,
        `alter function ${signature} reset search_path`,
        `revoke execute on function ${signature} from ensemus_app`,
        `grant execute on function ${signature} to ensemus_agent`,
        `grant execute on function ${signature} to ensemus_eraser`,
        `grant execute on function ${signature} to public`,
      ])
        expect(await undone(() => migrator.query(statement))).toEqual(refused(signature));
      expect(
        await judged(signature, (text) =>
          text.replace(/\r?\nBEGIN\r?\n/, '\nBEGIN\n PERFORM 1;\n'),
        ),
      ).toEqual(refused(signature));
    }
    for (const signature of [
      'lifecycle.record_raw_native_birth()',
      'lifecycle.admit_raw_put(uuid,uuid,bigint)',
      'lifecycle.record_raw_supersede()',
      'lifecycle.raw_restore_survivor_claim(uuid)',
      'lifecycle.capture_raw_source_inventory(uuid,bigint,uuid)',
      'lifecycle.capture_raw_source_inventory_before_active_closure(uuid,bigint,uuid)',
      'lifecycle.reconcile_raw_source_completions(uuid)',
      'lifecycle.raw_tenant_inventory_complete()',
    ])
      expect(
        await undone(() => migrator.query(`alter function ${signature} security invoker`)),
      ).toEqual(refused());
  });

  it("records that 0550's own postcondition, run once when 0550 was applied, no longer holds after 0551 (finding 13)", async () => {
    const block0550 = lastBlock(file0550);
    // 0550's block counts its write predicate twice in record_raw_native_birth. 0551 moved the revoke
    // transition onto raw_active_source_closable (check finding 1), so it is there once.
    const count = async (needle: string) =>
      (
        await migrator.query<{ n: number }>(
          `select (length(p.prosrc)-length(replace(p.prosrc,$1,'')))/length($1) n
           from pg_proc p where p.oid='lifecycle.record_raw_native_birth()'::regprocedure`,
          [needle],
        )
      ).rows[0]!.n;
    expect(await count('lifecycle.raw_active_source_requalified(NEW.source_id,material)')).toBe(1);
    expect(await count(closableTransition)).toBe(1);
    // It refuses as the migrator today. 0550 raises without a DETAIL.
    expect(await rolledBack(() => migrator.query(block0550))).toEqual({
      code: 'EN850',
      message: 'RAW_ACTIVE_RESTORE_POSTCONDITION',
      detail: undefined,
    });
    // That swap is all it refuses: with 0550's transition put back, 0550's block holds (so do the
    // conditions 0551's block does not repeat: the requalification table's forced RLS and absent
    // grants) and 0551's refuses. The two cannot both hold, and 0551's judges the migrated database.
    expect(
      withDetail(
        await rolledBack(async () => {
          await redefined(
            'lifecycle.record_raw_native_birth()',
            swap(closableTransition, requalifiedTransition),
          )();
          await migrator.query(block0550);
          await migrator.query(postcondition);
        }),
      ),
    ).toEqual(refused());
    // ... and with that transition put back, 0550's block still reaches the table it alone checks.
    for (const statement of [
      'alter table lifecycle.raw_active_source_requalifications no force row level security',
      'grant select on lifecycle.raw_active_source_requalifications to ensemus_app',
    ])
      expect(
        await rolledBack(async () => {
          await redefined(
            'lifecycle.record_raw_native_birth()',
            swap(closableTransition, requalifiedTransition),
          )();
          await migrator.query(block0550);
          await migrator.query(statement);
          await migrator.query(block0550);
        }),
      ).toEqual({ code: 'EN850', message: 'RAW_ACTIVE_RESTORE_POSTCONDITION', detail: undefined });
    expect(await rolledBack(() => migrator.query(postcondition))).toBeNull();
    // Nothing re-runs 0550's block. The migrator (packages/database/src/migrate.ts, drizzle's
    // migrate) applies a journal entry once, only while it is newer than the last one recorded:
    // 0550 is recorded once, with the hash of this file, and 0551 after it.
    const journal = JSON.parse(migration('meta/_journal.json')) as {
      entries: { when: number; tag: string }[];
    };
    const entry = journal.entries.filter((e) => e.tag === file0550.replace(/\.sql$/, ''));
    expect(entry).toHaveLength(1);
    const applied = await control.query<{ hash: string; later: boolean }>(
      `select hash,(select max(created_at) from drizzle.__drizzle_migrations)>created_at later
       from drizzle.__drizzle_migrations where created_at=$1`,
      [entry[0]!.when],
    );
    expect(applied.rows).toEqual([
      {
        hash: sha256(readFileSync(join(repoRoot, 'packages/database/migrations', file0550))),
        later: true,
      },
    ]);
    expect(readFileSync(join(repoRoot, 'packages/database/src/migrate.ts'), 'utf8')).toContain(
      'await migrate(drizzle(client), {',
    );
    // ... and no gate, script, workflow, product code or other migration names the block, its file or
    // its exception.
    const skipped = new Set(['node_modules', 'dist', 'build', 'coverage', '.next', '.turbo']);
    const scanned = /\.(?:[cm]?[jt]sx?|sh|ps1|sql|ya?ml|json)$/;
    const allowed = new Set([
      `packages/database/migrations/${file0550}`,
      'packages/database/migrations/meta/_journal.json',
    ]);
    const naming: string[] = [];
    const walk = (relative: string) => {
      for (const dirent of readdirSync(join(repoRoot, relative), { withFileTypes: true })) {
        const path = `${relative}/${dirent.name}`;
        if (dirent.isDirectory()) {
          if (!skipped.has(dirent.name)) walk(path);
        } else if (dirent.isFile() && scanned.test(dirent.name) && !allowed.has(path)) {
          const text = readFileSync(join(repoRoot, path), 'utf8');
          if (
            text.includes('0550_raw_restore_active_source') ||
            text.includes('RAW_ACTIVE_RESTORE_POSTCONDITION')
          )
            naming.push(path);
        }
      }
    };
    for (const root of ['infrastructure', '.github', 'packages', 'apps', 'workers'])
      if (existsSync(join(repoRoot, root))) walk(root);
    expect(naming).toEqual([]);
  });
});
