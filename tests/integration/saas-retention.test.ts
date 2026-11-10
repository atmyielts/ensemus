import { randomUUID } from 'node:crypto';
import {
  artifacts,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  retentionCursors,
  retentionRules,
  withTenantTx,
  type Tx,
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
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import type { RetentionSource } from '@ensemus/application/saas/ports';
import { eq, sql } from 'drizzle-orm';
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
      free = await lifecycleArtifact(database.db, owner, store),
      untouched = await lifecycleArtifact(database.db, other, store);
    const hold = await placeLegalHold(database.db, owner, {
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
    // 0508 (begin_object_deletion; M8 lifecycle join): any active hold in the tenant conservatively
    // blocks every byte deletion, so while the matter is open even the deleted file's bytes stay.
    expect(await purgeDueBlobs(database.db, store, context, new Date(Date.now() + 1000))).toEqual({
      purged: 0,
      failed: 1,
    });
    expect(await store.exists(objectKey(owner.organizationId, held.artifactId))).toBe(true);
    expect(await store.exists(objectKey(owner.organizationId, free.artifactId))).toBe(true);
    // Once the matter closes, the purge takes only the file retention deleted: the held file was never
    // deleted, and the other tenant's file is untouched.
    await releaseLegalHold(database.db, owner, {
      holdId: hold.holdId,
      reasonCode: 'TEST_MATTER_CLOSED',
      expectedVersion: 1,
    });
    // Past the failed attempt's backoff (PURGE_BACKOFF_BASE_MS, 15 minutes).
    expect(
      await purgeDueBlobs(database.db, store, context, new Date(Date.now() + 16 * 60 * 1000)),
    ).toEqual({ purged: 1, failed: 0 });
    expect(await store.exists(objectKey(owner.organizationId, held.artifactId))).toBe(true);
    expect(await store.exists(objectKey(owner.organizationId, free.artifactId))).toBe(false);
    expect(await store.exists(objectKey(other.organizationId, untouched.artifactId))).toBe(true);
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
  it('racing retention deleters of one expired file serialize without an artifact row lock', async () => {
    // assertArtifactRetentionInTx reads work.artifacts without FOR UPDATE: ensemus_app holds no
    // UPDATE on it (0003), and every locking clause needs one. This shows the lock is not needed:
    // the second deleter waits on the first's locks, then finds the file gone, and exactly one
    // removal, tombstone and deletion event exist. The artifact fields checked are app-immutable.
    const owner = await lifecycleTenant(database.db, auth),
      store = new LifecycleMemoryStore(),
      context = createServiceContext(owner.organizationId),
      target = await lifecycleArtifact(database.db, owner, store),
      spare = await lifecycleArtifact(database.db, owner, store),
      observer = new pg.Client({ connectionString: urls.superuser() });
    await setRetentionRule(database.db, owner, {
      dataCategory: 'raw_files',
      classification: 'internal',
      retainDays: 1,
      basisRef: randomUUID(),
    });
    const raw = createRawFilesRetentionSource(store),
      refusing: RetentionSource = {
        ...raw,
        remove: () => Promise.reject(new Error('TEST_SOURCE_FAILURE')),
      };
    // One refused examination leaves the live, incomplete cursor both deleters check.
    expect((await sweepRetention(database.db, context, [refusing], input()))[0]).toMatchObject({
      examined: 1,
      removed: 0,
      more: true,
    });
    const pidOf = async (tx: Tx) =>
      Number((await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]?.pid);
    const signal = <T>() => {
      let settle!: (value: T) => void;
      const promise = new Promise<T>((resolve) => {
        settle = resolve;
      });
      return { promise, settle };
    };
    const held = signal<void>(),
      firstPid = signal<number>(),
      secondPid = signal<number>(),
      release = () => held.settle(undefined),
      firstRemoved = firstPid.settle,
      secondStarted = secondPid.settle;
    await observer.connect();
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
    try {
      first = withTenantTx(database.db, context, async (tx) => {
        const pid = await pidOf(tx);
        await raw.remove(tx, context, target.artifactId);
        firstRemoved(pid);
        await held.promise;
      });
      // A first deleter that fails surfaces its own error here instead of a hung wait.
      const holder = await Promise.race([firstPid.promise, first.then(() => Number.NaN)]);
      second = withTenantTx(database.db, context, async (tx) => {
        secondStarted(await pidOf(tx));
        await raw.remove(tx, context, target.artifactId);
      }).then(
        () => 'removed twice',
        (error: unknown) => error,
      );
      const waiter = await secondPid.promise;
      let blocked = false;
      for (let attempt = 0; attempt < 200 && !blocked; attempt += 1) {
        blocked = (
          await observer.query<{ blocked: boolean }>(
            'select $1::int = any(pg_blocking_pids($2::int)) as blocked',
            [holder, waiter],
          )
        ).rows[0]!.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);
      release();
      await first;
      expect(await second).toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      release();
      await first?.catch(() => undefined);
      await second;
    }
    try {
      const count = async (text: string) =>
        Number(
          (await observer.query<{ n: string }>(text, [owner.organizationId, target.artifactId]))
            .rows[0]!.n,
        );
      expect(
        await count('select count(*) as n from work.artifacts where organization_id=$1 and id=$2'),
      ).toBe(0);
      expect(
        (
          await observer.query(
            "select reason_code from platform.tombstones where organization_id=$1 and target_type='artifact' and target_id=$2",
            [owner.organizationId, target.artifactId],
          )
        ).rows,
      ).toEqual([{ reason_code: 'RETENTION_EXPIRED' }]);
      expect(
        await count(
          "select count(*) as n from platform.domain_events where organization_id=$1 and event_type='work.artifact_deleted' and payload->>'artifact_id'=$2::text",
        ),
      ).toBe(1);
      expect(
        await withTenantTx(database.db, context, (tx) =>
          tx.select().from(artifacts).where(eq(artifacts.id, spare.artifactId)),
        ),
      ).toHaveLength(1);
    } finally {
      await observer.end();
    }
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
