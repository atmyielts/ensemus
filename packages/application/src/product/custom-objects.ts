// Owned by the objects slice (KNOW-07). See docs/06-delivery/m7-slices.md and ADR-031 D11.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type {
  ObjectField,
  ObjectRelationDefinition,
  TypeMigrationPlan,
} from '@ensemus/domain/custom-object';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

type Classification = 'public' | 'internal' | 'confidential' | 'restricted';

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

/** Needs `object_type.manage`. */
export async function createObjectType(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    slug: string;
    displayName: string;
    classification: Classification;
    fields: readonly ObjectField[];
    relations: readonly ObjectRelationDefinition[];
  },
): Promise<ObjectTypeView> {
  throw NOT_BUILT();
}

/** For a pack, in its transaction. Same checks. */
export async function createObjectTypeInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: {
    slug: string;
    displayName: string;
    classification: Classification;
    fields: readonly ObjectField[];
    relations: readonly ObjectRelationDefinition[];
    fromPackInstallationId: string;
  },
): Promise<{ id: string }> {
  throw NOT_BUILT();
}

export async function listObjectTypes(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly ObjectTypeView[]> {
  throw NOT_BUILT();
}

export async function getObjectType(
  _database: AppDatabase,
  _context: TenantContext,
  _typeId: string,
): Promise<ObjectTypeView> {
  throw NOT_BUILT();
}

/**
 * Needs `object_type.manage`. Adds a new immutable shape. A plan with a refused step is refused here with
 * OBJECT_SCHEMA_INVALID, so no field can be dropped under existing records. Commits OBJECT_MIGRATION_REQUESTED.
 */
export async function addObjectTypeVersion(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    typeId: string;
    expectedVersion: number;
    fields: readonly ObjectField[];
    relations: readonly ObjectRelationDefinition[];
  },
): Promise<{ plan: TypeMigrationPlan; migrationId: string | null }> {
  throw NOT_BUILT();
}

/** Raising is free. Lowering is refused by a trigger for everybody: make a new type instead. */
export async function raiseObjectTypeClassification(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { typeId: string; expectedVersion: number; classification: Classification },
): Promise<ObjectTypeView> {
  throw NOT_BUILT();
}

/** Needs `object_record.write`. Validated against the current shape, and class floored at the type's. */
export async function createObjectRecord(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    typeId: string;
    displayName: string;
    attributes: Record<string, unknown>;
    classification?: Classification;
  },
): Promise<ObjectRecordView> {
  throw NOT_BUILT();
}

/** Only what the viewer can read (`canReadRecord`), and only by indexed fields. */
export async function listObjectRecords(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    typeId: string;
    filter?: { fieldKey: string; equals: string };
    after?: string;
    limit?: number;
  },
): Promise<{ items: readonly ObjectRecordView[]; next: string | null }> {
  throw NOT_BUILT();
}

export async function getObjectRecord(
  _database: AppDatabase,
  _context: TenantContext,
  _recordId: string,
): Promise<ObjectRecordView> {
  throw NOT_BUILT();
}

export async function updateObjectRecord(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    recordId: string;
    expectedVersion: number;
    displayName?: string;
    attributes?: Record<string, unknown>;
    classification?: Classification;
  },
): Promise<ObjectRecordView> {
  throw NOT_BUILT();
}

/** A soft delete, so history keeps its shape. M2's tombstones apply once M5 indexes records. */
export async function deleteObjectRecord(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { recordId: string; expectedVersion: number },
): Promise<void> {
  throw NOT_BUILT();
}

/** Both ends in this tenant and readable. The relation has to be declared on the type's current shape. */
export async function linkObjectRecords(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { relationKey: string; fromRecordId: string; toRecordId: string },
): Promise<{ id: string }> {
  throw NOT_BUILT();
}

export async function unlinkObjectRecords(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { relationId: string },
): Promise<void> {
  throw NOT_BUILT();
}

/** The worker's one batch, with a service context. Idempotent, and a bad record counts and carries on. */
export async function migrateObjectBatch(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { migrationId: string; batchSize: number },
): Promise<{ more: boolean }> {
  throw NOT_BUILT();
}

/** Ends a migration from the workflow's failure path, with a code. */
export async function failObjectMigration(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { migrationId: string; code: string },
): Promise<void> {
  throw NOT_BUILT();
}
