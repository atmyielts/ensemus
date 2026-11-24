// Narrow status projection never grants the prerequisite body or an unrelated Work status.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { openAppDatabase, withTenantTx, workUnits } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { addDependency, createWorkUnit } from '@ensemus/application';
import { makeTwoTenants } from '../helpers/product';
import { urls } from '../helpers/stack';

describe('private prerequisite status purpose', () => {
  const web = openAppDatabase(urls.app());
  const native = [urls.agent(), urls.worker(), urls.connector(), urls.knowledge()].map((url) =>
    openAppDatabase(url),
  );
  let people: Awaited<ReturnType<typeof makeTwoTenants>>;
  beforeAll(async () => {
    people = await makeTwoTenants(web.db);
  });
  afterAll(async () => {
    await web.close();
    for (const db of native) await db.close();
  });
  it('returns only actual dependency status to a current reader of the dependent', async () => {
    const owner = people.a.owner.context,
      member = people.a.member.context;
    const hidden = await createWorkUnit(web.db, owner, {
      title: 'GENERATED-HIDDEN-PREREQUISITE',
      classification: 'restricted',
    });
    const dependent = await createWorkUnit(web.db, member, {
      title: 'Generated visible dependent',
    });
    const unrelated = await createWorkUnit(web.db, owner, {
      title: 'Generated unrelated private work',
      classification: 'restricted',
    });
    await addDependency(web.db, owner, { dependentId: dependent.id, prerequisiteId: hidden.id });
    const read = (db: typeof web, context: typeof owner, from = dependent.id, to = hidden.id) =>
      withTenantTx(db.db, context, async (tx) => {
        const r = await tx.execute<{ status: string | null }>(
          sql`select work.prerequisite_status(${from}::uuid,${to}::uuid) status`,
        );
        return r.rows[0]?.status;
      });
    expect(await read(web, member)).toBe('queued');
    expect(await read(web, member, dependent.id, unrelated.id)).toBeNull();
    expect(await read(web, member, unrelated.id, hidden.id)).toBeNull();
    expect(await read(web, member, randomUUID(), hidden.id)).toBeNull();
    expect(await read(web, people.b.owner.context)).toBeNull();
    expect(await read(web, createServiceContext(owner.organizationId))).toBeNull();
    for (const db of native) {
      expect(await read(db, owner)).toBeNull();
      expect(await read(db, createServiceContext(owner.organizationId))).toBeNull();
      const body = await withTenantTx(db.db, owner, async (tx) => {
        await tx.execute(sql`set local role ensemus_app`);
        await tx.execute(
          sql`select set_config('work.prerequisite_status_target',${hidden.id},true)`,
        );
        return tx
          .select({ objective: workUnits.objective })
          .from(workUnits)
          .where(eq(workUnits.id, hidden.id));
      });
      expect(body).toEqual([]);
    }
    await withTenantTx(web.db, member, async (tx) => {
      await tx.execute(
        sql`select set_config('work.prerequisite_status_target','outer-target',true),set_config('work.prerequisite_status_dependent','outer-dependent',true)`,
      );
      const r = await tx.execute<{ status: string | null; target: string; dependent: string }>(
        sql`select work.prerequisite_status(${dependent.id}::uuid,${hidden.id}::uuid) status`,
      );
      expect(r.rows[0]?.status).toBe('queued');
      const selectors = await tx.execute<{ target: string; dependent: string }>(
        sql`select current_setting('work.prerequisite_status_target',true) target,current_setting('work.prerequisite_status_dependent',true) dependent`,
      );
      expect(selectors.rows[0]).toEqual({ target: 'outer-target', dependent: 'outer-dependent' });
      expect(
        await tx
          .select({ objective: workUnits.objective })
          .from(workUnits)
          .where(eq(workUnits.id, hidden.id)),
      ).toEqual([]);
    });
  });
});
