// LIFE-01 ordinary upload writer receipts (0539) and late sharing writers (0544). Real app-role SQL;
// a private memory transport proves orchestration and SQL authority, never a provider's deletion.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addArtifact,
  createWorkUnit,
  deleteArtifact,
  objectKey,
  purgeDueBlobs,
  requestExecution,
  transitionWorkUnit,
  type ObjectStore,
} from '@ensemus/application';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import {
  blobLifecycle,
  openAppDatabase,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createActivities } from '@ensemus/workflows/activities';
import { sql } from 'drizzle-orm';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { urls } from '../helpers/stack';
import { lifecycleTenant, LifecycleMemoryStore } from './saas-lifecycle-fixture';

// addArtifact's ID for a request with no key is a random UUID, so a fenced row can only be met by a
// collision. This lets one test hand addArtifact that exact ID; every other call is the real one.
const forced = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => forced.ids.shift() ?? actual.randomUUID() };
});

/** A memory transport whose PUT can be held or observed by the test. */
class HookedStore extends LifecycleMemoryStore {
  beforePut: ((key: string) => Promise<void>) | undefined;
  afterPut: ((key: string) => Promise<void>) | undefined;
  puts = 0;
  override async put(key: string, body: Buffer) {
    await this.beforePut?.(key);
    this.puts++;
    await super.put(key, body);
    await this.afterPut?.(key);
  }
}

const code = (name: string) => expect.objectContaining({ code: name });
const hashOf = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const idOf = (key: string) => key.split('/').at(-1)!;

