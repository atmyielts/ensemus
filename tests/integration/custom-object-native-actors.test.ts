import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { objectRecords, objectMigrations } from '@ensemus/database/product';
import {
  createObjectType,
  createObjectRecord,
  addObjectTypeVersion,
  migrateObjectBatch,
  getObjectRecord,
  getObjectMigration,
} from '@ensemus/application/custom-objects';
import { eq, sql } from 'drizzle-orm';
import { urls } from '../helpers/stack';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';

describe('native human and migration authority for private records', () => {
  let web: ReturnType<typeof openAppDatabase>, people: Awaited<ReturnType<typeof makeTwoTenants>>;
  const workers = new Map<string, ReturnType<typeof openAppDatabase>>();
  beforeAll(async () => {
    web = openAppDatabase(urls.app());
    people = await makeTwoTenants(web.db);
    await proveSecondFactor(people.a.owner);
    for (const [name, url] of [
      ['agent', urls.agent()],
      ['worker', urls.worker()],
      ['connector', urls.connector()],
      ['knowledge', urls.knowledge()],
    ] as const)
      workers.set(name, openAppDatabase(url));
  });
  afterAll(async () => {
    await web?.close();
    for (const db of workers.values()) await db.close();
  });
  it('keeps native actors out of the human path and admits only the native platform worker to a live migration', async () => {
    const person = people.a.owner,
      svc = createServiceContext(person.context.organizationId);
    const fields = [
      {
        key: 'reference',
        label: 'Reference',
        kind: 'text' as const,
        required: true,
        indexed: false,
        maxLength: 200,
      },
    ];
    const type = await createObjectType(web.db, person.context, {
      slug: 'private_' + randomUUID().replaceAll('-', ''),
      displayName: 'Generated private records',
      classification: 'restricted',
      fields,
      relations: [],
    });
    const record = await createObjectRecord(web.db, person.context, {
      typeId: type.id,
      displayName: 'Generated record',
      attributes: { reference: 'GENERATED-PRIVATE' },
    });
    const next = await addObjectTypeVersion(web.db, person.context, {
      typeId: type.id,
      expectedVersion: type.version,
      fields: fields.map((field) => ({ ...field, indexed: true })),
      relations: [],
    });
    expect(next.migrationId).toBeTruthy();
    const select = (
      db: ReturnType<typeof openAppDatabase>,
      ctx: typeof person.context,
      asApp = false,
    ) =>
      withTenantTx(db.db, ctx, async (tx) => {
        if (asApp) await tx.execute(sql`set local role ensemus_app`);
        return tx
          .select({ id: objectRecords.id })
          .from(objectRecords)
          .where(eq(objectRecords.id, record.id));
      });
    for (const [name, db] of workers) {
      expect(await select(db, person.context, true), name + ' impersonated person').toEqual([]);
      expect(await select(db, svc, true), name + ' switched role during migration').toEqual([]);
      if (name !== 'worker')
        expect(await select(db, svc), name + ' impersonated service').toEqual([]);
    }
    expect(await select(web, svc), 'web impersonated service').toEqual([]);
    expect(await select(web, person.context)).toEqual([{ id: record.id }]);
    const worker = workers.get('worker')!;
    expect(await select(worker, svc)).toEqual([{ id: record.id }]);
    const agent = workers.get('agent')!;
    expect(
      await withTenantTx(agent.db, svc, (tx) =>
        tx
          .update(objectMigrations)
          .set({ status: 'running' })
          .where(eq(objectMigrations.id, next.migrationId!))
          .returning({ id: objectMigrations.id }),
      ),
    ).toEqual([]);
    await migrateObjectBatch(worker.db, svc, { migrationId: next.migrationId!, batchSize: 200 });
    await migrateObjectBatch(worker.db, svc, { migrationId: next.migrationId!, batchSize: 200 });
    expect(
      await getObjectMigration(web.db, person.context, {
        typeId: type.id,
        migrationId: next.migrationId!,
      }),
    ).toMatchObject({ status: 'completed', migratedCount: 1 });
    expect((await getObjectRecord(web.db, person.context, record.id)).typeVersionNumber).toBe(2);
    expect(await select(worker, svc), 'closed migration').toEqual([]);
    expect(
      (
        await withTenantTx(web.db, person.context, (tx) =>
          tx.execute(
            sql`select value_text from objects.record_values where record_id=${record.id}::uuid`,
          ),
        )
      ).rows,
    ).toEqual([{ value_text: 'GENERATED-PRIVATE' }]);
    for (const [name, db] of workers)
      expect(
        await withTenantTx(db.db, person.context, async (tx) => {
          await tx.execute(sql`set local role ensemus_app`);
          return (
            await tx.execute(
              sql`select value_text from objects.record_values where record_id=${record.id}::uuid`,
            )
          ).rows;
        }),
        name + ' private index',
      ).toEqual([]);
  });
});
