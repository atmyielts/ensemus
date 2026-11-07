import { randomUUID } from 'node:crypto';
import { setMemberRole, disableMember } from '@ensemus/application';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { objectRecords } from '@ensemus/database/product';
import { eq, sql } from 'drizzle-orm';
import {
  addObjectTypeVersion,
  createObjectRecord,
  createObjectType,
  deleteObjectRecord,
  getObjectRecord,
  getObjectType,
  getObjectMigration,
  retryObjectMigration,
  linkObjectRecords,
  listObjectRecords,
  migrateObjectBatch,
  raiseObjectTypeClassification,
  updateObjectRecord,
} from '@ensemus/application/custom-objects';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';

describe('custom objects through real tenant roles', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  const fields = [
    { key: 'name', label: 'Name', kind: 'text', required: true, indexed: true },
  ] as const;
  beforeAll(async () => {
    database = openAppDatabase(urls.app(), { max: 2 });
    tenants = await makeTwoTenants(database.db);
  });
  afterAll(async () => {
    await database?.close();
  });
  const type = (classification: 'internal' | 'restricted' = 'internal') =>
    createObjectType(database.db, tenants.a.owner.context, {
      slug: `item_${randomUUID().replaceAll('-', '')}`,
      displayName: 'Items',
      classification,
      fields,
      relations: [],
    });

  it('refuses member definitions, reserved slugs and unknown record fields', async () => {
    await expect(
      createObjectType(database.db, tenants.a.member.context, {
        slug: 'example',
        displayName: 'Example',
        classification: 'internal',
        fields,
        relations: [],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      createObjectType(database.db, tenants.a.owner.context, {
        slug: 'approval',
        displayName: 'Approval',
        classification: 'internal',
        fields,
        relations: [],
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_SCHEMA_INVALID' });
    const t = await type();
    for (const attributes of [{ name: 'OK', hidden: 'no' }, { name: 42 }, {}])
      await expect(
        createObjectRecord(database.db, tenants.a.member.context, {
          typeId: t.id,
          displayName: 'Bad',
          attributes,
        }),
      ).rejects.toMatchObject({ code: 'OBJECT_RECORD_INVALID' });
  });

  it('keeps restricted rows invisible in reads, indexed pages and direct SQL to an admin', async () => {
    const t = await type();
    const record = await createObjectRecord(database.db, tenants.a.member.context, {
      typeId: t.id,
      displayName: 'Private item',
      attributes: { name: 'private' },
      classification: 'restricted',
    });
    await expect(
      getObjectRecord(database.db, tenants.a.admin.context, record.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (
        await listObjectRecords(database.db, tenants.a.admin.context, {
          typeId: t.id,
          filter: { fieldKey: 'name', equals: 'private' },
          limit: 1,
        })
      ).items,
    ).toEqual([]);
    await withTenantTx(database.db, tenants.a.admin.context, async (tx) => {
      expect(await tx.select().from(objectRecords).where(eq(objectRecords.id, record.id))).toEqual(
        [],
      );
      const values = await tx.execute(
        sql`select * from objects.record_values where record_id=${record.id}::uuid`,
      );
      expect(values.rows).toEqual([]);
    });
    await expect(
      getObjectRecord(database.db, tenants.b.owner.context, record.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses owner forgery, actor impersonation and direct writes beneath the floor', async () => {
    const t = await type('restricted');
    await expect(
      createObjectRecord(database.db, tenants.a.owner.context, {
        typeId: t.id,
        displayName: 'Too low',
        attributes: { name: 'x' },
        classification: 'public',
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_RECORD_INVALID' });
    await expect(
      withTenantTx(database.db, tenants.a.member.context, (tx) =>
        tx.insert(objectRecords).values({
          organizationId: tenants.a.organizationId,
          typeId: t.id,
          typeVersionNumber: 1,
          displayName: 'Forged',
          attributes: { name: 'x' },
          classification: 'restricted',
          ownerMembershipId: tenants.a.owner.context.membershipId,
          createdByMembershipId: tenants.a.member.context.membershipId,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      createObjectRecord(database.db, createServiceContext(tenants.a.organizationId), {
        typeId: t.id,
        displayName: 'Worker',
        attributes: { name: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('updates optimistically, indexes atomically, and records a deletion tombstone', async () => {
    const t = await type();
    const r = await createObjectRecord(database.db, tenants.a.member.context, {
      typeId: t.id,
      displayName: 'Item',
      attributes: { name: 'before' },
    });
    const next = await updateObjectRecord(database.db, tenants.a.member.context, {
      recordId: r.id,
      expectedVersion: r.version,
      attributes: { name: 'after' },
    });
    await expect(
      updateObjectRecord(database.db, tenants.a.member.context, {
        recordId: r.id,
        expectedVersion: r.version,
        displayName: 'Stale',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      (
        await listObjectRecords(database.db, tenants.a.owner.context, {
          typeId: t.id,
          filter: { fieldKey: 'name', equals: 'before' },
        })
      ).items,
    ).toHaveLength(0);
    expect(
      (
        await listObjectRecords(database.db, tenants.a.owner.context, {
          typeId: t.id,
          filter: { fieldKey: 'name', equals: 'after' },
        })
      ).items.map((x) => x.id),
    ).toEqual([r.id]);
    await deleteObjectRecord(database.db, tenants.a.member.context, {
      recordId: r.id,
      expectedVersion: next.version,
    });
    await expect(
      getObjectRecord(database.db, tenants.a.member.context, r.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await withTenantTx(database.db, tenants.a.owner.context, async (tx) => {
      const proof = await tx.execute(
        sql`select 1 from platform.tombstones where target_type='object_record' and target_id=${r.id}::uuid`,
      );
      expect(proof.rows).toHaveLength(1);
    });
  });

  it('never lowers a type and requires native MFA before lowering a record above its floor', async () => {
    const t = await type();
    const r = await createObjectRecord(database.db, tenants.a.member.context, {
      typeId: t.id,
      displayName: 'Item',
      attributes: { name: 'x' },
      classification: 'restricted',
    });
    await expect(
      updateObjectRecord(database.db, tenants.a.member.context, {
        recordId: r.id,
        expectedVersion: r.version,
        classification: 'internal',
      }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await proveSecondFactor(tenants.a.member);
    await expect(
      updateObjectRecord(database.db, tenants.a.member.context, {
        recordId: r.id,
        expectedVersion: r.version,
        classification: 'internal',
      }),
    ).resolves.toMatchObject({ classification: 'internal' });
    await expect(
      raiseObjectTypeClassification(database.db, tenants.a.owner.context, {
        typeId: t.id,
        expectedVersion: t.version,
        classification: 'public',
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_SCHEMA_INVALID' });
  });

  it('raises existing record floors and closes retained named-viewer metadata access', async () => {
    const t = await type();
    const r = await createObjectRecord(database.db, tenants.a.member.context, {
      typeId: t.id,
      displayName: 'Item',
      attributes: { name: 'x' },
    });
    await raiseObjectTypeClassification(database.db, tenants.a.owner.context, {
      typeId: t.id,
      expectedVersion: t.version,
      classification: 'restricted',
    });
    await expect(getObjectRecord(database.db, tenants.a.admin.context, r.id)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    await withTenantTx(database.db, tenants.a.owner.context, async (tx) => {
      const decision = await tx.execute<{ class: string; readable: boolean }>(
        sql`select objects.record_class(${r.id}::uuid) as class, objects.record_readable(${r.id}::uuid,${tenants.a.admin.context.membershipId}::uuid) as readable`,
      );
      expect(decision.rows[0]).toEqual({ class: 'restricted', readable: false });
    });
  });

  it('refuses destructive type versions and resumes safe migration without double counts', async () => {
    const t = await type();
    await createObjectRecord(database.db, tenants.a.member.context, {
      typeId: t.id,
      displayName: 'One',
      attributes: { name: 'one' },
    });
    await createObjectRecord(database.db, tenants.a.member.context, {
      typeId: t.id,
      displayName: 'Two',
      attributes: { name: 'two' },
    });
    await expect(
      addObjectTypeVersion(database.db, tenants.a.owner.context, {
        typeId: t.id,
        expectedVersion: t.version,
        fields: [],
        relations: [],
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_SCHEMA_INVALID' });
    const created = await addObjectTypeVersion(database.db, tenants.a.owner.context, {
      typeId: t.id,
      expectedVersion: t.version,
      fields: [
        ...fields,
        { key: 'done', label: 'Done', kind: 'boolean', required: false, indexed: true },
      ],
      relations: [],
    });
    if (!created.migrationId) throw new Error('MIGRATION_NOT_CREATED');
    const svc = createServiceContext(tenants.a.organizationId);
    expect(
      await migrateObjectBatch(database.db, svc, {
        migrationId: created.migrationId,
        batchSize: 1,
      }),
    ).toEqual({ more: true });
    expect(
      await migrateObjectBatch(database.db, svc, {
        migrationId: created.migrationId,
        batchSize: 1,
      }),
    ).toEqual({ more: false });
    expect(
      await migrateObjectBatch(database.db, svc, {
        migrationId: created.migrationId,
        batchSize: 1,
      }),
    ).toEqual({ more: false });
    await withTenantTx(database.db, svc, async (tx) => {
      const totals = await tx.execute<{ migrated_count: number; failed_count: number }>(
        sql`select migrated_count,failed_count from objects.migrations where id=${created.migrationId}::uuid`,
      );
      expect(totals.rows[0]).toEqual({ migrated_count: 2, failed_count: 0 });
    });
  });

  it('keeps version rows immutable and tenant slugs independent', async () => {
    const input = {
      slug: `same_${randomUUID().replaceAll('-', '')}`,
      displayName: 'Shared name',
      classification: 'internal' as const,
      fields,
      relations: [],
    };
    await createObjectType(database.db, tenants.a.owner.context, input);
    await expect(
      createObjectType(database.db, tenants.b.owner.context, input),
    ).resolves.toMatchObject({ slug: input.slug });
    await expect(
      withTenantTx(database.db, tenants.a.owner.context, (tx) =>
        tx.execute(sql`update objects.type_versions set fields='[]'::jsonb`),
      ),
    ).rejects.toThrow();
  });

  it('retains and counts an invalid legacy row exactly once while continuing the batch', async () => {
    // This is reachable product data: unindexed text can exceed the btree entry byte limit.
    const original = [
      { key: 'name', label: 'Name', kind: 'text', required: true, indexed: false },
    ] as const;
    const t = await createObjectType(database.db, tenants.a.owner.context, {
      slug: `wide_${randomUUID().replaceAll('-', '')}`,
      displayName: 'Wide text',
      classification: 'internal',
      fields: original,
      relations: [],
    });
    const wide = await createObjectRecord(database.db, tenants.a.member.context, {
      typeId: t.id,
      displayName: 'Wide',
      attributes: { name: 'Ж'.repeat(1500) },
    });
    await createObjectRecord(database.db, tenants.a.member.context, {
      typeId: t.id,
      displayName: 'Short',
      attributes: { name: 'short' },
    });
    const update = await addObjectTypeVersion(database.db, tenants.a.owner.context, {
      typeId: t.id,
      expectedVersion: t.version,
      fields: [{ ...original[0], indexed: true }],
      relations: [],
    });
    if (!update.migrationId) throw new Error('MIGRATION_NOT_CREATED');
    const svc = createServiceContext(tenants.a.organizationId);
    await migrateObjectBatch(database.db, svc, { migrationId: update.migrationId, batchSize: 200 });
    await migrateObjectBatch(database.db, svc, { migrationId: update.migrationId, batchSize: 200 });
    expect(
      (await getObjectRecord(database.db, tenants.a.member.context, wide.id)).typeVersionNumber,
    ).toBe(1);
    await withTenantTx(database.db, svc, async (tx) => {
      const r = await tx.execute<{
        migrated_count: number;
        failed_count: number;
        status: string;
        error_code: string;
      }>(
        sql`select migrated_count,failed_count,status,error_code from objects.migrations where id=${update.migrationId}::uuid`,
      );
      expect(r.rows[0]).toEqual({
        migrated_count: 1,
        failed_count: 1,
        status: 'failed',
        error_code: 'OBJECT_RECORD_INVALID',
      });
      await expect(
        tx.execute(
          sql`update objects.migrations set status='completed',error_code=null where id=${update.migrationId}::uuid`,
        ),
      ).rejects.toThrow();
    });
    await updateObjectRecord(database.db, tenants.a.member.context, {
      recordId: wide.id,
      expectedVersion: wide.version,
      attributes: { name: 'corrected' },
    });
    const fresh = await getObjectType(database.db, tenants.a.owner.context, t.id),
      retry = await retryObjectMigration(database.db, tenants.a.owner.context, {
        typeId: t.id,
        migrationId: update.migrationId,
        expectedTypeVersion: fresh.version,
      });
    await migrateObjectBatch(database.db, svc, { migrationId: retry.id, batchSize: 200 });
    expect(
      await getObjectMigration(database.db, tenants.a.owner.context, {
        typeId: t.id,
        migrationId: retry.id,
      }),
    ).toMatchObject({ status: 'completed', migratedCount: 1, failedCount: 0 });
    expect(
      await getObjectMigration(database.db, tenants.a.owner.context, {
        typeId: t.id,
        migrationId: update.migrationId,
      }),
    ).toMatchObject({ status: 'failed', failedCount: 1 });
  });

  it('links declared readable endpoints and reserves one-valued relations despite hidden targets', async () => {
    const target = await type();
    const origin = await createObjectType(database.db, tenants.a.owner.context, {
      slug: `origin_${randomUUID().replaceAll('-', '')}`,
      displayName: 'Origins',
      classification: 'internal',
      fields,
      relations: [{ key: 'target', label: 'Target', toTypeSlug: target.slug, cardinality: 'one' }],
    });
    const a = await createObjectRecord(database.db, tenants.a.member.context, {
      typeId: origin.id,
      displayName: 'A',
      attributes: { name: 'a' },
    });
    const b = await createObjectRecord(database.db, tenants.a.member.context, {
      typeId: target.id,
      displayName: 'B',
      attributes: { name: 'b' },
    });
    const c = await createObjectRecord(database.db, tenants.a.owner.context, {
      typeId: target.id,
      displayName: 'C',
      attributes: { name: 'c' },
    });
    await expect(
      linkObjectRecords(database.db, tenants.a.member.context, {
        relationKey: 'target',
        fromRecordId: a.id,
        toRecordId: b.id,
      }),
    ).resolves.toHaveProperty('id');
    // Admin can change A but loses B when B becomes restricted to its owner.
    await updateObjectRecord(database.db, tenants.a.member.context, {
      recordId: b.id,
      expectedVersion: b.version,
      classification: 'restricted',
    });
    await expect(
      linkObjectRecords(database.db, tenants.a.admin.context, {
        relationKey: 'target',
        fromRecordId: a.id,
        toRecordId: c.id,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('denies relations with a foreign/private endpoint and undeclared keys', async () => {
    const t = await type();
    const a = await createObjectRecord(database.db, tenants.a.owner.context, {
      typeId: t.id,
      displayName: 'A',
      attributes: { name: 'a' },
    });
    const b = await createObjectRecord(database.db, tenants.a.member.context, {
      typeId: t.id,
      displayName: 'B',
      attributes: { name: 'b' },
      classification: 'restricted',
    });
    await expect(
      linkObjectRecords(database.db, tenants.a.owner.context, {
        relationKey: 'missing',
        fromRecordId: a.id,
        toRecordId: b.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      linkObjectRecords(database.db, tenants.b.owner.context, {
        relationKey: 'missing',
        fromRecordId: a.id,
        toRecordId: b.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refreshes changed roles and disabled membership instead of trusting a captured context', async () => {
    const isolated = (await makeTwoTenants(database.db)).a;
    const t = await createObjectType(database.db, isolated.owner.context, {
      slug: 'fresh_context',
      displayName: 'Fresh context',
      classification: 'internal',
      fields,
      relations: [],
    });
    const r = await createObjectRecord(database.db, isolated.admin.context, {
      typeId: t.id,
      displayName: 'Own item',
      attributes: { name: 'owned' },
    });
    await proveSecondFactor(isolated.owner);
    await setMemberRole(database.db, isolated.owner.context, {
      membershipId: isolated.admin.context.membershipId,
      role: 'member',
    });
    await expect(
      createObjectType(database.db, isolated.admin.context, {
        slug: 'forged_admin',
        displayName: 'Denied',
        classification: 'internal',
        fields,
        relations: [],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await disableMember(database.db, isolated.owner.context, {
      membershipId: isolated.admin.context.membershipId,
    });
    await expect(getObjectRecord(database.db, isolated.admin.context, r.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await withTenantTx(database.db, isolated.admin.context, async (tx) =>
      expect(await tx.select().from(objectRecords).where(eq(objectRecords.id, r.id))).toEqual([]),
    );
  });
});
