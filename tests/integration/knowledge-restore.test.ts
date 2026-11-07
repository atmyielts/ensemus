// Real RLS with a simulated older database: the independent ledger must keep restored sources closed.
import { randomUUID, createHash } from 'node:crypto';
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
import { urls } from '../helpers/stack';
import {
  addGeneratedArtifact,
  eraseDerivedArtifactMetadata,
  type ArtifactInputInventory,
  type DerivedArtifactLifecycle,
} from '../../packages/application/src/knowledge/artifact-provenance';

describe('knowledge source ledger reapply', () => {
  let database: ReturnType<typeof openAppDatabase>, auth: pg.Client, owner: TenantContext;
  const objects = new Map<string, Buffer>();
  const store: ObjectStore & LedgerReader = {
    put: async (key, body) => {
      objects.set(key, Buffer.from(body));
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
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
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
    await store.delete(`${owner.organizationId}/knowledge/${source.documentId}`);
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
      }),
      service = createServiceContext(owner.organizationId),
      body = Buffer.from('Generated exact template text.'),
      execution = {
        kind: 'system' as const,
        id: randomUUID(),
        template: 'test/restore-template/v1',
      };
    const inventory: ArtifactInputInventory = {
      inspectInTx: async (_tx, _context, input) =>
        input.artifactSha256 === createHash('sha256').update(body).digest('hex') &&
        input.workUnitId === work.id &&
        input.execution.id === execution.id
          ? {
              known: true,
              execution: input.execution,
              workUnitId: work.id,
              viewerMembershipId: null,
              classification: 'internal',
              noKnowledge: true,
              artifactInputs: [],
              recordInputs: [
                {
                  kind: 'work_unit',
                  id: work.id,
                  sha256: createHash('sha256').update(JSON.stringify(work)).digest('hex'),
                },
              ],
            }
          : { known: false },
    };
    const artifact = await addGeneratedArtifact(
      database.db,
      store,
      service,
      {
        workUnitId: work.id,
        name: 'restore-template.txt',
        mimeType: 'text/plain',
        body,
        execution,
        requestKey: randomUUID(),
      },
      { inventory },
    );
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
    const lifecycle: DerivedArtifactLifecycle = {
      erase: async (context, input) => {
        // Explicit test-only adapter: all puts have returned, and this in-memory store has no holds.
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
    expect((await perform(lifecycle)).failed).toBe(0);
    expect(await countUnappliedTombstones(database.db, store, owner)).toBe(0);
    expect(await header()).toMatchObject({ restoreReapplyPending: false, writeState: 'fenced' });
    expect((await header()).physicalPurgedAt).toBeInstanceOf(Date);
    const repeated = await perform(lifecycle);
    expect(repeated).toMatchObject({
      failed: 0,
      tombstonesAdded: 0,
      artifactsRemoved: 0,
      bytesRemoved: 0,
    });
  });
});
