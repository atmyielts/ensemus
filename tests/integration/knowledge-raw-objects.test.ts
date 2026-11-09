// UNRUN until 0516 and its reviewed prerequisites are composed. Real roles/native generated
// sessions establish SQL authority; the explicit memory transport is NOT provider qualification.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  openAppDatabase,
  knowledgeDocuments,
  knowledgeObjectWriters,
  interactiveSessionOf,
  withTenantTx,
} from '@ensemus/database';
import { openAgentDatabase } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { eraseTenantRows } from '@ensemus/database/eraser';
import { pgCode, type ObjectStore } from '@ensemus/application';
import { addUploadedSource, openDocumentBytes } from '@ensemus/application/knowledge/sources';
import {
  deleteSource,
  purgeRunTranscriptsForSource,
  runSourcePurge,
} from '@ensemus/application/knowledge/purge';
import { confirmDelegatedWorkPurgeInTx } from '@ensemus/application/knowledge/delegated-work-purge';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import { recoverObjectWrites } from '../../packages/application/src/knowledge/object-writes';
import {
  rawSourceMaterialCompleteInTx,
  withRawKnowledgeObjects,
} from '@ensemus/application/knowledge/raw-objects';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import {
  createObjectDeletionLifecycle,
  createSqlObjectDeletionAuthority,
} from '@ensemus/application/saas/object-deletion';
import { beginErasure } from '@ensemus/application/saas/offboarding';
import { lifecycleTenant, LifecycleMemoryStore } from './saas-lifecycle-fixture';
import { publishErasureLedger, readyToErase } from './saas-offboarding-fixture';
import { createKnowledgePurgePorts } from '../../workers/workflow/src/knowledge-ports';
import { proveSecondFactor } from '../helpers/product';
import { purgeAgentMaterialsForSource } from '../helpers/knowledge-native';
import { urls } from '../helpers/stack';

