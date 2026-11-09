// Real RLS with a simulated older database: the independent ledger must keep restored sources closed.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  addArtifact,
  countUnappliedTombstones,
  createRestoreGate,
  createWorkUnit,
  readArtifact,
  reapplyTombstoneLedger,
  requalifyGeneratedRestoreDebt,
  requestExecution,
  transitionWorkUnit,
  type LedgerReader,
  type ObjectStore,
} from '@ensemus/application';
import { addUploadedSource, getSource } from '@ensemus/application/knowledge/sources';
import {
  createOrganization,
  artifactLineage,
  artifacts,
  blobLifecycle,
  knowledgeSources,
  openAppDatabase,
  resolveTenantContext,
  tombstones,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  ledgerKeyFor,
  ledgerRef,
  serializeLedgerEntry,
  type LedgerEntry,
} from '@ensemus/domain/tombstone-ledger';
import { eq, sql } from 'drizzle-orm';
import { pgCode } from '../../packages/application/src/errors';
import { urls } from '../helpers/stack';
import { nativeKnowledgeStore } from '../helpers/knowledge-native';
import {
  eraseDerivedArtifactMetadata,
  type DerivedArtifactLifecycle,
} from '../../packages/application/src/knowledge/artifact-provenance';
import { createObjectDeletionLifecycle } from '../../packages/application/src/saas/object-deletion';
import { createActivities } from '@ensemus/workflows/activities';

/**
 * The memory transport under the runtime's native raw Knowledge port (0516), as apps/web and the
 * worker compose theirs: an upload's raw bytes go only through SQL admission and its single-attempt
 * PUT. It keeps the ledger listing and exposes no purge or physical-absence capability.
 */
