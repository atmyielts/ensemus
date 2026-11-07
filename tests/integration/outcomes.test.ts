import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { openAppDatabase, withTenantTx, workUnits, domainEvents } from '@ensemus/database';
import { outcomeDrafts, outcomeWorkBirths } from '@ensemus/database/product';
import { createServiceContext } from '@ensemus/database/service';
import {
  composeOutcome,
  getOutcomeDraft,
  listMyOutcomeDrafts,
  reviseOutcomeDraft,
  authorizeOutcome,
  discardOutcome,
  outcomeWorkObjective,
} from '@ensemus/application/outcomes';
import { disableMember, createWorkUnit } from '@ensemus/application';
import { canonicalJson } from '@ensemus/domain/approval';
import { and, eq, sql } from 'drizzle-orm';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../packages/database/src/schema';
import { AppDatabase } from '../../packages/database/src/tenant';
import { databaseInTransaction } from '../../packages/application/src/transaction-database';
import { pgCode } from '../../packages/application/src/errors';
import { createWorkUnitInTx } from '../../packages/application/src/work';
describe('previewed outcomes through actual native tenant roles', () => {
  let app: ReturnType<typeof openAppDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app(), { max: 3 });
  });
  afterAll(async () => {
    await app?.close();
  });
  const compose = (context: Parameters<typeof composeOutcome>[1]) =>
    composeOutcome(app.db, context, {
      objective: 'Prepare a source-backed report by Friday',
      today: '2026-11-06',
    });
  it('allows an actual member draft, keeps it author-only even from an admin, and starts nothing', async () => {
    const { a, b } = await makeTwoTenants(app.db),
      draft = await compose(a.member.context);
    expect(draft.preview.classification).toBe('restricted');
    expect(draft.preview.dueAt).toBe('2026-11-13');
    for (const context of [a.owner.context, a.admin.context, b.owner.context])
      await expect(getOutcomeDraft(app.db, context, draft.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    expect((await listMyOutcomeDrafts(app.db, a.owner.context)).map((d) => d.id)).not.toContain(
      draft.id,
    );
    await withTenantTx(app.db, a.member.context, async (tx) => {
      expect(await tx.select().from(workUnits)).toHaveLength(0);
      expect(
        await tx
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.eventType, 'outcome.authorized')),
      ).toHaveLength(0);
      expect((await tx.execute(sql`select count(*)::int n from ai.agent_runs`)).rows[0]).toEqual({
        n: 0,
      });
    });
  });
  it('refuses worker impersonation and direct SQL author forgery', async () => {
    const { a } = await makeTwoTenants(app.db);
    await expect(compose(createServiceContext(a.organizationId))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const draft = await compose(a.member.context);
    await expect(
      withTenantTx(app.db, a.member.context, (tx) =>
        tx.insert(outcomeDrafts).values({
          organizationId: a.organizationId,
          objective: 'Forged owner',
          preview: draft.preview,
          previewSha256: draft.previewSha256,
          previewCanonical: canonicalJson(draft.preview),
          createdByMembershipId: a.owner.context.membershipId,
        }),
      ),
    ).rejects.toThrow();
  });
  it('binds a new hash/version to corrections, and stale confirmation cannot create Work', async () => {
    const { a } = await makeTwoTenants(app.db),
      draft = await compose(a.member.context),
      changed = await reviseOutcomeDraft(app.db, a.member.context, {
        draftId: draft.id,
        expectedVersion: draft.version,
        preview: { ...draft.preview, title: 'Explicitly revised title' },
      });
    expect(changed.previewSha256).not.toBe(draft.previewSha256);
    await expect(
      authorizeOutcome(app.db, a.member.context, {
        draftId: draft.id,
        expectedVersion: draft.version,
        previewSha256: draft.previewSha256,
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_CHANGED' });
    await withTenantTx(app.db, a.member.context, async (tx) =>
      expect(await tx.select().from(workUnits)).toHaveLength(0),
    );
  });
  it('creates exactly one real Work under concurrent confirmation and repeats without another effect', async () => {
    const { a } = await makeTwoTenants(app.db),
      draft = await compose(a.member.context),
      input = {
        draftId: draft.id,
        expectedVersion: draft.version,
        previewSha256: draft.previewSha256,
      };
    const [first, second] = await Promise.all([
      authorizeOutcome(app.db, a.member.context, input),
      authorizeOutcome(app.db, a.member.context, input),
    ]);
    expect(first).toEqual(second);
    await withTenantTx(app.db, a.member.context, async (tx) => {
      const rows = await tx.select().from(workUnits);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: first.workUnitId,
        title: draft.preview.title,
        classification: 'restricted',
        status: 'queued',
        executionPlan: null,
      });
      expect(rows[0]?.objective).toContain(
        'File attached; a person checks the requested name and content',
      );
      const events = await tx
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.eventType, 'outcome.authorized'));
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]?.payload)).not.toContain(draft.objective);
    });
    await expect(
      reviseOutcomeDraft(app.db, a.member.context, {
        draftId: draft.id,
        expectedVersion: 2,
        preview: draft.preview,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('rolls back Work and authorization together when a dependency is not readable', async () => {
    const { a, b } = await makeTwoTenants(app.db),
      draft = await compose(a.member.context),
      foreign = await compose(b.member.context),
      foreignWork = await authorizeOutcome(app.db, b.member.context, {
        draftId: foreign.id,
        expectedVersion: foreign.version,
        previewSha256: foreign.previewSha256,
      });
    await expect(
      reviseOutcomeDraft(app.db, a.member.context, {
        draftId: draft.id,
        expectedVersion: 1,
        preview: { ...draft.preview, dependencyWorkUnitIds: [foreignWork.workUnitId] },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const prerequisite = await createWorkUnit(app.db, a.owner.context, {
        title: 'Initially readable dependency',
        classification: 'internal',
      }),
      prepared = await reviseOutcomeDraft(app.db, a.member.context, {
        draftId: draft.id,
        expectedVersion: 1,
        preview: { ...draft.preview, dependencyWorkUnitIds: [prerequisite.id] },
      });
    await withTenantTx(app.db, a.owner.context, (tx) =>
      tx
        .update(workUnits)
        .set({
          classification: 'restricted',
          version: prerequisite.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(workUnits.id, prerequisite.id)),
    );
    await expect(
      authorizeOutcome(app.db, a.member.context, {
        draftId: prepared.id,
        expectedVersion: prepared.version,
        previewSha256: prepared.previewSha256,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await getOutcomeDraft(app.db, a.member.context, draft.id)).status).toBe('draft');
    await withTenantTx(app.db, a.member.context, async (tx) =>
      expect(
        await tx
          .select()
          .from(workUnits)
          .where(eq(workUnits.createdByMembershipId, a.member.context.membershipId)),
      ).toHaveLength(0),
    );
  });
  it('refuses direct SQL false hashes and false Work references', async () => {
    const { a } = await makeTwoTenants(app.db),
      draft = await compose(a.member.context);
    await expect(
      withTenantTx(app.db, a.member.context, (tx) =>
        tx
          .update(outcomeDrafts)
          .set({ previewSha256: 'a'.repeat(64), version: 2 })
          .where(eq(outcomeDrafts.id, draft.id)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(app.db, a.member.context, (tx) =>
        tx.execute(
          sql`update experience.outcome_drafts set status='authorized',work_unit_id='00000000-0000-4000-8000-000000000099',authorized_by_membership_id=${a.member.context.membershipId}::uuid,authorized_at=now(),version=version+1 where id=${draft.id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });
  it('rolls back actual kernel Work, events and draft authorization after a final SQL write fault', async () => {
    const { a } = await makeTwoTenants(app.db),
      draft = await compose(a.member.context),
      pool = new pg.Pool({ connectionString: urls.app(), max: 1 });
    let reachedWrite = false;
    pool.on('connect', (client) => {
      client.query = new Proxy(client.query, {
        apply(target, receiver, args) {
          const query = args[0] as string | { text?: string },
            text = typeof query === 'string' ? query : (query.text ?? '');
          if (!reachedWrite && /^update\s+"experience"\."outcome_drafts"\s/i.test(text)) {
            reachedWrite = true;
            return Promise.reject(new Error('OWNED_OUTCOME_WRITE_FAULT'));
          }
          return Reflect.apply(target, receiver, args);
        },
      });
    });
    const failing = new AppDatabase(drizzle(pool, { schema, casing: 'snake_case' }));
    try {
      await expect(
        authorizeOutcome(failing, a.member.context, {
          draftId: draft.id,
          expectedVersion: draft.version,
          previewSha256: draft.previewSha256,
        }),
      ).rejects.toThrow('OWNED_OUTCOME_WRITE_FAULT');
      expect(reachedWrite).toBe(true);
    } finally {
      await pool.end();
    }
    expect(await getOutcomeDraft(app.db, a.member.context, draft.id)).toMatchObject({
      status: 'draft',
      version: 1,
      workUnitId: null,
    });
    await withTenantTx(app.db, a.member.context, async (tx) => {
      expect(await tx.select().from(workUnits)).toHaveLength(0);
      expect(await tx.select().from(domainEvents)).toHaveLength(0);
    });
    expect(
      (
        await authorizeOutcome(app.db, a.member.context, {
          draftId: draft.id,
          expectedVersion: 1,
          previewSha256: draft.previewSha256,
        })
      ).workUnitId,
    ).toBeTruthy();
  });
  it('refuses adoption of a previously created identical Work, even with the same request key', async () => {
    const { a } = await makeTwoTenants(app.db),
      draft = await compose(a.member.context),
      p = draft.preview;
    const earlier = await createWorkUnit(app.db, a.member.context, {
      title: p.title,
      objective: outcomeWorkObjective(p),
      ownerMembershipId: p.ownerMembershipId,
      classification: p.classification,
      dueAt: new Date(p.dueAt + 'T00:00:00.000Z'),
      completionCriteria: [{ kind: 'artifact_exists' }],
      requestKey: draft.id,
    });
    await expect(
      authorizeOutcome(app.db, a.member.context, {
        draftId: draft.id,
        expectedVersion: draft.version,
        previewSha256: draft.previewSha256,
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_CHANGED' });
    expect(await getOutcomeDraft(app.db, a.member.context, draft.id)).toMatchObject({
      status: 'draft',
      workUnitId: null,
      version: 1,
    });
    await withTenantTx(app.db, a.member.context, async (tx) => {
      expect((await tx.select().from(workUnits)).map((w) => w.id)).toEqual([earlier.id]);
      expect(
        await tx
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.eventType, 'outcome.authorized')),
      ).toHaveLength(0);
    });
  });
  it('refuses same-outer-transaction Work adoption without an actual scoped INSERT birth receipt', async () => {
    const { a } = await makeTwoTenants(app.db),
      draft = await compose(a.member.context),
      p = draft.preview;
    let returnedFromAuthorization = false;
    try {
      await withTenantTx(app.db, a.member.context, async (tx) => {
        const joined = databaseInTransaction(tx);
        await createWorkUnit(joined, a.member.context, {
          title: p.title,
          objective: outcomeWorkObjective(p),
          ownerMembershipId: p.ownerMembershipId,
          classification: p.classification,
          dueAt: new Date(p.dueAt + 'T00:00:00.000Z'),
          completionCriteria: [{ kind: 'artifact_exists' }],
          requestKey: draft.id,
        });
        await authorizeOutcome(joined, a.member.context, {
          draftId: draft.id,
          expectedVersion: draft.version,
          previewSha256: draft.previewSha256,
        });
        returnedFromAuthorization = true;
      });
      throw new Error('UNBOUND_SAME_TRANSACTION_WORK_WAS_ADOPTED');
    } catch (error) {
      expect(pgCode(error)).toBe('EN413');
    }
    expect(returnedFromAuthorization).toBe(true);
    expect(await getOutcomeDraft(app.db, a.member.context, draft.id)).toMatchObject({
      status: 'draft',
      version: 1,
      workUnitId: null,
    });
    await withTenantTx(app.db, a.member.context, async (tx) => {
      expect(await tx.select().from(workUnits)).toHaveLength(0);
      expect(await tx.select().from(outcomeWorkBirths)).toHaveLength(0);
    });
  });
  it('creates a protected immutable receipt only for the actual confirming Work INSERT', async () => {
    const { a } = await makeTwoTenants(app.db),
      draft = await compose(a.member.context),
      result = await authorizeOutcome(app.db, a.member.context, {
        draftId: draft.id,
        expectedVersion: 1,
        previewSha256: draft.previewSha256,
      });
    await withTenantTx(app.db, a.member.context, async (tx) => {
      const [birth] = await tx.select().from(outcomeWorkBirths);
      expect(birth).toMatchObject({
        draftId: draft.id,
        workUnitId: result.workUnitId,
        previewVersion: 1,
        previewSha256: draft.previewSha256,
        createdByMembershipId: a.member.context.membershipId,
      });
      expect(birth?.birthNonce).toMatch(/^[0-9a-f-]{36}$/);
    });
    await expect(
      withTenantTx(app.db, a.member.context, (tx) =>
        tx.insert(outcomeWorkBirths).values({
          organizationId: a.organizationId,
          draftId: draft.id,
          workUnitId: result.workUnitId,
          previewVersion: 1,
          previewSha256: draft.previewSha256,
          createdByMembershipId: a.member.context.membershipId,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(app.db, a.member.context, (tx) =>
        tx.execute(
          sql`delete from experience.outcome_work_births where draft_id=${draft.id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });
  it('cannot persist a scoped Work birth without its same-transaction explicit authorization', async () => {
    const { a } = await makeTwoTenants(app.db),
      draft = await compose(a.member.context),
      p = draft.preview;
    let created = false;
    try {
      await withTenantTx(app.db, a.member.context, async (tx) => {
        await tx.execute(sql`select set_config('app.outcome_draft_id',${draft.id},true)`);
        await createWorkUnitInTx(tx, a.member.context, {
          title: p.title,
          objective: outcomeWorkObjective(p),
          ownerMembershipId: p.ownerMembershipId,
          classification: p.classification,
          dueAt: new Date(p.dueAt + 'T00:00:00.000Z'),
          completionCriteria: [{ kind: 'artifact_exists' }],
          requestKey: draft.id,
        });
        created = true;
        await tx.execute(sql`select set_config('app.outcome_draft_id','',true)`);
      });
      throw new Error('ORPHAN_OUTCOME_BIRTH_COMMITTED');
    } catch (error) {
      expect(pgCode(error)).toBe('EN413');
    }
    expect(created).toBe(true);
    await withTenantTx(app.db, a.member.context, async (tx) => {
      expect(await tx.select().from(workUnits)).toHaveLength(0);
      expect(await tx.select().from(outcomeWorkBirths)).toHaveLength(0);
    });
  });
  it('keeps discarded drafts inert and refuses a disabled author using a captured context', async () => {
    const { a } = await makeTwoTenants(app.db),
      draft = await compose(a.member.context);
    await discardOutcome(app.db, a.member.context, { draftId: draft.id, expectedVersion: 1 });
    await expect(
      authorizeOutcome(app.db, a.member.context, {
        draftId: draft.id,
        expectedVersion: 1,
        previewSha256: draft.previewSha256,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await proveSecondFactor(a.owner);
    await disableMember(app.db, a.owner.context, { membershipId: a.member.context.membershipId });
    await expect(getOutcomeDraft(app.db, a.member.context, draft.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await withTenantTx(app.db, a.member.context, async (tx) =>
      expect(
        await tx
          .select()
          .from(outcomeDrafts)
          .where(
            and(
              eq(outcomeDrafts.id, draft.id),
              eq(outcomeDrafts.createdByMembershipId, a.member.context.membershipId),
            ),
          ),
      ).toEqual([]),
    );
  });
});
