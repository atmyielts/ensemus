// Objects are company data, never authority over Work, billing, grants or approvals.
import { createHash } from 'node:crypto';
import {
  memberships,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  objectTypes,
  objectTypeVersions,
  objectRecords,
  objectRecordValues,
  objectRelations,
  objectMigrations,
} from '@ensemus/database/product';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  OBJECT_LIMITS,
  isStorableText,
  validateObjectSchema,
  validateRecordAttributes,
  planTypeMigration,
  migrateRecordAttributes,
  parseObjectFilter,
  type ObjectField,
  type ObjectRelationDefinition,
  type TypeMigrationPlan,
} from '@ensemus/domain/custom-object';
import { canProduct, canReadRecord, canChangeRecord } from '@ensemus/domain/product-policy';
import {
  AGGREGATE_OBJECT_TYPE,
  AGGREGATE_OBJECT_MIGRATION,
  OBJECT_TYPE_CHANGED,
  OBJECT_MIGRATION_REQUESTED,
} from '@ensemus/domain/product-events';
import { and, asc, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { idSchema } from '../ids';
import { emit } from '../events';
import { auditAction } from '../work';
import { assertInteractivePrivilege, withPrivilegeTx } from './privileged';

type Classification = 'public' | 'internal' | 'confidential' | 'restricted';
const classes: readonly string[] = ['public', 'internal', 'confidential', 'restricted'];
export type ObjectTypeView = {
  id: string;
  slug: string;
  displayName: string;
  classification: Classification;
  currentVersionNumber: number;
  fields: readonly ObjectField[];
  relations: readonly ObjectRelationDefinition[];
  state: 'active' | 'archived';
  version: number;
};
export type ObjectRecordView = {
  id: string;
  typeId: string;
  typeVersionNumber: number;
  displayName: string;
  attributes: Record<string, unknown>;
  classification: Classification;
  ownerMembershipId: string;
  canChange: boolean;
  version: number;
  updatedAt: Date;
};
type TypeInput = {
  slug: string;
  displayName: string;
  classification: Classification;
  fields: readonly ObjectField[];
  relations: readonly ObjectRelationDefinition[];
};
type TypeRow = typeof objectTypes.$inferSelect;
type RecordRow = typeof objectRecords.$inferSelect;
type Viewer = { membershipId: string; role: string };
const id = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
const name = (value: string) => {
  if (!isStorableText(value) || !value.trim() || value.length > 200)
    throw new AppError('INVALID_INPUT');
  return value.trim();
};
const rank = (value: string) => classes.indexOf(value);
const expected = (actual: number, supplied: number) => {
  if (!Number.isSafeInteger(supplied) || supplied < 1) throw new AppError('INVALID_INPUT');
  if (actual !== supplied) throw new AppError('VERSION_CONFLICT');
};
const hash = (fields: readonly ObjectField[], relations: readonly ObjectRelationDefinition[]) =>
  createHash('sha256').update(canonicalJson({ fields, relations })).digest('hex');

export class ObjectValidationError extends AppError {
  constructor(
    code: 'OBJECT_SCHEMA_INVALID' | 'OBJECT_RECORD_INVALID',
    readonly issues: readonly { path: string; code: string }[],
  ) {
    super(code);
  }
}
async function human(tx: Tx, ctx: TenantContext, manage = false): Promise<Viewer> {
  if (ctx.actorType !== 'user') throw new AppError('FORBIDDEN');
  const [member] = await tx
    .select({ membershipId: memberships.id, role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, ctx.organizationId),
        eq(memberships.id, ctx.membershipId),
        eq(memberships.userId, ctx.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .for('share');
  if (!member || !canProduct(member.role, manage ? 'object_type.manage' : 'object_record.write'))
    throw new AppError('FORBIDDEN');
  return member;
}
const typeWhere = (ctx: TenantContext, typeId: string) =>
  and(eq(objectTypes.organizationId, ctx.organizationId), eq(objectTypes.id, typeId));
async function typeRow(
  tx: Tx,
  ctx: TenantContext,
  typeId: string,
  lock: 'share' | 'update' = 'share',
) {
  const [row] = await tx
    .select()
    .from(objectTypes)
    .where(typeWhere(ctx, id(typeId)))
    .for(lock);
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}
async function shape(
  tx: Tx,
  ctx: TenantContext,
  type: TypeRow,
  number = type.currentVersionNumber,
) {
  const [row] = await tx
    .select()
    .from(objectTypeVersions)
    .where(
      and(
        eq(objectTypeVersions.organizationId, ctx.organizationId),
        eq(objectTypeVersions.typeId, type.id),
        eq(objectTypeVersions.versionNumber, number),
      ),
    );
  if (!row) throw new AppError('INVALID_STATE');
  const fields = row.fields as ObjectField[],
    relations = row.relations as ObjectRelationDefinition[];
  if (
    hash(fields, relations) !== row.schemaSha256 ||
    validateObjectSchema({ slug: type.slug, fields, relations }).length
  )
    throw new AppError('INVALID_STATE');
  return { fields, relations };
}
async function viewType(tx: Tx, ctx: TenantContext, row: TypeRow): Promise<ObjectTypeView> {
  return {
    ...(await shape(tx, ctx, row)),
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    classification: row.classification as Classification,
    currentVersionNumber: row.currentVersionNumber,
    state: row.state as ObjectTypeView['state'],
    version: row.version,
  };
}
const viewRecord = (row: RecordRow, viewer: Viewer): ObjectRecordView => ({
  id: row.id,
  typeId: row.typeId,
  typeVersionNumber: row.typeVersionNumber,
  displayName: row.displayName,
  attributes: row.attributes as Record<string, unknown>,
  classification: row.classification as Classification,
  ownerMembershipId: row.ownerMembershipId,
  version: row.version,
  updatedAt: row.updatedAt,
  canChange: canChangeRecord(row, viewer),
});
const readable = (viewer: Viewer) =>
  sql`objects.record_readable(${objectRecords.id},${viewer.membershipId}::uuid)`;
function validShape(input: TypeInput) {
  const issues = validateObjectSchema(input);
  if (rank(input.classification) < 0) throw new AppError('OBJECT_SCHEMA_INVALID');
  if (issues.length) throw new ObjectValidationError('OBJECT_SCHEMA_INVALID', issues);
  name(input.displayName);
}
function validAttributes(fields: readonly ObjectField[], attributes: Record<string, unknown>) {
  const issues = validateRecordAttributes(fields, attributes);
  if (issues.length) throw new ObjectValidationError('OBJECT_RECORD_INVALID', issues);
}
async function translated<T>(effect: () => Promise<T>): Promise<T> {
  try {
    return await effect();
  } catch (e) {
    if (pgCode(e) === '23505' || pgCode(e) === 'EN407') throw new AppError('VERSION_CONFLICT');
    if (pgCode(e) === 'EN403') throw new AppError('OBJECT_SCHEMA_INVALID');
    if (pgCode(e) === 'EN405') throw new AppError('MFA_REQUIRED');
    throw e;
  }
}
async function typeChanged(tx: Tx, ctx: TenantContext, row: TypeRow) {
  await auditAction(tx, ctx, 'object_type.changed', `object_type:${row.id}`);
  await emit(tx, ctx, {
    eventType: OBJECT_TYPE_CHANGED,
    aggregateType: AGGREGATE_OBJECT_TYPE,
    aggregateId: row.id,
    aggregateVersion: row.version,
    classification: row.classification,
    payload: { type_id: row.id },
  });
}
async function createType(
  tx: Tx,
  ctx: TenantContext,
  input: TypeInput,
  fromPackInstallationId?: string,
) {
  await human(tx, ctx, true);
  validShape(input);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('ensemus:object-types:'||${ctx.organizationId},0))`,
  );
  const count = await tx.execute<{ n: number }>(sql`select count(*)::int n from objects.types`);
  if (
    (count.rows[0]?.n ?? OBJECT_LIMITS.maxTypesPerOrganization) >=
    OBJECT_LIMITS.maxTypesPerOrganization
  )
    throw new AppError('OBJECT_SCHEMA_INVALID');
  const [row] = await tx
    .insert(objectTypes)
    .values({
      organizationId: ctx.organizationId,
      slug: input.slug,
      displayName: name(input.displayName),
      classification: input.classification,
      createdByMembershipId: ctx.membershipId,
      fromPackInstallationId: fromPackInstallationId ? id(fromPackInstallationId) : null,
    })
    .returning();
  if (!row) throw new AppError('INVALID_STATE');
  await tx.insert(objectTypeVersions).values({
    organizationId: ctx.organizationId,
    typeId: row.id,
    versionNumber: 1,
    fields: input.fields,
    relations: input.relations,
    schemaSha256: hash(input.fields, input.relations),
    createdByMembershipId: ctx.membershipId,
  });
  await typeChanged(tx, ctx, row);
  return row;
}
export function createObjectType(
  database: AppDatabase,
  context: TenantContext,
  input: TypeInput,
): Promise<ObjectTypeView> {
  return translated(() =>
    withTenantTx(database, context, async (tx) =>
      viewType(tx, context, await createType(tx, context, input)),
    ),
  );
}
export async function createObjectTypeInTx(
  tx: Tx,
  context: TenantContext,
  input: TypeInput & { fromPackInstallationId: string },
): Promise<{ id: string }> {
  return { id: (await createType(tx, context, input, input.fromPackInstallationId)).id };
}
export function listObjectTypes(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly ObjectTypeView[]> {
  return withTenantTx(database, context, async (tx) => {
    await human(tx, context);
    const rows = await tx
      .select()
      .from(objectTypes)
      .where(eq(objectTypes.organizationId, context.organizationId))
      .orderBy(asc(objectTypes.slug))
      .limit(OBJECT_LIMITS.maxTypesPerOrganization);
    return Promise.all(rows.map((row) => viewType(tx, context, row)));
  });
}
export function getObjectType(
  database: AppDatabase,
  context: TenantContext,
  typeId: string,
): Promise<ObjectTypeView> {
  return withTenantTx(database, context, async (tx) => {
    await human(tx, context);
    return viewType(tx, context, await typeRow(tx, context, typeId));
  });
}
export function addObjectTypeVersion(
  database: AppDatabase,
  context: TenantContext,
  input: {
    typeId: string;
    expectedVersion: number;
    fields: readonly ObjectField[];
    relations: readonly ObjectRelationDefinition[];
  },
): Promise<{ plan: TypeMigrationPlan; migrationId: string | null }> {
  return translated(() =>
    withTenantTx(database, context, async (tx) => {
      await human(tx, context, true);
      const t = await typeRow(tx, context, input.typeId, 'update');
      expected(t.version, input.expectedVersion);
      if (t.state !== 'active') throw new AppError('INVALID_STATE');
      validShape({
        ...input,
        slug: t.slug,
        displayName: t.displayName,
        classification: t.classification as Classification,
      });
      const old = await shape(tx, context, t);
      const plan = planTypeMigration(old.fields, input.fields);
      if (!plan.safe)
        throw new ObjectValidationError(
          'OBJECT_SCHEMA_INVALID',
          plan.steps
            .filter((s) => 'refused' in s)
            .map((s) => ({ path: `fields.${s.key}`, code: s.kind })),
        );
      if (
        old.relations.some(
          (r) => !input.relations.some((next) => canonicalJson(next) === canonicalJson(r)),
        )
      )
        throw new ObjectValidationError('OBJECT_SCHEMA_INVALID', [
          { path: 'relations', code: 'RELATION_REMOVAL_OR_CHANGE' },
        ]);
      if (hash(old.fields, old.relations) === hash(input.fields, input.relations))
        return { plan, migrationId: null };
      const open = await tx
        .select({ id: objectMigrations.id })
        .from(objectMigrations)
        .where(
          and(
            eq(objectMigrations.typeId, t.id),
            sql`${objectMigrations.status} in ('queued','running')`,
          ),
        )
        .limit(1);
      if (open.length) throw new AppError('VERSION_CONFLICT');
      const next = t.currentVersionNumber + 1;
      await tx.insert(objectTypeVersions).values({
        organizationId: context.organizationId,
        typeId: t.id,
        versionNumber: next,
        fields: input.fields,
        relations: input.relations,
        schemaSha256: hash(input.fields, input.relations),
        createdByMembershipId: context.membershipId,
      });
      const [changed] = await tx
        .update(objectTypes)
        .set({ currentVersionNumber: next, version: t.version + 1, updatedAt: new Date() })
        .where(typeWhere(context, t.id))
        .returning();
      if (!changed) throw new AppError('VERSION_CONFLICT');
      const [migration] = await tx
        .insert(objectMigrations)
        .values({
          organizationId: context.organizationId,
          typeId: t.id,
          fromVersionNumber: t.currentVersionNumber,
          toVersionNumber: next,
          requestedByMembershipId: context.membershipId,
        })
        .returning();
      if (!migration) throw new AppError('INVALID_STATE');
      await typeChanged(tx, context, changed);
      await emit(tx, context, {
        eventType: OBJECT_MIGRATION_REQUESTED,
        aggregateType: AGGREGATE_OBJECT_MIGRATION,
        aggregateId: migration.id,
        aggregateVersion: 1,
        classification: t.classification,
        payload: { migration_id: migration.id, type_id: t.id },
      });
      return { plan, migrationId: migration.id };
    }),
  );
}
export function raiseObjectTypeClassification(
  database: AppDatabase,
  context: TenantContext,
  input: { typeId: string; expectedVersion: number; classification: Classification },
): Promise<ObjectTypeView> {
  return translated(() =>
    withTenantTx(database, context, async (tx) => {
      await human(tx, context, true);
      const t = await typeRow(tx, context, input.typeId, 'update');
      expected(t.version, input.expectedVersion);
      if (rank(input.classification) < rank(t.classification) || rank(input.classification) < 0)
        throw new AppError('OBJECT_SCHEMA_INVALID');
      if (t.classification === input.classification) return viewType(tx, context, t);
      const [row] = await tx
        .update(objectTypes)
        .set({
          classification: input.classification,
          version: t.version + 1,
          updatedAt: new Date(),
        })
        .where(typeWhere(context, t.id))
        .returning();
      if (!row) throw new AppError('VERSION_CONFLICT');
      await typeChanged(tx, context, row);
      return viewType(tx, context, row);
    }),
  );
}
export function createObjectRecord(
  database: AppDatabase,
  context: TenantContext,
  input: {
    typeId: string;
    displayName: string;
    attributes: Record<string, unknown>;
    classification?: Classification;
  },
): Promise<ObjectRecordView> {
  return translated(() =>
    withTenantTx(database, context, async (tx) => {
      const viewer = await human(tx, context);
      const t = await typeRow(tx, context, input.typeId);
      if (t.state !== 'active') throw new AppError('INVALID_STATE');
      const s = await shape(tx, context, t);
      validAttributes(s.fields, input.attributes);
      const classification = input.classification ?? t.classification;
      if (rank(classification) < rank(t.classification) || rank(classification) < 0)
        throw new AppError('OBJECT_RECORD_INVALID');
      const [row] = await tx
        .insert(objectRecords)
        .values({
          organizationId: context.organizationId,
          typeId: t.id,
          typeVersionNumber: t.currentVersionNumber,
          displayName: name(input.displayName),
          attributes: input.attributes,
          classification,
          ownerMembershipId: viewer.membershipId,
          createdByMembershipId: viewer.membershipId,
        })
        .returning();
      if (!row) throw new AppError('INVALID_STATE');
      await auditAction(tx, context, 'object_record.created', `object_record:${row.id}`);
      return viewRecord(row, viewer);
    }),
  );
}
async function readRecord(
  tx: Tx,
  ctx: TenantContext,
  viewer: Viewer,
  recordId: string,
  lock?: 'update',
) {
  const query = tx
    .select()
    .from(objectRecords)
    .where(
      and(
        eq(objectRecords.organizationId, ctx.organizationId),
        eq(objectRecords.id, id(recordId)),
        isNull(objectRecords.deletedAt),
        readable(viewer),
      ),
    );
  const [row] = lock ? await query.for(lock) : await query;
  if (!row || !canReadRecord(row, viewer)) throw new AppError('NOT_FOUND');
  return row;
}
export function getObjectRecord(
  database: AppDatabase,
  context: TenantContext,
  recordId: string,
): Promise<ObjectRecordView> {
  return withTenantTx(database, context, async (tx) => {
    const viewer = await human(tx, context);
    return viewRecord(await readRecord(tx, context, viewer, recordId), viewer);
  });
}
/** The exact immutable shape this readable row still uses, including while a migration is pending. */
export function getObjectRecordShape(
  database: AppDatabase,
  context: TenantContext,
  recordId: string,
) {
  return withTenantTx(database, context, async (tx) => {
    const viewer = await human(tx, context);
    const row = await readRecord(tx, context, viewer, recordId);
    const type = await typeRow(tx, context, row.typeId);
    return {
      ...(await shape(tx, context, type, row.typeVersionNumber)),
      typeDisplayName: type.displayName,
    };
  });
}
export function listObjectRelations(
  database: AppDatabase,
  context: TenantContext,
  recordId: string,
  input: { after?: string } = {},
) {
  return withTenantTx(database, context, async (tx) => {
    const viewer = await human(tx, context);
    await readRecord(tx, context, viewer, recordId);
    const rows = await tx
      .select()
      .from(objectRelations)
      .where(
        and(
          eq(objectRelations.fromRecordId, id(recordId)),
          input.after ? gt(objectRelations.id, id(input.after)) : undefined,
        ),
      )
      .orderBy(asc(objectRelations.id))
      .limit(101);
    const items = [];
    for (const edge of rows.slice(0, 100)) {
      const target = await readRecord(tx, context, viewer, edge.toRecordId);
      items.push({
        id: edge.id,
        relationKey: edge.relationKey,
        toRecordId: target.id,
        toDisplayName: target.displayName,
      });
    }
    return {
      items,
      truncated: rows.length > 100,
      next: rows.length > 100 ? (rows[99]?.id ?? null) : null,
    };
  });
}
export function listObjectMigrations(
  database: AppDatabase,
  context: TenantContext,
  typeId: string,
) {
  return withTenantTx(database, context, async (tx) => {
    await human(tx, context, true);
    await typeRow(tx, context, typeId);
    return tx
      .select({
        id: objectMigrations.id,
        status: objectMigrations.status,
        from: objectMigrations.fromVersionNumber,
        to: objectMigrations.toVersionNumber,
        migrated: objectMigrations.migratedCount,
        failed: objectMigrations.failedCount,
        errorCode: objectMigrations.errorCode,
      })
      .from(objectMigrations)
      .where(eq(objectMigrations.typeId, id(typeId)))
      .orderBy(sql`${objectMigrations.createdAt} desc`)
      .limit(20);
  });
}
export function listObjectRecords(
  database: AppDatabase,
  context: TenantContext,
  input: {
    typeId: string;
    filter?: { fieldKey: string; equals: string };
    after?: string;
    limit?: number;
  },
): Promise<{ items: readonly ObjectRecordView[]; next: string | null }> {
  return withTenantTx(database, context, async (tx) => {
    const viewer = await human(tx, context);
    const t = await typeRow(tx, context, input.typeId);
    const s = await shape(tx, context, t);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('INVALID_INPUT');
    let filter: SQL | undefined;
    if (input.filter) {
      const field = s.fields.find((f) => f.key === input.filter?.fieldKey && f.indexed);
      if (!field) throw new AppError('INVALID_INPUT');
      const parsed = parseObjectFilter(field, input.filter.equals);
      if (!parsed) throw new AppError('INVALID_INPUT');
      const column = {
        text: objectRecordValues.valueText,
        number: objectRecordValues.valueNumber,
        time: objectRecordValues.valueTime,
        boolean: objectRecordValues.valueBoolean,
      }[parsed.column];
      filter = sql`exists(select 1 from ${objectRecordValues} where ${objectRecordValues.organizationId}=${objectRecords.organizationId} and ${objectRecordValues.recordId}=${objectRecords.id} and ${objectRecordValues.fieldKey}=${field.key} and ${column}=${parsed.value})`;
    }
    const rows = await tx
      .select()
      .from(objectRecords)
      .where(
        and(
          eq(objectRecords.organizationId, context.organizationId),
          eq(objectRecords.typeId, t.id),
          isNull(objectRecords.deletedAt),
          readable(viewer),
          input.after ? gt(objectRecords.id, id(input.after)) : undefined,
          filter,
        ),
      )
      .orderBy(asc(objectRecords.id))
      .limit(limit + 1);
    const items = rows
      .slice(0, limit)
      .filter((row) => canReadRecord(row, viewer))
      .map((row) => viewRecord(row, viewer));
    return { items, next: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null };
  });
}
async function lockedRecord(tx: Tx, ctx: TenantContext, viewer: Viewer, recordId: string) {
  const [key] = await tx
    .select({ typeId: objectRecords.typeId })
    .from(objectRecords)
    .where(and(eq(objectRecords.id, id(recordId)), readable(viewer)));
  if (!key) throw new AppError('NOT_FOUND');
  const t = await typeRow(tx, ctx, key.typeId);
  const row = await readRecord(tx, ctx, viewer, recordId, 'update');
  return { t, row };
}
export function updateObjectRecord(
  database: AppDatabase,
  context: TenantContext,
  input: {
    recordId: string;
    expectedVersion: number;
    displayName?: string;
    attributes?: Record<string, unknown>;
    classification?: Classification;
  },
): Promise<ObjectRecordView> {
  return translated(() =>
    withPrivilegeTx(database, context, async (tx) => {
      const viewer = await human(tx, context);
      const { t, row } = await lockedRecord(tx, context, viewer, input.recordId);
      if (!canChangeRecord(row, viewer)) throw new AppError('FORBIDDEN');
      expected(row.version, input.expectedVersion);
      if (t.state !== 'active') throw new AppError('INVALID_STATE');
      const s = await shape(tx, context, t, row.typeVersionNumber);
      const attributes = input.attributes ?? (row.attributes as Record<string, unknown>);
      validAttributes(s.fields, attributes);
      const classification = input.classification ?? row.classification;
      if (rank(classification) < rank(t.classification) || rank(classification) < 0)
        throw new AppError('OBJECT_RECORD_INVALID');
      if (rank(classification) < rank(row.classification))
        await assertInteractivePrivilege(tx, context, 'object_type.lower_scope');
      const [changed] = await tx
        .update(objectRecords)
        .set({
          displayName: input.displayName === undefined ? row.displayName : name(input.displayName),
          attributes,
          classification,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(objectRecords.id, row.id), eq(objectRecords.version, row.version)))
        .returning();
      if (!changed) throw new AppError('VERSION_CONFLICT');
      await auditAction(tx, context, 'object_record.updated', `object_record:${row.id}`);
      return viewRecord(changed, viewer);
    }),
  );
}
export function deleteObjectRecord(
  database: AppDatabase,
  context: TenantContext,
  input: { recordId: string; expectedVersion: number },
): Promise<void> {
  return translated(() =>
    withTenantTx(database, context, async (tx) => {
      const viewer = await human(tx, context);
      const { row } = await lockedRecord(tx, context, viewer, input.recordId);
      if (!canChangeRecord(row, viewer)) throw new AppError('FORBIDDEN');
      expected(row.version, input.expectedVersion);
      await tx
        .update(objectRecords)
        .set({ deletedAt: new Date(), updatedAt: new Date(), version: row.version + 1 })
        .where(eq(objectRecords.id, row.id));
      await auditAction(tx, context, 'object_record.deleted', `object_record:${row.id}`);
    }),
  );
}
export function linkObjectRecords(
  database: AppDatabase,
  context: TenantContext,
  input: { relationKey: string; fromRecordId: string; toRecordId: string },
): Promise<{ id: string }> {
  return translated(() =>
    withTenantTx(database, context, async (tx) => {
      const viewer = await human(tx, context);
      const fromId = id(input.fromRecordId),
        toId = id(input.toRecordId);
      if (fromId === toId) throw new AppError('INVALID_INPUT');
      const keys = await tx
        .select({ id: objectRecords.id, typeId: objectRecords.typeId })
        .from(objectRecords)
        .where(and(sql`${objectRecords.id} in (${fromId}::uuid,${toId}::uuid)`, readable(viewer)));
      if (keys.length !== 2) throw new AppError('NOT_FOUND');
      const types = new Map<string, TypeRow>();
      for (const typeId of [...new Set(keys.map((k) => k.typeId))].sort())
        types.set(typeId, await typeRow(tx, context, typeId));
      const rows: RecordRow[] = [];
      for (const key of [...keys].sort((a, b) => a.id.localeCompare(b.id)))
        rows.push(await readRecord(tx, context, viewer, key.id, 'update'));
      const from = rows.find((r) => r.id === fromId),
        to = rows.find((r) => r.id === toId);
      if (!from || !to) throw new AppError('NOT_FOUND');
      if (!canChangeRecord(from, viewer)) throw new AppError('FORBIDDEN');
      const fromType = types.get(from.typeId),
        toType = types.get(to.typeId);
      if (!fromType || !toType) throw new AppError('NOT_FOUND');
      if (fromType.state !== 'active' || toType.state !== 'active')
        throw new AppError('INVALID_STATE');
      const declaration = (await shape(tx, context, fromType)).relations.find(
        (r) => r.key === input.relationKey && r.toTypeSlug === toType.slug,
      );
      if (!declaration) throw new AppError('OBJECT_RECORD_INVALID');
      const old = await tx
        .select({ id: objectRelations.id, to: objectRelations.toRecordId })
        .from(objectRelations)
        .where(
          and(
            eq(objectRelations.fromRecordId, from.id),
            eq(objectRelations.relationKey, input.relationKey),
          ),
        );
      const same = old.find((r) => r.to === to.id);
      if (same) return { id: same.id };
      if (declaration.cardinality === 'one' && old.length) throw new AppError('VERSION_CONFLICT');
      const [edge] = await tx
        .insert(objectRelations)
        .values({
          organizationId: context.organizationId,
          relationKey: input.relationKey,
          fromRecordId: from.id,
          toRecordId: to.id,
          createdByMembershipId: viewer.membershipId,
        })
        .returning({ id: objectRelations.id });
      if (!edge) throw new AppError('INVALID_STATE');
      await auditAction(tx, context, 'object_relation.created', `object_relation:${edge.id}`);
      return edge;
    }),
  );
}
export function unlinkObjectRecords(
  database: AppDatabase,
  context: TenantContext,
  input: { relationId: string; fromRecordId?: string },
): Promise<void> {
  return withTenantTx(database, context, async (tx) => {
    const viewer = await human(tx, context);
    const [edge] = await tx
      .select()
      .from(objectRelations)
      .where(eq(objectRelations.id, id(input.relationId)));
    if (!edge || (input.fromRecordId && edge.fromRecordId !== id(input.fromRecordId)))
      throw new AppError('NOT_FOUND');
    const { row } = await lockedRecord(tx, context, viewer, edge.fromRecordId);
    await readRecord(tx, context, viewer, edge.toRecordId);
    if (!canChangeRecord(row, viewer)) throw new AppError('FORBIDDEN');
    await tx.delete(objectRelations).where(eq(objectRelations.id, edge.id));
    await auditAction(tx, context, 'object_relation.deleted', `object_relation:${edge.id}`);
  });
}

/** Each row has one durable outcome, atomic with its rewrite. Failed rows remain on their old shape. */
export function migrateObjectBatch(
  database: AppDatabase,
  context: TenantContext,
  input: { migrationId: string; batchSize: number },
): Promise<{ more: boolean }> {
  if (context.actorType !== 'service') return Promise.reject(new AppError('FORBIDDEN'));
  if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 200)
    return Promise.reject(new AppError('INVALID_INPUT'));
  return withTenantTx(database, context, async (tx) => {
    const [key] = await tx
      .select({ typeId: objectMigrations.typeId })
      .from(objectMigrations)
      .where(eq(objectMigrations.id, id(input.migrationId)));
    if (!key) throw new AppError('NOT_FOUND');
    const t = await typeRow(tx, context, key.typeId, 'update');
    const [m] = await tx
      .select()
      .from(objectMigrations)
      .where(eq(objectMigrations.id, id(input.migrationId)))
      .for('update');
    if (!m) throw new AppError('NOT_FOUND');
    if (m.status === 'completed' || m.status === 'failed') return { more: false };
    const before = await shape(tx, context, t, m.fromVersionNumber),
      after = await shape(tx, context, t, m.toVersionNumber),
      plan = planTypeMigration(before.fields, after.fields);
    if (!plan.safe || t.currentVersionNumber < m.toVersionNumber)
      throw new AppError('INVALID_STATE');
    await tx
      .update(objectMigrations)
      .set({ status: 'running' })
      .where(eq(objectMigrations.id, m.id));
    const pending = and(
      eq(objectRecords.typeId, t.id),
      sql`${objectRecords.typeVersionNumber}<${m.toVersionNumber}`,
      isNull(objectRecords.deletedAt),
      sql`not exists(select 1 from objects.migration_results r where r.organization_id=${objectRecords.organizationId} and r.migration_id=${m.id}::uuid and r.record_id=${objectRecords.id})`,
    );
    const rows = await tx
      .select()
      .from(objectRecords)
      .where(pending)
      .orderBy(asc(objectRecords.id))
      .limit(input.batchSize)
      .for('update');
    for (const row of rows) {
      const attributes = migrateRecordAttributes(plan, row.attributes as Record<string, unknown>),
        issues = validateRecordAttributes(after.fields, attributes);
      const outcome = issues.length ? 'failed' : 'migrated';
      if (!issues.length)
        await tx
          .update(objectRecords)
          .set({
            typeVersionNumber: m.toVersionNumber,
            attributes,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(objectRecords.id, row.id));
      await tx.execute(
        sql`insert into objects.migration_results(organization_id,migration_id,record_id,outcome,error_code) values(${context.organizationId}::uuid,${m.id}::uuid,${row.id}::uuid,${outcome},${issues.length ? 'OBJECT_RECORD_INVALID' : null})`,
      );
    }
    const [remaining] = await tx
      .select({ id: objectRecords.id })
      .from(objectRecords)
      .where(pending)
      .limit(1);
    const more = !!remaining;
    const counts = await tx.execute<{ failed: number }>(
        sql`select count(*)::int as failed from objects.migration_results where migration_id=${m.id}::uuid and outcome='failed'`,
      ),
      failed = (counts.rows[0]?.failed ?? 0) > 0;
    await tx.execute(
      sql`update objects.migrations set migrated_count=(select count(*) from objects.migration_results where migration_id=${m.id}::uuid and outcome='migrated'),failed_count=(select count(*) from objects.migration_results where migration_id=${m.id}::uuid and outcome='failed'),status=${more ? 'running' : failed ? 'failed' : 'completed'},error_code=${!more && failed ? 'OBJECT_RECORD_INVALID' : null},finished_at=${more ? null : new Date()} where id=${m.id}::uuid`,
    );
    return { more };
  });
}
export function failObjectMigration(
  database: AppDatabase,
  context: TenantContext,
  input: { migrationId: string; code: string },
): Promise<void> {
  if (context.actorType !== 'service') return Promise.reject(new AppError('FORBIDDEN'));
  return withTenantTx(database, context, async (tx) => {
    const [m] = await tx
      .select()
      .from(objectMigrations)
      .where(eq(objectMigrations.id, id(input.migrationId)))
      .for('update');
    if (!m) throw new AppError('NOT_FOUND');
    if (m.status === 'completed' || m.status === 'failed') return;
    await tx
      .update(objectMigrations)
      .set({ status: 'failed', errorCode: 'MIGRATION_FAILED', finishedAt: new Date() })
      .where(eq(objectMigrations.id, m.id));
  });
}
export function getObjectMigrationStatus(
  database: AppDatabase,
  context: TenantContext,
  migrationId: string,
): Promise<'queued' | 'running' | 'completed' | 'failed'> {
  if (context.actorType !== 'service') return Promise.reject(new AppError('FORBIDDEN'));
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select({ status: objectMigrations.status })
      .from(objectMigrations)
      .where(eq(objectMigrations.id, id(migrationId)));
    if (!row || !['queued', 'running', 'completed', 'failed'].includes(row.status))
      throw new AppError('NOT_FOUND');
    return row.status as 'queued' | 'running' | 'completed' | 'failed';
  });
}
export function getObjectMigration(
  database: AppDatabase,
  context: TenantContext,
  input: { typeId: string; migrationId: string },
) {
  return withTenantTx(database, context, async (tx) => {
    await human(tx, context, true);
    await typeRow(tx, context, input.typeId);
    const [row] = await tx
      .select()
      .from(objectMigrations)
      .where(
        and(
          eq(objectMigrations.id, id(input.migrationId)),
          eq(objectMigrations.typeId, id(input.typeId)),
        ),
      );
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  });
}
/** Retry is a new, named human intent. Old failure receipts/counts remain immutable. */
export function retryObjectMigration(
  database: AppDatabase,
  context: TenantContext,
  input: { typeId: string; migrationId: string; expectedTypeVersion: number },
): Promise<{ id: string }> {
  return translated(() =>
    withTenantTx(database, context, async (tx) => {
      await human(tx, context, true);
      const t = await typeRow(tx, context, input.typeId, 'update');
      expected(t.version, input.expectedTypeVersion);
      const [old] = await tx
        .select()
        .from(objectMigrations)
        .where(
          and(eq(objectMigrations.id, id(input.migrationId)), eq(objectMigrations.typeId, t.id)),
        );
      if (!old) throw new AppError('NOT_FOUND');
      if (
        old.status !== 'failed' ||
        old.toVersionNumber !== t.currentVersionNumber ||
        t.state !== 'active'
      )
        throw new AppError('INVALID_STATE');
      await shape(tx, context, t);
      const [row] = await tx
        .insert(objectMigrations)
        .values({
          organizationId: context.organizationId,
          typeId: t.id,
          fromVersionNumber: t.currentVersionNumber - 1,
          toVersionNumber: t.currentVersionNumber,
          requestedByMembershipId: context.membershipId,
        })
        .returning({ id: objectMigrations.id });
      if (!row) throw new AppError('INVALID_STATE');
      await auditAction(tx, context, 'object_migration.retried', `object_migration:${row.id}`);
      await emit(tx, context, {
        eventType: OBJECT_MIGRATION_REQUESTED,
        aggregateType: AGGREGATE_OBJECT_MIGRATION,
        aggregateId: row.id,
        aggregateVersion: 1,
        classification: t.classification,
        payload: { migration_id: row.id, type_id: t.id },
      });
      return row;
    }),
  );
}