describe('ordinary upload writer receipts (0539) and late sharing writers (0544)', () => {
  const app = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() });
  beforeAll(async () => {
    await auth.connect();
  });
  afterAll(async () => {
    await auth.end();
    await app.close();
  });
  const tenant = () => lifecycleTenant(app.db, auth);
  /** Past the one-hour upload grace period that a fenced orphan row keeps. */
  const later = () => new Date(Date.now() + 2 * 60 * 60 * 1000);
  const plus = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60 * 1000);

  const one = async <T extends Record<string, unknown>>(
    context: TenantContext,
    query: ReturnType<typeof sql>,
  ) => withTenantTx(app.db, context, async (tx) => (await tx.execute<T>(query)).rows[0]);
  const blobState = async (context: TenantContext, artifactId: string) =>
    (
      await one<{ state: string }>(
        context,
        sql`select state from platform.blob_lifecycle where artifact_id=${artifactId}::uuid`,
      )
    )?.state;
  const register = async (
    context: TenantContext,
    artifactId: string,
    writeId: string,
    hash: string,
  ) =>
    (
      await one<{ ok: boolean }>(
        context,
        sql`select lifecycle.register_upload_write(${artifactId}::uuid, ${writeId}::uuid, ${hash}) as ok`,
      )
    )?.ok;
  const settle = async (context: TenantContext, artifactId: string, writeId: string) =>
    (
      await one<{ outcome: string }>(
        context,
        sql`select lifecycle.settle_upload_write(${artifactId}::uuid, ${writeId}::uuid) as outcome`,
      )
    )?.outcome;
  const deleteTarget = async (context: TenantContext, artifactId: string) =>
    (
      await one<{ target: unknown }>(
        context,
        sql`select lifecycle.artifact_delete_target(${artifactId}::uuid) as target`,
      )
    )?.target;
  const beginDeletion = async (context: TenantContext, artifactId: string) =>
    (
      await one<{ state: string }>(
        context,
        sql`select state from lifecycle.begin_object_deletion(${JSON.stringify({ kind: 'ordinary', artifactId })}::jsonb)`,
      )
    )?.state;
  /** Claims are retained lifecycle evidence with no app grant; read them as the test superuser. */
  const claimStates = async (organizationId: string, key: string) => {
    const su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    try {
      const rows = await su.query<{ state: string }>(
        `select state from lifecycle.object_deletion_claims
         where organization_id=$1 and object_key=$2 order by admitted_at`,
        [organizationId, key],
      );
      return rows.rows.map((row) => row.state);
    } finally {
      await su.end();
    }
  };
  const cancel = (context: TenantContext, workUnitId: string) =>
    transitionWorkUnit(app.db, context, { id: workUnitId, expectedVersion: 1, to: 'cancelled' });

  /** An orphan through the production path: its Work is stopped while its bytes are on the way, so
   * its only writer settles after its PUT and the row is fenced ('deleting'). */
  async function orphan(
    owner: TenantContext,
    store: HookedStore,
    during?: (key: string) => Promise<void>,
  ) {
    const work = await createWorkUnit(app.db, owner, { title: 'Generated orphan work' });
    const body = Buffer.from(`generated-${randomUUID()}`);
    let key = '';
    store.afterPut = async (put) => {
      key = put;
      store.afterPut = undefined;
      await during?.(put);
      await cancel(owner, work.id);
    };
    await expect(
      addArtifact(app.db, store, owner, {
        workUnitId: work.id,
        name: 'orphan.txt',
        mimeType: 'text/plain',
        body,
      }),
    ).rejects.toEqual(code('INVALID_STATE'));
    return { artifactId: idOf(key), key, hash: hashOf(body), workUnitId: work.id };
  }

  describe('artifact_delete_target', () => {
    it('names a fenced orphan as ordinary with no tombstone, and nothing before it is fenced', async () => {
      const owner = await tenant(),
        store = new HookedStore(),
        other = randomUUID();
      // A second request sharing the row is still sending its bytes when the first one gives up.
      const { artifactId } = await orphan(owner, store, async (key) => {
        expect(await register(owner, idOf(key), other, hashOf(store.objects.get(key)!))).toBe(true);
      });
      expect(await blobState(owner, artifactId)).toBe('uploading');
      // Not yet abandoned, and not deleted: the earlier answer, which names nothing.
      expect(await deleteTarget(owner, artifactId)).toBeNull();
      expect(await settle(owner, artifactId, other)).toBe('fenced');
      expect(await deleteTarget(owner, artifactId)).toEqual({ kind: 'ordinary', artifactId });
      const tombstones = await withTenantTx(app.db, owner, (tx) =>
        tx.execute(sql`select 1 from platform.tombstones where target_id=${artifactId}::uuid`),
      );
      expect(tombstones.rows).toHaveLength(0);
      // Another tenant is told nothing about it.
      expect(await deleteTarget(await tenant(), artifactId)).toBeNull();
    });
  });

  describe('begin_object_deletion for an abandoned upload', () => {
    it('refuses under a legal hold, sending no DELETE, and removes it once the hold is released', async () => {
      const owner = await tenant(),
        store = new HookedStore();
      const { artifactId, key } = await orphan(owner, store);
      const hold = await placeLegalHold(app.db, owner, {
        matterRef: randomUUID(),
        scopes: [{ type: 'organization', id: null }],
      });
      const remove = vi.spyOn(store, 'deleteForPurge');
      const at = later();
      expect(await purgeDueBlobs(app.db, store, owner, at)).toEqual({ purged: 0, failed: 1 });
      expect(await beginDeletion(owner, artifactId)).toBe('held');
      expect(remove).not.toHaveBeenCalled();
      expect(store.objects.has(key)).toBe(true);
      expect(await claimStates(owner.organizationId, key)).toEqual([]);
      expect(await blobState(owner, artifactId)).toBe('deleting');

      await releaseLegalHold(app.db, owner, {
        holdId: hold.holdId,
        expectedVersion: 1,
        reasonCode: 'GENERATED_TEST_RELEASE',
      });
      expect(await purgeDueBlobs(app.db, store, owner, plus(at, 16))).toEqual({
        purged: 1,
        failed: 0,
      });
      expect(store.objects.has(key)).toBe(false);
      expect(await claimStates(owner.organizationId, key)).toEqual(['proven']);
      expect(await blobState(owner, artifactId)).toBe('purged');
    });

    it('refuses under restore debt for its key, sending no DELETE and admitting no claim', async () => {
      const owner = await tenant(),
        store = new HookedStore();
      const { artifactId, key } = await orphan(owner, store);
      // Only a restore leaves this debt, and no production path restores an ordinary upload key,
      // so the generated fixture writes the row such a restore would leave, as the superuser.
      const su = new pg.Client({ connectionString: urls.superuser() });
      await su.connect();
      try {
        await inFixtureTenant(su, owner.organizationId, () =>
          su.query(
            `insert into lifecycle.object_restore_debts(organization_id,object_key,kind,artifact_id,writer_token)
             values($1,$2,'derived',$3,$4)`,
            [owner.organizationId, key, artifactId, randomUUID()],
          ),
        );
      } finally {
        await su.end();
      }
      const remove = vi.spyOn(store, 'deleteForPurge');
      expect(await purgeDueBlobs(app.db, store, owner, later())).toEqual({ purged: 0, failed: 1 });
      expect(await beginDeletion(owner, artifactId)).toBe('unconfirmed');
      expect(remove).not.toHaveBeenCalled();
      expect(store.objects.has(key)).toBe(true);
      expect(await claimStates(owner.organizationId, key)).toEqual([]);
      expect(await blobState(owner, artifactId)).toBe('deleting');
    });

    it('admits no second claim beside an earlier unresolved one, and resumes only its own', async () => {
      const owner = await tenant(),
        store = new HookedStore();
      // An earlier DELETE whose outcome is unknown: never replayed, never replaced.
      const first = await orphan(owner, store);
      const ambiguous: ObjectStore = {
        put: (key, body) => store.put(key, body),
        get: (key) => store.get(key),
        delete: (key) => store.delete(key),
        exists: (key) => store.exists(key),
        deleteForPurge: async () => ({ transport: 'unknown', capabilityVerified: false }),
        isPhysicallyAbsent: (key) => store.isPhysicallyAbsent(key),
      };
      const at = later();
      expect(await purgeDueBlobs(app.db, ambiguous, owner, at)).toEqual({ purged: 0, failed: 1 });
      expect(await claimStates(owner.organizationId, first.key)).toEqual(['unknown']);
      const remove = vi.spyOn(store, 'deleteForPurge');
      expect(await purgeDueBlobs(app.db, store, owner, plus(at, 16))).toEqual({
        purged: 0,
        failed: 1,
      });
      expect(await beginDeletion(owner, first.artifactId)).toBe('unconfirmed');
      expect(remove).not.toHaveBeenCalled();
      expect(store.objects.has(first.key)).toBe(true);
      expect(await claimStates(owner.organizationId, first.key)).toEqual(['unknown']);
      remove.mockRestore();

      // An earlier known DELETE that the absence check could not yet confirm resumes as that same
      // claim, with no second DELETE, once the bytes are really gone.
      const second = await orphan(owner, store);
      const claimsDone: ObjectStore = {
        ...ambiguous,
        deleteForPurge: async () => ({ transport: 'deleted', capabilityVerified: true }),
      };
      // The first row has backed off past both of these sweeps, so each sees only the second.
      const at2 = later();
      expect(await purgeDueBlobs(app.db, claimsDone, owner, at2)).toEqual({
        purged: 0,
        failed: 1,
      });
      expect(await claimStates(owner.organizationId, second.key)).toEqual(['deleted']);
      store.objects.delete(second.key);
      const resumed = vi.spyOn(store, 'deleteForPurge');
      expect(await purgeDueBlobs(app.db, store, owner, plus(at2, 16))).toEqual({
        purged: 1,
        failed: 0,
      });
      expect(resumed).not.toHaveBeenCalled();
      expect(await claimStates(owner.organizationId, second.key)).toEqual(['proven']);
      expect(await claimStates(owner.organizationId, first.key)).toEqual(['unknown']);
    });
  });

  describe('register_upload_write', () => {
    it('refuses a row that is not uploading, is tombstoned or does not exist', async () => {
      const owner = await tenant(),
        store = new HookedStore(),
        hash = hashOf(Buffer.from('generated'));
      const fresh = randomUUID(),
        tombstoned = randomUUID();
      await withTenantTx(app.db, owner, async (tx) => {
        for (const artifactId of [fresh, tombstoned])
          await tx.insert(blobLifecycle).values({
            organizationId: owner.organizationId,
            artifactId,
            objectKey: objectKey(owner.organizationId, artifactId),
            state: 'uploading',
            purgeAfter: new Date(Date.now() + 60 * 60 * 1000),
          });
        await tx.execute(sql`insert into platform.tombstones (organization_id, target_type, target_id, reason_code)
          values (${owner.organizationId}::uuid, 'artifact', ${tombstoned}::uuid, 'USER_DELETED')`);
      });
      // The same call on an ordinary uploading row registers, so each refusal below is its own.
      expect(await register(owner, fresh, randomUUID(), hash)).toBe(true);
      expect(await register(owner, tombstoned, randomUUID(), hash)).toBe(false);
      expect(await register(owner, randomUUID(), randomUUID(), hash)).toBe(false);
      const { artifactId, hash: orphanHash } = await orphan(owner, store);
      expect(await blobState(owner, artifactId)).toBe('deleting');
      expect(await register(owner, artifactId, randomUUID(), orphanHash)).toBe(false);
      expect(await purgeDueBlobs(app.db, store, owner, later())).toMatchObject({ purged: 1 });
      expect(await blobState(owner, artifactId)).toBe('purged');
      expect(await register(owner, artifactId, randomUUID(), orphanHash)).toBe(false);
    });

    it('refuses a generated upload, whose lineage owns its writer', async () => {
      const owner = await tenant(),
        store = new HookedStore();
      const work = await createWorkUnit(app.db, owner, {
        title: 'Generated checklist work',
        executionPlan: 'checklist',
        completionCriteria: [{ kind: 'artifact_exists' }],
      });
      await transitionWorkUnit(app.db, owner, {
        id: work.id,
        expectedVersion: work.version,
        to: 'ready',
      });
      await requestExecution(app.db, owner, work.id);
      const input = {
        organizationId: owner.organizationId,
        workUnitId: work.id,
        runId: randomUUID(),
      };
      const activities = createActivities({ database: app.db, store });
      expect(await activities.prepareWork(input)).toMatchObject({ status: 'running' });
      let refused: boolean | undefined;
      store.beforePut = async (key) => {
        // Uploading, under the right key and not tombstoned: only its lineage refuses a writer.
        expect(await blobState(owner, idOf(key))).toBe('uploading');
        refused = await register(owner, idOf(key), randomUUID(), hashOf(Buffer.from('x')));
      };
      await activities.produceChecklistArtifact(input);
      expect(refused).toBe(false);
    });
  });

  describe('a request that shares a fenced row (artifacts.ts)', () => {
    async function fencedShared(owner: TenantContext, store: HookedStore) {
      const work = await createWorkUnit(app.db, owner, { title: 'Generated shared work' });
      const first = await addArtifact(app.db, store, owner, {
        workUnitId: work.id,
        name: 'same.txt',
        mimeType: 'text/plain',
        body: Buffer.from('generated first'),
      });
      const keyed = {
        workUnitId: work.id,
        name: 'same.txt',
        mimeType: 'text/plain',
        body: Buffer.from('generated second'),
        requestKey: randomUUID(),
      };
      // A name kept once: this request gets the existing file, and its own row is fenced.
      expect(await addArtifact(app.db, store, owner, { ...keyed, onlyOnce: true })).toEqual({
        id: first.id,
      });
      const fenced = await withTenantTx(app.db, owner, (tx) =>
        tx.execute<{ artifact_id: string }>(
          sql`select artifact_id from platform.blob_lifecycle where state='deleting'`,
        ),
      );
      expect(fenced.rows).toHaveLength(1);
      return { work, first, keyed, fencedId: fenced.rows[0]!.artifact_id };
    }

    it('gives a request with a key a new ID of its own', async () => {
      const owner = await tenant(),
        store = new HookedStore();
      const { first, keyed, fencedId } = await fencedShared(owner, store);
      const { id } = await addArtifact(app.db, store, owner, keyed);
      expect(id).not.toBe(fencedId);
      expect(id).not.toBe(first.id);
      expect(store.objects.get(objectKey(owner.organizationId, id))?.toString()).toBe(
        'generated second',
      );
      expect(await blobState(owner, fencedId)).toBe('deleting');
    });

    it('refuses a request with no key that meets the fenced row, before any byte is sent', async () => {
      const owner = await tenant(),
        store = new HookedStore();
      const { work, fencedId } = await fencedShared(owner, store);
      const puts = store.puts;
      forced.ids.push(fencedId);
      await expect(
        addArtifact(app.db, store, owner, {
          workUnitId: work.id,
          name: 'other.txt',
          mimeType: 'text/plain',
          body: Buffer.from('generated third'),
        }),
      ).rejects.toEqual(code('VERSION_CONFLICT'));
      expect(forced.ids).toEqual([]);
      expect(store.puts).toBe(puts);
      expect(await blobState(owner, fencedId)).toBe('deleting');
    });
  });

  describe('a sharing writer whose PUT lands after the shared file was deleted (0544)', () => {
    /** Two requests from one form: the first publishes; the second registered first and waits.
     * `whileUploading` runs once the second has registered, while the shared row is still uploading. */
    async function sharedUpload(
      owner: TenantContext,
      store: HookedStore,
      whileUploading?: (key: string, body: Buffer) => Promise<void>,
    ) {
      const work = await createWorkUnit(app.db, owner, { title: 'Generated late writer work' });
      const input = {
        workUnitId: work.id,
        name: 'shared.txt',
        mimeType: 'text/plain',
        body: Buffer.from(`generated-${randomUUID()}`),
        requestKey: randomUUID(),
      };
      let reached!: () => void;
      const registered = new Promise<void>((resolve) => (reached = resolve));
      let send!: () => void;
      const gate = new Promise<void>((resolve) => (send = resolve));
      const late = new HookedStore();
      late.beforePut = async (key) => {
        try {
          await whileUploading?.(key, input.body);
        } finally {
          reached();
        }
        await gate;
      };
      late.afterPut = async (key) => {
        await store.put(key, late.objects.get(key)!);
      };
      const sharing = addArtifact(app.db, late, owner, input).then(
        () => undefined,
        () => undefined,
      );
      await registered;
      const first = await addArtifact(app.db, store, owner, input);
      return {
        work,
        first,
        key: objectKey(owner.organizationId, first.id),
        send,
        sharing,
      };
    }

    it('puts the key back on the owed list when its PUT lands after the purge, and the sweep removes it', async () => {
      const owner = await tenant(),
        store = new HookedStore();
      const f = await sharedUpload(owner, store);
      await deleteArtifact(app.db, store, owner, { workUnitId: f.work.id, artifactId: f.first.id });
      expect(store.objects.has(f.key)).toBe(false);
      expect(await blobState(owner, f.first.id)).toBe('purged');
      // The purge happened between the sharing writer's registration and its PUT.
      f.send();
      await f.sharing;
      expect(store.objects.has(f.key)).toBe(true);
      expect(await blobState(owner, f.first.id)).toBe('deleting');
      expect(await purgeDueBlobs(app.db, store, owner)).toEqual({ purged: 1, failed: 0 });
      expect(store.objects.has(f.key)).toBe(false);
      expect(await blobState(owner, f.first.id)).toBe('purged');
      expect(await claimStates(owner.organizationId, f.key)).toEqual(['proven', 'proven']);
      expect(await purgeDueBlobs(app.db, store, owner)).toEqual({ purged: 0, failed: 0 });
    });

    it('does not let a claim that was proven while the late PUT landed stand for its bytes', async () => {
      const owner = await tenant(),
        store = new HookedStore();
      const f = await sharedUpload(owner, store);
      // The DELETE and the absence check have both happened; the PUT lands and settles before the
      // claim is recorded as proven.
      let raced = false;
      const racing: ObjectStore = {
        put: (key, body) => store.put(key, body),
        get: (key) => store.get(key),
        delete: (key) => store.delete(key),
        exists: (key) => store.exists(key),
        deleteForPurge: (key) => store.deleteForPurge(key),
        isPhysicallyAbsent: async (key) => {
          const absent = await store.isPhysicallyAbsent(key);
          if (!raced) {
            raced = true;
            f.send();
            await f.sharing;
          }
          return absent;
        },
      };
      await deleteArtifact(app.db, racing, owner, {
        workUnitId: f.work.id,
        artifactId: f.first.id,
      });
      expect(raced).toBe(true);
      expect(store.objects.has(f.key)).toBe(true);
      expect(await claimStates(owner.organizationId, f.key)).toEqual(['proven']);
      expect(await blobState(owner, f.first.id)).toBe('deleting');
      expect(await purgeDueBlobs(app.db, store, owner)).toEqual({ purged: 1, failed: 0 });
      expect(store.objects.has(f.key)).toBe(false);
      expect(await claimStates(owner.organizationId, f.key)).toEqual(['proven', 'proven']);
      expect(await blobState(owner, f.first.id)).toBe('purged');
    });

    it('leaves a deletion alone when the sharing writer finished before it began', async () => {
      const owner = await tenant(),
        store = new HookedStore();
      const f = await sharedUpload(owner, store);
      // It lands on the live file and finds it: its receipt settles 'kept', before any deletion.
      f.send();
      await f.sharing;
      await deleteArtifact(app.db, store, owner, { workUnitId: f.work.id, artifactId: f.first.id });
      expect(store.objects.has(f.key)).toBe(false);
      expect(await blobState(owner, f.first.id)).toBe('purged');
      expect(await claimStates(owner.organizationId, f.key)).toEqual(['proven']);
      expect(await purgeDueBlobs(app.db, store, owner, later())).toEqual({ purged: 0, failed: 0 });
    });

    it('refuses to owe a purged row whose key is not its ordinary one, and changes nothing', async () => {
      const owner = await tenant(),
        store = new HookedStore(),
        writeId = randomUUID();
      // A writer of this test's own, registered while the shared row is still uploading, so the
      // settlement below is the same call the uploader makes after its PUT.
      let mine: boolean | undefined;
      const f = await sharedUpload(owner, store, async (key, body) => {
        mine = await register(owner, idOf(key), writeId, hashOf(body));
      });
      expect(mine).toBe(true);
      await deleteArtifact(app.db, store, owner, { workUnitId: f.work.id, artifactId: f.first.id });
      expect(await blobState(owner, f.first.id)).toBe('purged');
      // No production path gives an ordinary upload row another key: every writer is registered only
      // under tenant/artifacts/id (0539). The generated fixture writes the row an inconsistent repair or
      // restore would leave, as the superuser, so 0544's refusal is reached (0544 lines 70-75).
      const otherKey = objectKey(owner.organizationId, randomUUID());
      const su = new pg.Client({ connectionString: urls.superuser() });
      await su.connect();
      try {
        await inFixtureTenant(su, owner.organizationId, () =>
          su.query(
            `update platform.blob_lifecycle set object_key=$3
             where organization_id=$1 and artifact_id=$2 and state='purged'`,
            [owner.organizationId, f.first.id, otherKey],
          ),
        );
        await expect(settle(owner, f.first.id, writeId)).rejects.toEqual(
          expect.objectContaining({
            cause: expect.objectContaining({ code: 'EN850', message: 'OBJECT_DELETE_UNCONFIRMED' }),
          }),
        );
        // The refusal rolled the whole settlement back: still purged under that key, the writer
        // still registered, and no new claim on either key.
        const row = await su.query<{ state: string; object_key: string; purged: boolean }>(
          `select state, object_key, purged_at is not null as purged from platform.blob_lifecycle
           where organization_id=$1 and artifact_id=$2`,
          [owner.organizationId, f.first.id],
        );
        expect(row.rows).toEqual([{ state: 'purged', object_key: otherKey, purged: true }]);
        const writer = await su.query<{ state: string }>(
          `select state from lifecycle.upload_writes
           where organization_id=$1 and artifact_id=$2 and write_id=$3`,
          [owner.organizationId, f.first.id, writeId],
        );
        expect(writer.rows).toEqual([{ state: 'registered' }]);
      } finally {
        await su.end();
      }
      expect(await claimStates(owner.organizationId, f.key)).toEqual(['proven']);
      expect(await claimStates(owner.organizationId, otherKey)).toEqual([]);
      // The same row under its ordinary key is owed again, so the refusal above is the key's alone.
      const su2 = new pg.Client({ connectionString: urls.superuser() });
      await su2.connect();
      try {
        await inFixtureTenant(su2, owner.organizationId, () =>
          su2.query(
            `update platform.blob_lifecycle set object_key=$3
             where organization_id=$1 and artifact_id=$2 and state='purged'`,
            [owner.organizationId, f.first.id, f.key],
          ),
        );
      } finally {
        await su2.end();
      }
      expect(await settle(owner, f.first.id, writeId)).toBe('owed');
      expect(await blobState(owner, f.first.id)).toBe('deleting');
      // Let the sharing request finish; its own settlement answers on the now-owed row.
      f.send();
      await f.sharing;
    });
  });
});