class NativeRawMap extends LifecycleMemoryStore {
  // A test-only single-attempt memory protocol, never a real provider/fence certificate.
  outcome: 'written' | 'unknown' = 'written';
  afterPut?: () => Promise<void>;
  puts = 0;
  async putSingleAttempt(key: string, body: Buffer): Promise<{ transport: 'written' | 'unknown' }> {
    this.puts++;
    this.objects.set(key, Buffer.from(body));
    await this.afterPut?.();
    return { transport: this.outcome };
  }
}
describe('native raw source material authority', () => {
  const app = openAppDatabase(urls.app()),
    agent = openAgentDatabase(urls.agent());
  const auth = new pg.Client({ connectionString: urls.auth() }),
    observer = new pg.Client({ connectionString: urls.superuser() });
  beforeAll(async () => {
    await auth.connect();
    await observer.connect();
  });
  afterAll(async () => {
    await auth.end();
    await observer.end();
    await agent.close();
    await app.close();
  });
  async function prepared(
    options: { unknown?: boolean; missingPut?: boolean; closeDuringPut?: boolean } = {},
  ) {
    const owner = await lifecycleTenant(app.db, auth),
      native = new NativeRawMap();
    const identity = interactiveSessionOf(owner);
    if (!identity) throw new Error('TEST_NATIVE_IDENTITY_REQUIRED');
    await proveSecondFactor(identity);
    const service = createServiceContext(owner.organizationId),
      body = Buffer.from(`generated raw ${randomUUID()}`);
    if (options.unknown) native.outcome = 'unknown';
    const transport = options.missingPut ? new LifecycleMemoryStore() : native;
    const store = withRawKnowledgeObjects({ database: app.db, store: transport });
    let closed: { purgeJobId: string } | undefined;
    if (options.closeDuringPut)
      native.afterPut = async () => {
        const [source] = await withTenantTx(app.db, service, (tx) =>
          tx.execute<{ id: string }>(
            sql`select id from knowledge.sources where organization_id=${owner.organizationId}::uuid`,
          ),
        ).then((result) => result.rows);
        if (!source) throw new Error('TEST_SOURCE_MISSING');
        closed = await deleteSource(app.db, owner, {
          sourceId: source.id,
          expectedVersion: 1,
          reason: 'Generated revoke during PUT',
        });
      };
    const upload = await addUploadedSource(app.db, store, owner, {
      title: 'Generated raw test',
      body,
      mediaType: 'text/plain',
      classification: 'internal',
      grants: [],
    }).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    const metadata = await withTenantTx(app.db, service, (tx) =>
      tx.execute<{ source_id: string; document_id: string; version: number }>(sql`
      select s.id source_id,d.id document_id,s.version::integer version from knowledge.sources s
      join knowledge.documents d on d.organization_id=s.organization_id and d.source_id=s.id where s.organization_id=${owner.organizationId}::uuid`),
    );
    const row = metadata.rows[0];
    if (!row) throw new Error('TEST_SOURCE_MISSING');
    const closure =
      closed ??
      (await deleteSource(app.db, owner, {
        sourceId: row.source_id,
        expectedVersion: row.version,
        reason: 'Generated source removal',
      }));
    const sourceVersion = closed ? row.version : row.version + 1;
    const input = { sourceId: row.source_id, sourceVersion, purgeJobId: closure.purgeJobId };
    return {
      owner,
      service,
      native,
      store,
      body,
      upload,
      input,
      documentId: row.document_id,
      key: `${owner.organizationId}/knowledge/${row.document_id}`,
    };
  }
  async function capture(f: Awaited<ReturnType<typeof prepared>>) {
    while ((await f.store.rawKnowledge.captureSource(f.service, f.input)).more) {
      /* Real bounded SQL cursor. */
    }
  }
  const complete = (f: Awaited<ReturnType<typeof prepared>>) =>
    withTenantTx(app.db, f.service, (tx) => rawSourceMaterialCompleteInTx(tx, f.input));
  async function removeHeaders(f: Awaited<ReturnType<typeof prepared>>) {
    // Actual agent-role transcript inventory/certification, even for an actually unused source.
    // No stub transcript/child/physical proof is seeded to make this PG deletion pass.
    await purgeRunTranscriptsForSource(
      agent.db,
      f.service,
      { transcripts: createRunTranscriptPurge() },
      { sourceId: f.input.sourceId },
    );
    await withTenantTx(app.db, f.service, async (tx) => {
      await tx
        .delete(knowledgeObjectWriters)
        .where(eq(knowledgeObjectWriters.documentId, f.documentId));
      await tx.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, f.documentId));
    });
  }
  it('uses a genuine future PUT and exact DELETE proof before confirming a still-pending job', async () => {
    const f = await prepared();
    expect(f.upload.error).toBeNull();
    expect(f.native.puts).toBe(1);
    expect(await complete(f)).toBe(false);
    await capture(f);
    expect(await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).toEqual({
      state: 'purged',
      quiescent: true,
    });
    expect(await complete(f)).toBe(false); // Live PG headers still exist.
    await removeHeaders(f);
    expect(await complete(f)).toBe(true);
    const row = await withTenantTx(app.db, f.service, (tx) =>
      tx.execute<{ state: string }>(
        sql`select state from knowledge.purge_jobs where id=${f.input.purgeJobId}::uuid`,
      ),
    );
    expect(row.rows[0]?.state).toBe('pending'); // No completed/status or child proof was fabricated.
  });
  it('retains each exact native generation after live writer/document headers disappear', async () => {
    const f = await prepared();
    await capture(f);
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'purged',
    );
    await removeHeaders(f);
    const history = await observer.query<{ generation: string; state: string }>(
      'select generation::text,state from lifecycle.raw_object_writes where organization_id=$1 and document_id=$2 order by generation',
      [f.owner.organizationId, f.documentId],
    );
    expect(history.rows).toEqual([
      { generation: '0', state: 'catalog' },
      { generation: '1', state: 'finished' },
    ]);
    expect(await complete(f)).toBe(true);
  });
  it('keeps an unknown PUT nonreplayable despite bytes/HEAD and a legacy Boolean fence', async () => {
    const f = await prepared({ unknown: true });
    expect(f.upload.error).toBeTruthy();
    expect(await f.native.exists(f.key)).toBe(true);
    await capture(f);
    const fence = vi.fn(async () => ({ quiescent: true }));
    await recoverObjectWrites(
      app.db,
      Object.assign(f.store, { fenceKnowledgeWrite: fence }),
      f.service,
      f.input.sourceId,
    );
    expect(fence).not.toHaveBeenCalled();
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'unconfirmed',
    );
    expect(f.native.puts).toBe(1);
    expect(await complete(f)).toBe(false);
  });
  it('permanently closes a future never-admitted intent without pretending an old writer was fenced', async () => {
    const f = await prepared({ missingPut: true });
    expect(f.upload.error).toBeTruthy();
    await recoverObjectWrites(app.db, f.store, f.service, f.input.sourceId);
    await capture(f);
    const history = await observer.query<{ state: string; admitted_at: Date | null }>(
      'select state,admitted_at from lifecycle.raw_object_writes where organization_id=$1 and document_id=$2 and generation=1',
      [f.owner.organizationId, f.documentId],
    );
    expect(history.rows).toEqual([{ state: 'not_dispatched', admitted_at: null }]);
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'purged',
    );
    await removeHeaders(f);
    expect(await complete(f)).toBe(true);
  });
  it('records actual PUT completion after closure while refusing publication and serving', async () => {
    const f = await prepared({ closeDuringPut: true });
    expect(f.upload.error).toBeTruthy();
    const writer = await withTenantTx(app.db, f.service, (tx) =>
      tx.execute<{ state: string }>(
        sql`select state from knowledge.object_writers where document_id=${f.documentId}::uuid`,
      ),
    );
    expect(writer.rows[0]?.state).toBe('settled');
    await expect(openDocumentBytes(app.db, f.store, f.owner, f.documentId)).rejects.toThrow();
    await capture(f);
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'purged',
    );
  });
  it('holds block destructive admission and metadata removal without losing writer completion', async () => {
    const f = await prepared();
    await capture(f);
    const remove = vi.spyOn(f.native, 'deleteForPurge');
    const hold = await placeLegalHold(app.db, f.owner, {
      matterRef: randomUUID(),
      scopes: [{ type: 'organization', id: null }],
    });
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'held',
    );
    expect(remove).not.toHaveBeenCalled();
    expect(await complete(f)).toBe(false);
    await releaseLegalHold(app.db, f.owner, {
      holdId: hold.holdId,
      expectedVersion: 1,
      reasonCode: 'GENERATED_TEST_RELEASE',
    });
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'purged',
    );
  });
  it('an UNKNOWN DELETE cannot be erased by HEAD or a successful second transport', async () => {
    const f = await prepared();
    await capture(f);
    const remove = vi
      .spyOn(f.native, 'deleteForPurge')
      .mockResolvedValue({ transport: 'unknown', capabilityVerified: false });
    const head = vi.spyOn(f.native, 'isPhysicallyAbsent').mockResolvedValue(true);
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'unconfirmed',
    );
    remove.mockRestore();
    const second = vi.spyOn(f.native, 'deleteForPurge');
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'unconfirmed',
    );
    expect(second).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    expect(await complete(f)).toBe(false);
  });
  it('retries only absence after a known terminal DELETE response', async () => {
    const f = await prepared();
    await capture(f);
    const remove = vi.spyOn(f.native, 'deleteForPurge'),
      head = vi
        .spyOn(f.native, 'isPhysicallyAbsent')
        .mockRejectedValueOnce(new Error('GENERATED_READ_OUTAGE'));
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'unconfirmed',
    );
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'purged',
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(head).toHaveBeenCalledTimes(2);
  });
  it('foreign source/job/document/generation pins cannot obtain destructive authority', async () => {
    const f = await prepared(),
      other = await prepared();
    await capture(f);
    await capture(other);
    expect(
      (await f.store.rawKnowledge.erase(other.service, { documentId: f.documentId })).state,
    ).toBe('unconfirmed');
    const target = await withTenantTx(app.db, f.service, (tx) =>
      tx.execute<{ target: Record<string, unknown> }>(
        sql`select lifecycle.raw_document_delete_target(${f.documentId}::uuid) target`,
      ),
    );
    for (const patch of [
      { sourceId: other.input.sourceId },
      { purgeJobId: other.input.purgeJobId },
      { writeId: randomUUID() },
      { generation: 0 },
      { authRestoreGeneration: randomUUID() },
    ]) {
      await expect(
        withTenantTx(app.db, f.service, (tx) =>
          tx.execute(
            sql`select * from lifecycle.begin_object_deletion(${JSON.stringify({ ...target.rows[0]?.target, ...patch })}::jsonb)`,
          ),
        ),
      ).rejects.toThrow();
    }
    expect(await f.native.exists(f.key)).toBe(true);
  });
  it('does not let a document disappear before a positive raw receipt', async () => {
    const f = await prepared();
    await capture(f);
    // Establish the independent transcript authority so that the raw guard is the remaining fence.
    await purgeRunTranscriptsForSource(
      agent.db,
      f.service,
      { transcripts: createRunTranscriptPurge() },
      { sourceId: f.input.sourceId },
    );
    const refusal = await withTenantTx(app.db, f.service, (tx) =>
      tx.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, f.documentId)),
    ).catch((error: unknown) => error);
    expect(pgCode(refusal)).toBe('EN850');
    expect(await f.native.exists(f.key)).toBe(true);
  });
  it('app and actual agent SET ROLE app cannot inspect or delete retained raw authority', async () => {
    const f = await prepared(),
      client = new pg.Client({ connectionString: urls.agent() });
    await client.connect();
    try {
      for (const role of ['ensemus_app', 'ensemus_agent']) {
        const error = await withTenantTx(
          role === 'ensemus_app' ? app.db : agent.db,
          f.service,
          (tx) => tx.execute(sql`select * from lifecycle.raw_object_writes`),
        ).catch((cause: unknown) => cause);
        expect(pgCode(error)).toBe('42501');
      }
      await client.query('begin');
      await client.query('set local role ensemus_app');
      await client.query(
        "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true),set_config('lifecycle.raw_object_org',$1,true)",
        [f.owner.organizationId],
      );
      await expect(
        client.query('delete from lifecycle.raw_object_writes where organization_id=$1', [
          f.owner.organizationId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
  it('observes the real hold waiter before committing a raw deletion claim', async () => {
    const f = await prepared();
    await capture(f);
    const claim = new pg.Client({ connectionString: urls.app() });
    await claim.connect();
    let waiting: Promise<unknown> | undefined;
    try {
      await claim.query('begin');
      await claim.query(
        "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true)",
        [f.owner.organizationId],
      );
      const pid = (await claim.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
      const target = (
        await claim.query<{ target: unknown }>(
          'select lifecycle.raw_document_delete_target($1) target',
          [f.documentId],
        )
      ).rows[0]!.target;
      await claim.query('select * from lifecycle.begin_object_deletion($1::jsonb)', [
        JSON.stringify(target),
      ]);
      waiting = placeLegalHold(app.db, f.owner, {
        matterRef: randomUUID(),
        scopes: [{ type: 'organization', id: null }],
      }).catch((error: unknown) => error);
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await observer.query<{ blocked: boolean }>(
          'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) blocked',
          [pid],
        );
        if (result.rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked, 'Observe a PostgreSQL lock waiter, not a timing assumption').toBe(true);
      await claim.query('commit');
      expect(pgCode(await waiting)).toBe('EN851');
    } finally {
      await claim.query('rollback');
      if (waiting) await waiting;
      await claim.end();
    }
  });
  it('private metadata is not an erasure certificate and missing physical proof cannot seal', async () => {
    const f = await prepared();
    await capture(f);
    const sealed = await withTenantTx(app.db, f.service, (tx) =>
      tx.execute<{ sealed: boolean }>(
        sql`select lifecycle.seal_delegated_erasure(${randomUUID()}::uuid) sealed`,
      ),
    );
    expect(sealed.rows[0]?.sealed).toBe(false);
    const erase = createSqlObjectDeletionAuthority(app.db);
    await expect(
      erase.begin(f.service, {
        kind: 'raw_source',
        sourceId: f.input.sourceId,
        sourceVersion: String(f.input.sourceVersion),
        purgeJobId: f.input.purgeJobId,
        documentId: f.documentId,
        writeId: randomUUID(),
        generation: 1,
        materialRestoreGeneration: randomUUID(),
        authRestoreGeneration: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await complete(f)).toBe(false);
  });
  it('an app SQL settled label cannot replace native PUT/no-request authority', async () => {
    const f = await prepared({ missingPut: true });
    const refusal = await withTenantTx(app.db, f.service, (tx) =>
      tx
        .update(knowledgeObjectWriters)
        .set({ state: 'settled' })
        .where(eq(knowledgeObjectWriters.documentId, f.documentId)),
    ).catch((error: unknown) => error);
    expect(pgCode(refusal)).toBe('EN850');
    expect(await complete(f)).toBe(false);
  });
  it('the actual agent login cannot mint a PUT receipt by casting itself as app/service', async () => {
    const f = await prepared({ missingPut: true });
    const error = await withTenantTx(agent.db, f.service, (tx) =>
      tx.execute(
        sql`select * from lifecycle.admit_raw_put(${f.documentId}::uuid,${randomUUID()}::uuid,1::bigint)`,
      ),
    ).catch((cause: unknown) => cause);
    expect(pgCode(error)).toBe('42501');
    expect(f.native.puts).toBe(0);
  });
  it('wrong current source versions and job IDs never qualify the pending-job predicate', async () => {
    const f = await prepared();
    await capture(f);
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'purged',
    );
    await removeHeaders(f);
    expect(await complete(f)).toBe(true);
    for (const input of [
      { ...f.input, sourceVersion: f.input.sourceVersion + 1 },
      { ...f.input, purgeJobId: randomUUID() },
    ]) {
      expect(
        await withTenantTx(app.db, f.service, (tx) => rawSourceMaterialCompleteInTx(tx, input)),
      ).toBe(false);
    }
  });
  it('bounded capture replays are stable and a missing deletion capability is not physical success', async () => {
    const f = await prepared();
    await capture(f);
    expect(await f.store.rawKnowledge.captureSource(f.service, f.input)).toEqual({ more: false });
    const deletion = vi.spyOn(f.native, 'delete');
    const noCapabilities: ObjectStore = {
      put: f.native.put.bind(f.native),
      get: f.native.get.bind(f.native),
      exists: f.native.exists.bind(f.native),
      delete: f.native.delete.bind(f.native),
    };
    const closed = withRawKnowledgeObjects({ database: app.db, store: noCapabilities });
    expect((await closed.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'unconfirmed',
    );
    expect((await closed.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'unconfirmed',
    );
    expect(deletion).not.toHaveBeenCalled();
    expect(await complete(f)).toBe(false);
  });
  it('erases genuine source/job and ordered raw metadata from its native seal across adapter retries', async () => {
    const f = await prepared();
    expect(f.upload.error).toBeNull();
    await capture(f);
    expect((await f.store.rawKnowledge.erase(f.service, { documentId: f.documentId })).state).toBe(
      'purged',
    );
    await removeHeaders(f);
    // The agent worker's actual transcript + delegated-Work activity runs before the knowledge
    // worker's purge, as in production; 0419 refuses completion without its fresh proof.
    await purgeAgentMaterialsForSource(agent.db, {
      organizationId: f.owner.organizationId,
      sourceId: f.input.sourceId,
    });
    const lifecycle = createObjectDeletionLifecycle({ database: app.db, store: f.store });
    const purged = await runSourcePurge(
      app.db,
      f.store,
      f.service,
      { sourceId: f.input.sourceId },
      {
        ...createKnowledgePurgePorts({
          database: app.db,
          store: f.store,
          derivedLifecycle: lifecycle.derived,
          archiveLifecycle: lifecycle.archive,
        }),
        delegatedWorks: { confirmInTx: confirmDelegatedWorkPurgeInTx },
      },
    );
    expect(purged.state).toBe('completed');
    const ready = await readyToErase(app.db, f.owner);
    await beginErasure(app.db, ready.service, {
      offboardingId: ready.offboardingId,
      operatorRef: 'generated-raw-review@example.invalid',
    });
    await publishErasureLedger(app.db, f.owner, f.native);
    const sealed = await withTenantTx(app.db, ready.service, (tx) =>
      tx.execute<{ sealed: boolean }>(
        sql`select lifecycle.seal_delegated_erasure(${ready.offboardingId}::uuid) sealed`,
      ),
    );
    expect(sealed.rows[0]?.sealed).toBe(true);
    const before = await observer.query<{ scopes: number; writes: number }>(
      `select (select count(*)::integer from lifecycle.raw_source_inventories where organization_id=$1) scopes,
      (select count(*)::integer from lifecycle.raw_object_writes where organization_id=$1) writes`,
      [f.owner.organizationId],
    );
    expect(before.rows[0]?.scopes).toBe(2);
    expect(before.rows[0]?.writes).toBeGreaterThan(0);
    const eraser = new pg.Client({ connectionString: urls.superuser() });
    await eraser.connect();
    try {
      await eraser.query('set session authorization ensemus_eraser');
      // The real adapter must replace poisoned pooled selectors with its exact native service scope.
      await eraser.query(
        "select set_config('app.actor_type','agent',false),set_config('app.membership_id',$1,false),set_config('lifecycle.raw_object_org',$1,false)",
        [randomUUID()],
      );
      const database = drizzle(eraser, { casing: 'snake_case' }) as unknown as Parameters<
        typeof eraseTenantRows
      >[0];
      const first = await eraseTenantRows(database, f.owner.organizationId);
      expect(first.find((row) => row.tableRef === 'knowledge.sources')?.rowsLeft).toBe(0);
      expect(first.find((row) => row.tableRef === 'knowledge.purge_jobs')?.rowsLeft).toBe(0);
      expect(
        first.find((row) => row.tableRef === 'lifecycle.raw_source_inventories'),
      ).toMatchObject({ rowsRemoved: 2, rowsLeft: 0 });
      expect(first.find((row) => row.tableRef === 'lifecycle.raw_object_writes')?.rowsLeft).toBe(0);
      const retry = await eraseTenantRows(database, f.owner.organizationId);
      expect(retry.every((row) => row.rowsRemoved === 0 && row.rowsLeft === 0)).toBe(true);
    } finally {
      await eraser.query('reset session authorization');
      await eraser.end();
    }
  });
  it('retains even empty native organization inventory until an actual current offboarding birth seal exists', async () => {
    // No source/run/body is invented: the real inventory here is genuinely an unused native org.
    // This requires reviewed 0518 counts + LAST0999 reach as well as 0516; absent wiring must fail.
    const owner = await lifecycleTenant(app.db, auth),
      identity = interactiveSessionOf(owner);
    if (!identity) throw new Error('TEST_NATIVE_IDENTITY_REQUIRED');
    await proveSecondFactor(identity);
    const ready = await readyToErase(app.db, owner);
    await beginErasure(app.db, ready.service, {
      offboardingId: ready.offboardingId,
      operatorRef: 'generated-raw-review@example.invalid',
    });
    const eraser = new pg.Client({ connectionString: urls.superuser() });
    await eraser.connect();
    try {
      // Eraser is deliberately NOLOGIN. Test bootstrap selects its actual session authorization,
      // then uses only that role's grants/RLS; it never inserts a receipt or disables a trigger.
      await eraser.query('set session authorization ensemus_eraser');
      const remove = async () => {
        await eraser.query('begin');
        try {
          await eraser.query(
            "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true)",
            [owner.organizationId],
          );
          const result = await eraser.query<{ removed: string }>(
            'select lifecycle.erase_raw_source_inventories()::text removed',
          );
          await eraser.query('commit');
          return Number(result.rows[0]?.removed);
        } catch (error) {
          await eraser.query('rollback');
          throw error;
        }
      };
      await expect(remove()).rejects.toMatchObject({ code: 'EN850' });
      const sealed = await withTenantTx(app.db, ready.service, (tx) =>
        tx.execute<{ sealed: boolean }>(
          sql`select lifecycle.seal_delegated_erasure(${ready.offboardingId}::uuid) sealed`,
        ),
      );
      expect(sealed.rows[0]?.sealed).toBe(true);
      const proof = await observer.query<{
        raw_protocol_version: number;
        raw_scope_count: string;
        raw_write_count: string;
      }>(
        'select raw_protocol_version,raw_scope_count::text,raw_write_count::text from lifecycle.delegated_erasure_receipts where organization_id=$1',
        [owner.organizationId],
      );
      expect(proof.rows).toEqual([
        { raw_protocol_version: 1, raw_scope_count: '1', raw_write_count: '0' },
      ]);
      expect(await remove()).toBe(1);
      // The retained seal, not metadata absence, authorizes idempotent ordered cleanup.
      expect(await remove()).toBe(0);
      const replay = await withTenantTx(app.db, ready.service, (tx) =>
        tx.execute<{ sealed: boolean }>(
          sql`select lifecycle.seal_delegated_erasure(${ready.offboardingId}::uuid) sealed`,
        ),
      );
      expect(replay.rows[0]?.sealed).toBe(true);
    } finally {
      await eraser.query('reset session authorization');
      await eraser.end();
    }
  });
});