function ledgerTransport(objects: Map<string, Buffer>): ObjectStore & LedgerReader {
  return {
    put: async (key, body) => {
      objects.set(key, Buffer.from(body));
    },
    putSingleAttempt: async (key, body) => {
      objects.set(key, Buffer.from(body));
      return { transport: 'written' };
    },
    get: async (key) => {
      const body = objects.get(key);
      if (!body) throw new Error('MISSING');
      return body;
    },
    delete: async (key) => {
      objects.delete(key);
    },
    exists: async (key) => objects.has(key),
    async *listPages(prefix) {
      yield [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

describe('knowledge source ledger reapply', () => {
  let database: ReturnType<typeof openAppDatabase>, auth: pg.Client, owner: TenantContext;
  const objects = new Map<string, Buffer>();
  const transport = ledgerTransport(objects);
  let store: ObjectStore & LedgerReader;
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    store = nativeKnowledgeStore(database.db, transport);
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const userId = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
      userId,
      'Generated restore owner',
      `${userId}@example.invalid`,
    ]);
    const org = await createOrganization(database.db, {
      userId,
      name: 'Generated restore company',
      commercialMode: 'sovereign',
    });
    owner = await resolveTenantContext(database.db, userId, org.organizationId);
  });
  afterAll(async () => {
    await auth?.end();
    await database?.close();
  });
  const fixture = async () => {
    const source = await addUploadedSource(database.db, store, owner, {
      title: 'Generated restored source',
      mediaType: 'text/plain',
      body: Buffer.from('Generated whole surviving source.'),
      classification: 'internal',
      grants: [],
    });
    const entry: LedgerEntry = {
      organizationId: owner.organizationId,
      targetType: 'knowledge_source',
      targetId: source.sourceId,
      deletedAt: new Date(),
    };
    await store.put(ledgerKeyFor(entry), serializeLedgerEntry(entry), 'application/json');
    return { ...source, entry };
  };
  const reapply = (confirmed?: ReadonlySet<string>) =>
    reapplyTombstoneLedger(
      database.db,
      store,
      createServiceContext,
      (error) => {
        throw error;
      },
      confirmed ? { confirmed } : {},
    );
  it('keeps serving closed and requires confirmation when both restored rows and bytes survive', async () => {
    const source = await fixture();
    expect(await countUnappliedTombstones(database.db, store, owner)).toBe(1);
    const gate = createRestoreGate({ database: database.db, store });
    await expect(gate.assertServing(owner)).rejects.toEqual(new AppError('RESTORE_PENDING'));
    const waiting = await reapply();
    expect(waiting.unconfirmed).toBe(1);
    expect(waiting.tombstonesAdded).toBe(0);
    expect((await getSource(database.db, owner, source.sourceId)).state).toBe('active');
    const applied = await reapply(new Set([ledgerRef(source.entry)]));
    expect(applied).toMatchObject({ tombstonesAdded: 1, knowledgeSourcesClosed: 1, failed: 0 });
    expect(await countUnappliedTombstones(database.db, store, owner)).toBe(0);
    const [row] = await withTenantTx(
      database.db,
      createServiceContext(owner.organizationId),
      (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, source.sourceId)),
    );
    expect(row?.state).toBe('deleted');
    const again = await reapply();
    expect(again.tombstonesAdded).toBe(0);
    expect(again.knowledgeSourcesClosed).toBe(0);
  });
  it('automatically closes a restored source when its already-deleted bytes do not survive', async () => {
    const source = await fixture();
    // The bytes vanish in storage itself; the native port refuses any raw delete outside a purge.
    objects.delete(`${owner.organizationId}/knowledge/${source.documentId}`);
    const applied = await reapply();
    expect(applied).toMatchObject({ unconfirmed: 0, tombstonesAdded: 1, failed: 0 });
    const [mark] = await withTenantTx(
      database.db,
      createServiceContext(owner.organizationId),
      (tx) => tx.select().from(tombstones).where(eq(tombstones.targetId, source.sourceId)),
    );
    expect(mark?.createdAt).toEqual(source.entry.deletedAt);
    expect((await getSource(database.db, owner, source.sourceId)).state).toBe('deleted');
  });
  it('requires confirmation for an ordinary private file hidden from the service serving path', async () => {
    const work = await createWorkUnit(database.db, owner, {
      title: 'Private restored attachment',
      objective: 'Retain the private file until restore confirmation.',
      classification: 'restricted',
    });
    const artifact = await addArtifact(database.db, store, owner, {
      workUnitId: work.id,
      name: 'private-restored.txt',
      mimeType: 'text/plain',
      body: Buffer.from('Private restore fixture.'),
    });
    const service = createServiceContext(owner.organizationId);
    expect(
      await withTenantTx(database.db, service, (tx) =>
        tx.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, artifact.id)),
      ),
    ).toEqual([]);
    const metadata = (context: TenantContext) =>
      withTenantTx(database.db, context, (tx) =>
        tx.execute<{ objectKey: string; workUnitIds: string[]; removed: boolean }>(
          sql`select object_key as "objectKey",work_unit_ids as "workUnitIds",removed
            from knowledge.restore_ordinary_artifact_metadata(${artifact.id}::uuid)`,
        ),
      );
    await expect(metadata(owner)).rejects.toThrow();
    expect((await metadata(service)).rows).toEqual([
      {
        objectKey: `${owner.organizationId}/artifacts/${artifact.id}`,
        workUnitIds: [work.id],
        removed: false,
      },
    ]);
    const entry: LedgerEntry = {
      organizationId: owner.organizationId,
      targetType: 'artifact',
      targetId: artifact.id,
      deletedAt: new Date(),
    };
    await store.put(ledgerKeyFor(entry), serializeLedgerEntry(entry), 'application/json');
    const waiting = await reapply();
    expect(waiting).toMatchObject({ unconfirmed: 1, artifactsRemoved: 0, bytesRemoved: 0 });
    expect(
      await readArtifact(database.db, store, owner, {
        workUnitId: work.id,
        artifactId: artifact.id,
      }),
    ).toMatchObject({ body: Buffer.from('Private restore fixture.') });
    const applied = await reapply(new Set([ledgerRef(entry)]));
    expect(applied).toMatchObject({
      unconfirmed: 0,
      artifactsRemoved: 1,
      bytesRemoved: 1,
      failed: 0,
    });
    expect((await metadata(service)).rows).toEqual([]);
    expect(objects.has(`${owner.organizationId}/artifacts/${artifact.id}`)).toBe(false);
  });
  it('keeps a restored generated deletion pending across missing, held and unconfirmed lifecycle proof', async () => {
    const work = await createWorkUnit(database.db, owner, {
        title: 'Generated restore work',
        objective: 'Check a synthetic template output.',
        classification: 'internal',
        executionPlan: 'checklist',
      }),
      service = createServiceContext(owner.organizationId);
    // 0419: the only explicit no-knowledge system output is the exact M2 completion checklist of a
    // Work its run holds (knowledge.known_checklist_authority); a claimed template label or body is
    // refused at lineage birth. So this generated file comes from the real plan and its activity.
    await transitionWorkUnit(database.db, owner, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    await requestExecution(database.db, owner, work.id);
    const run = { organizationId: owner.organizationId, workUnitId: work.id, runId: randomUUID() },
      activities = createActivities({ database: database.db, store });
    expect(await activities.prepareWork(run)).toMatchObject({ status: 'running' });
    const artifact = { id: (await activities.produceChecklistArtifact(run)).artifactId };
    const entry: LedgerEntry = {
      organizationId: owner.organizationId,
      targetType: 'artifact',
      targetId: artifact.id,
      deletedAt: new Date(),
    };
    for (const apply of [false, true])
      await expect(
        withTenantTx(database.db, service, (tx) =>
          tx.execute(sql`select * from knowledge.restore_ordinary_artifact_metadata(
            ${artifact.id}::uuid,${apply},ARRAY[${work.id}::uuid])`),
        ),
      ).rejects.toThrow();
    expect(objects.has(`${owner.organizationId}/artifacts/${artifact.id}`)).toBe(true);
    await store.put(ledgerKeyFor(entry), serializeLedgerEntry(entry), 'application/json');
    const failures: unknown[] = [];
    const confirmed = new Set([ledgerRef(entry)]),
      perform = (derivedArtifacts?: DerivedArtifactLifecycle) =>
        reapplyTombstoneLedger(
          database.db,
          store,
          createServiceContext,
          (error) => failures.push(error),
          {
            confirmed,
            ...(derivedArtifacts ? { derivedArtifacts } : {}),
          },
        );
    const unknown = await perform();
    expect(unknown.failed).toBe(1);
    // Missing lifecycle proof is the intended refusal, after the serving barrier has committed.
    // An earlier SQL failure must not masquerade as the same closed restore result.
    expect(failures).toEqual([new AppError('INVALID_STATE')]);
    expect(await countUnappliedTombstones(database.db, store, owner)).toBe(1);
    await expect(
      createRestoreGate({ database: database.db, store }).assertServing(owner),
    ).rejects.toEqual(new AppError('RESTORE_PENDING'));
    await expect(
      readArtifact(database.db, store, owner, { workUnitId: work.id, artifactId: artifact.id }),
    ).rejects.toThrow();
    const header = () =>
      withTenantTx(
        database.db,
        service,
        async (tx) =>
          (
            await tx
              .select()
              .from(artifactLineage)
              .where(eq(artifactLineage.artifactId, artifact.id))
          )[0]!,
      );
    expect((await header()).restoreReapplyPending).toBe(true);
    for (const context of [owner, service])
      await expect(
        withTenantTx(database.db, context, (tx) =>
          tx
            .update(artifactLineage)
            .set({ restoreReapplyPending: false })
            .where(eq(artifactLineage.artifactId, artifact.id)),
        ),
      ).rejects.toThrow();
    await expect(
      withTenantTx(database.db, service, (tx) =>
        tx.delete(artifactLineage).where(eq(artifactLineage.artifactId, artifact.id)),
      ),
    ).rejects.toThrow();
    expect((await perform({ erase: async () => ({ state: 'held' }) })).failed).toBe(1);
    // Byte absence alone says nothing about the old writer; the pending restore must survive it.
    const key = (await header()).objectKey;
    await store.delete(key);
    expect((await perform({ erase: async () => ({ state: 'unconfirmed' }) })).failed).toBe(1);
    expect(await countUnappliedTombstones(database.db, store, owner)).toBe(1);
    // 0508 and the M8 lifecycle join source: a generated restore-pending marker is retained restore
    // debt (lifecycle.object_restore_debts), and it "stays nonqualifying until real restore/provider
    // quiescence authority exists. There is no app/eraser debt-clearing grant." So not even the
    // production lifecycle, with a purge-capable unversioned store, may admit this deletion
    // (begin_object_deletion refuses a restore_reapply_pending header) ...
    const purgeCapable: ObjectStore = {
      ...transport,
      deleteForPurge: async (objectKey) => {
        objects.delete(objectKey);
        return { transport: 'deleted', capabilityVerified: true };
      },
      isPhysicallyAbsent: async (objectKey) => !objects.has(objectKey),
    };
    const production = createObjectDeletionLifecycle({
      database: database.db,
      store: purgeCapable,
    });
    expect((await perform(production.derived)).failed).toBe(1);
    // ... and an adapter that only claims quiescence after erasing metadata and marking the blob
    // purged by hand cannot certify the removal either (0508 lineage_0508_physical_receipt).
    const claiming: DerivedArtifactLifecycle = {
      erase: async (context, input) => {
        await eraseDerivedArtifactMetadata(database.db, context, input);
        await store.delete(input.objectKey);
        await withTenantTx(database.db, context, (tx) =>
          tx
            .update(blobLifecycle)
            .set({ state: 'purged', purgedAt: new Date() })
            .where(eq(blobLifecycle.artifactId, input.artifactId)),
        );
        return { state: 'purged', quiescent: true };
      },
    };
    expect((await perform(claiming)).failed).toBe(1);
    // The deletion stays pending and owed, and the restore gate stays closed.
    expect(await countUnappliedTombstones(database.db, store, owner)).toBe(1);
    expect(await header()).toMatchObject({ restoreReapplyPending: true, physicalPurgedAt: null });
    await expect(
      createRestoreGate({ database: database.db, store }).assertServing(owner),
    ).rejects.toEqual(new AppError('RESTORE_PENDING'));
    const owed = await withTenantTx(database.db, service, (tx) =>
      tx.execute<{ unconfirmed: number }>(
        sql`select unconfirmed from lifecycle.object_delete_counts()`,
      ),
    );
    expect(owed.rows[0]?.unconfirmed).toBeGreaterThan(0);
    // 0543 gives this debt a way out: the operator's per-object re-proof after an admitted restore.
    // A person cannot give it, and it is no deletion proof: the bytes are observed absent (they were
    // removed above), the proof is recorded, and still the hand-marked purge certifies nothing. The
    // header stays pending and the tenant stays closed until the ordinary lifecycle proves a DELETE,
    // which the hand-marked blob row now refuses to admit.
    await expect(
      requalifyGeneratedRestoreDebt(database.db, purgeCapable, owner, artifact.id),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    await expect(
      withTenantTx(database.db, owner, (tx) =>
        tx.execute(
          sql`select lifecycle.requalify_object_restore_debt(${artifact.id}::uuid,'absent')`,
        ),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    expect(
      await requalifyGeneratedRestoreDebt(database.db, purgeCapable, service, artifact.id),
    ).toEqual({ state: 'requalified', observed: 'absent' });
    expect((await perform(claiming)).failed).toBe(1);
    expect((await perform(production.derived)).failed).toBe(1);
    expect(await countUnappliedTombstones(database.db, store, owner)).toBe(1);
    expect(await header()).toMatchObject({ restoreReapplyPending: true, physicalPurgedAt: null });
    await expect(
      createRestoreGate({ database: database.db, store }).assertServing(owner),
    ).rejects.toEqual(new AppError('RESTORE_PENDING'));
  });

  it('purges a restored generated deletion once its restore debt is requalified, and only then', async () => {
    // Its own tenant and bucket: the tenant above stays closed on purpose, and the ledger is global.
    const bucket = new Map<string, Buffer>();
    const transport: ObjectStore & LedgerReader = {
      ...ledgerTransport(bucket),
      deleteForPurge: async (objectKey) => {
        bucket.delete(objectKey);
        return { transport: 'deleted', capabilityVerified: true };
      },
      isPhysicallyAbsent: async (objectKey) => !bucket.has(objectKey),
    };
    const local = nativeKnowledgeStore(database.db, transport);
    const userId = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
      userId,
      'Generated requalification owner',
      `${userId}@example.invalid`,
    ]);
    const org = await createOrganization(database.db, {
      userId,
      name: 'Generated requalified company',
      commercialMode: 'sovereign',
    });
    const tenant = await resolveTenantContext(database.db, userId, org.organizationId);
    const service = createServiceContext(tenant.organizationId);
    const work = await createWorkUnit(database.db, tenant, {
      title: 'Generated requalification work',
      objective: 'Check a synthetic template output.',
      classification: 'internal',
      executionPlan: 'checklist',
    });
    await transitionWorkUnit(database.db, tenant, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    await requestExecution(database.db, tenant, work.id);
    const run = { organizationId: tenant.organizationId, workUnitId: work.id, runId: randomUUID() },
      activities = createActivities({ database: database.db, store: local });
    expect(await activities.prepareWork(run)).toMatchObject({ status: 'running' });
    const artifactId = (await activities.produceChecklistArtifact(run)).artifactId;
    const key = `${tenant.organizationId}/artifacts/${artifactId}`;
    expect(bucket.has(key)).toBe(true);
    const entry: LedgerEntry = {
      organizationId: tenant.organizationId,
      targetType: 'artifact',
      targetId: artifactId,
      deletedAt: new Date(),
    };
    await local.put(ledgerKeyFor(entry), serializeLedgerEntry(entry), 'application/json');
    const production = createObjectDeletionLifecycle({ database: database.db, store: transport });
    const failures: unknown[] = [];
    const perform = (derivedArtifacts?: DerivedArtifactLifecycle) =>
      reapplyTombstoneLedger(
        database.db,
        local,
        createServiceContext,
        (error) => failures.push(error),
        {
          confirmed: new Set([ledgerRef(entry)]),
          ...(derivedArtifacts ? { derivedArtifacts } : {}),
        },
      );
    const header = () =>
      withTenantTx(
        database.db,
        service,
        async (tx) =>
          (
            await tx
              .select()
              .from(artifactLineage)
              .where(eq(artifactLineage.artifactId, artifactId))
          )[0]!,
      );
    const owed = async () =>
      (
        await withTenantTx(database.db, service, (tx) =>
          tx.execute<{ unconfirmed: number }>(
            sql`select unconfirmed from lifecycle.object_delete_counts()`,
          ),
        )
      ).rows[0]?.unconfirmed;
    // The restored deletion: the serving barrier commits and the lifecycle binding is missing.
    expect((await perform()).failed).toBe(1);
    expect(await header()).toMatchObject({ restoreReapplyPending: true, physicalPurgedAt: null });

    // (a) Before the re-proof the debt blocks the production lifecycle, keeps the deletion owed in
    // every source purge's completion check (purge_jobs_0508_delete_proof) and the tenant closed.
    expect((await perform(production.derived)).failed).toBe(1);
    expect(bucket.has(key)).toBe(true);
    expect(await owed()).toBeGreaterThan(0);
    expect(await countUnappliedTombstones(database.db, local, tenant)).toBe(1);
    await expect(
      createRestoreGate({ database: database.db, store: local }).assertServing(tenant),
    ).rejects.toEqual(new AppError('RESTORE_PENDING'));
    // Only an object that carries this debt can be requalified, and only by the service.
    await expect(
      withTenantTx(database.db, service, (tx) =>
        tx.execute(
          sql`select lifecycle.requalify_object_restore_debt(${randomUUID()}::uuid,'absent')`,
        ),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
    await expect(
      withTenantTx(database.db, service, (tx) =>
        tx.execute(sql`select lifecycle.requalify_object_restore_debt(${artifactId}::uuid,'gone')`),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      requalifyGeneratedRestoreDebt(database.db, transport, tenant, artifactId),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    // A store that cannot certify physical absence observes nothing and records nothing.
    expect(
      await requalifyGeneratedRestoreDebt(
        database.db,
        ledgerTransport(bucket),
        service,
        artifactId,
      ),
    ).toEqual({ state: 'unconfirmed' });
    expect((await perform(production.derived)).failed).toBe(1);

    // (b) The re-proof: the bytes survived the restore, which is what the observation records. Twice
    // is the same proof. The ordinary lifecycle then admits, deletes and proves the object, which
    // clears the header (0210) and opens the tenant.
    expect(
      await requalifyGeneratedRestoreDebt(database.db, transport, service, artifactId),
    ).toEqual({ state: 'requalified', observed: 'present' });
    expect(
      await requalifyGeneratedRestoreDebt(database.db, transport, service, artifactId),
    ).toEqual({ state: 'requalified', observed: 'present' });
    failures.length = 0;
    expect(await perform(production.derived)).toMatchObject({
      failed: 0,
      unconfirmed: 0,
      artifactsRemoved: 1,
      bytesRemoved: 1,
    });
    expect(failures).toEqual([]);
    expect(bucket.has(key)).toBe(false);
    const purged = await header();
    expect(purged.restoreReapplyPending).toBe(false);
    expect(purged.physicalPurgedAt).not.toBeNull();
    expect(await owed()).toBe(0);
    expect(await countUnappliedTombstones(database.db, local, tenant)).toBe(0);
    await expect(
      createRestoreGate({ database: database.db, store: local }).assertServing(tenant),
    ).resolves.toBeUndefined();
    // Re-applying an entry that is already applied changes nothing, even with no lifecycle binding.
    expect(await perform()).toMatchObject({
      failed: 0,
      unconfirmed: 0,
      tombstonesAdded: 0,
      artifactsRemoved: 0,
      bytesRemoved: 0,
    });
    expect(failures).toEqual([]);
  });
});
