import { randomUUID } from 'node:crypto';
import {
  artifacts,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  retentionCursors,
  retentionRules,
  withTenantTx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  deleteArtifact,
  getWorkUnit,
  purgeDueBlobs,
  objectKey,
  transitionWorkUnit,
} from '@ensemus/application';
import {
  createRawFilesRetentionSource,
  listRetentionRules,
  listRetentionRuns,
  setRetentionRule,
  sweepRetention,
} from '@ensemus/application/saas/retention';
import { placeLegalHold } from '@ensemus/application/saas/legal-holds';
import type { RetentionSource } from '@ensemus/application/saas/ports';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urls } from '../helpers/stack';
import {
  lifecycleExpiredArtifact as lifecycleArtifact,
  lifecycleTenant,
  LifecycleMemoryStore,
} from './saas-lifecycle-fixture';

describe('bounded retention with real roles and durable per-record progress', () => {
  const database = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() });
  beforeAll(async () => {
    await auth.connect();
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  const input = () => ({ limit: 1, now: new Date() });
  it('denies members, requires sign-off and retains everything with no rule', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      other = await lifecycleTenant(database.db, auth),
      store = new LifecycleMemoryStore(),
      context = createServiceContext(owner.organizationId);
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .insert(memberships)
        .values({ organizationId: owner.organizationId, userId: other.userId, role: 'member' }),
    );
    const member = await resolveTenantContext(database.db, other.userId, owner.organizationId);
    await expect(listRetentionRules(database.db, member, {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      setRetentionRule(database.db, member, {
        dataCategory: 'raw_files',
        classification: '*',
        retainDays: 1,
        basisRef: 'test-policy',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      setRetentionRule(database.db, owner, {
        dataCategory: 'raw_files',
        classification: '*',
        retainDays: 1,
        basisRef: '',
      }),
    ).rejects.toMatchObject({ code: 'RETENTION_BASIS_REQUIRED' });
    await expect(sweepRetention(database.db, owner, [], input())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const file = await lifecycleArtifact(database.db, owner, store);
    expect(
      await sweepRetention(database.db, context, [createRawFilesRetentionSource(store)], input()),
    ).toEqual([]);
    expect(
      await withTenantTx(database.db, context, (tx) => tx.select().from(artifacts)),
    ).toHaveLength(1);
    expect(await store.exists(objectKey(owner.organizationId, file.artifactId))).toBe(true);
  });
  it('an admin can supersede a rule, but audit and transaction records refuse numeric sweeping', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      person = await lifecycleTenant(database.db, auth);
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .insert(memberships)
        .values({ organizationId: owner.organizationId, userId: person.userId, role: 'admin' }),
    );
    const admin = await resolveTenantContext(database.db, person.userId, owner.organizationId);
    await setRetentionRule(database.db, admin, {
      dataCategory: 'raw_files',
      classification: 'internal',
      retainDays: 1,
      basisRef: randomUUID(),
    });
    await setRetentionRule(database.db, admin, {
      dataCategory: 'raw_files',
      classification: 'internal',
      retainDays: null,
      basisRef: randomUUID(),
    });
    expect(await listRetentionRules(database.db, owner, {})).toHaveLength(1);
    expect(await listRetentionRules(database.db, owner, { history: true })).toHaveLength(2);
    for (const category of ['audit_logs', 'transaction_records'] as const)
      await expect(
        setRetentionRule(database.db, owner, {
          dataCategory: category,
          classification: '*',
          retainDays: 1,
          basisRef: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      await withTenantTx(database.db, owner, (tx) => tx.select().from(retentionRules)),
    ).toHaveLength(2);
  });
  it('continues past a full held page, purges only deleted files, and keeps the other tenant untouched', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      other = await lifecycleTenant(database.db, auth),
      store = new LifecycleMemoryStore(),
      context = createServiceContext(owner.organizationId);
    const held = await lifecycleArtifact(database.db, owner, store),
      free = await lifecycleArtifact(database.db, owner, store);
    await lifecycleArtifact(database.db, other, store);
    await placeLegalHold(database.db, owner, {
      matterRef: randomUUID(),
      scopes: [{ type: 'artifact', id: held.artifactId }],
    });
    await setRetentionRule(database.db, owner, {
      dataCategory: 'raw_files',
      classification: 'internal',
      retainDays: 1,
      basisRef: randomUUID(),
    });
    const source = createRawFilesRetentionSource(store);
    const first = (await sweepRetention(database.db, context, [source], input()))[0]!;
    expect(first).toMatchObject({ examined: 1, held: 1, removed: 0, more: true });
    const second = (await sweepRetention(database.db, context, [source], input()))[0]!;
    expect(second).toMatchObject({ examined: 1, held: 0, removed: 1, more: false });
    expect(
      await withTenantTx(database.db, context, (tx) => tx.select().from(artifacts)),
    ).toHaveLength(1);
    expect(
      await withTenantTx(database.db, other, (tx) => tx.select().from(artifacts)),
    ).toHaveLength(1);
    expect(await store.exists(objectKey(owner.organizationId, free.artifactId))).toBe(true);
    await purgeDueBlobs(database.db, store, context, new Date(Date.now() + 1000));
    expect(await store.exists(objectKey(owner.organizationId, held.artifactId))).toBe(true);
    expect(await store.exists(objectKey(owner.organizationId, free.artifactId))).toBe(false);
  });
  it('advances only an examined failure and revisits it on the next finite cycle', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      store = new LifecycleMemoryStore(),
      context = createServiceContext(owner.organizationId);
    const failed = await lifecycleArtifact(database.db, owner, store),
      free = await lifecycleArtifact(database.db, owner, store);
    await setRetentionRule(database.db, owner, {
      dataCategory: 'raw_files',
      classification: 'internal',
      retainDays: 1,
      basisRef: randomUUID(),
    });
    const raw = createRawFilesRetentionSource(store);
    let refusing = true;
    const source: RetentionSource = {
      ...raw,
      remove: async (tx, ctx, id) => {
        if (id === failed.artifactId && refusing) throw new Error('TEST_SOURCE_FAILURE');
        return raw.remove(tx, ctx, id);
      },
    };
    const first = (
      await sweepRetention(database.db, context, [source], { ...input(), limit: 2 })
    )[0]!;
    expect(first).toMatchObject({
      examined: 1,
      removed: 0,
      more: true,
      outcomeCode: 'RETENTION_SOURCE_FAILED',
    });
    const second = (await sweepRetention(database.db, context, [source], input()))[0]!;
    expect(second).toMatchObject({ examined: 1, removed: 1, more: false });
    expect(
      await withTenantTx(database.db, context, (tx) =>
        tx.select().from(artifacts).where(eq(artifacts.id, free.artifactId)),
      ),
    ).toHaveLength(0);
    refusing = false;
    expect((await sweepRetention(database.db, context, [source], input()))[0]!.removed).toBe(1);
    expect(
      (await listRetentionRuns(database.db, owner)).some(
        (run) => run.outcomeCode === 'RETENTION_SOURCE_FAILED',
      ),
    ).toBe(true);
  });
  it('a changed rule invalidates old cursors, and an unpaged or unavailable source never pretends success', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      store = new LifecycleMemoryStore(),
      context = createServiceContext(owner.organizationId);
    await lifecycleArtifact(database.db, owner, store);
    await lifecycleArtifact(database.db, owner, store);
    await setRetentionRule(database.db, owner, {
      dataCategory: 'raw_files',
      classification: 'internal',
      retainDays: 1,
      basisRef: randomUUID(),
    });
    await sweepRetention(database.db, context, [createRawFilesRetentionSource(store)], input());
    expect(
      await withTenantTx(database.db, context, (tx) => tx.select().from(retentionCursors)),
    ).toHaveLength(1);
    await setRetentionRule(database.db, owner, {
      dataCategory: 'raw_files',
      classification: 'internal',
      retainDays: null,
      basisRef: randomUUID(),
    });
    expect(
      await withTenantTx(database.db, context, (tx) => tx.select().from(retentionCursors)),
    ).toHaveLength(0);
    await setRetentionRule(database.db, owner, {
      dataCategory: 'model_outputs',
      classification: '*',
      retainDays: 1,
      basisRef: randomUUID(),
    });
    expect(
      (await sweepRetention(database.db, context, [], input())).find(
        (row) => row.category === 'model_outputs',
      )?.outcomeCode,
    ).toBe('RETENTION_SOURCE_NOT_WIRED');
    const legacy: RetentionSource = {
      category: 'model_outputs',
      findExpired: async () => [],
      remove: async () => undefined,
    };
    expect(
      (await sweepRetention(database.db, context, [legacy], input())).find(
        (row) => row.category === 'model_outputs',
      )?.outcomeCode,
    ).toBe('RETENTION_SOURCE_NOT_PAGED');
  });
  it('configured expiry reaches completed work while manual deletion and legal holds keep their guards', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      context = createServiceContext(owner.organizationId),
      store = new LifecycleMemoryStore(),
      free = await lifecycleArtifact(database.db, owner, store),
      held = await lifecycleArtifact(database.db, owner, store);
    for (const file of [free, held])
      for (const to of ['ready', 'running', 'verifying', 'completed'] as const) {
        const work = await getWorkUnit(database.db, owner, file.workUnitId);
        await transitionWorkUnit(database.db, owner, {
          id: file.workUnitId,
          expectedVersion: work.version,
          to,
        });
      }
    await expect(
      deleteArtifact(database.db, store, owner, {
        workUnitId: free.workUnitId,
        artifactId: free.artifactId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await placeLegalHold(database.db, owner, {
      matterRef: randomUUID(),
      scopes: [{ type: 'artifact', id: held.artifactId }],
    });
    await setRetentionRule(database.db, owner, {
      dataCategory: 'raw_files',
      classification: 'internal',
      retainDays: 1,
      basisRef: randomUUID(),
    });
    expect(
      (
        await sweepRetention(database.db, context, [createRawFilesRetentionSource(store)], {
          ...input(),
          limit: 2,
        })
      )[0],
    ).toMatchObject({ removed: 1, held: 1 });
    expect((await getWorkUnit(database.db, owner, free.workUnitId)).status).toBe('completed');
    expect(
      await withTenantTx(database.db, context, (tx) =>
        tx.select().from(artifacts).where(eq(artifacts.id, held.artifactId)),
      ),
    ).toHaveLength(1);
  });
});
