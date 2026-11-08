// Durable batch outcomes. Bodies remain in objects.records; this ledger contains IDs/codes only.
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { objectMigrations, objectRecords } from './schema-product';

export const objectMigrationResults = pgSchema('objects').table(
  'migration_results',
  {
    organizationId: uuid().notNull(),
    migrationId: uuid().notNull(),
    recordId: uuid().notNull(),
    outcome: text().notNull(),
    errorCode: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'migration_results_pkey',
      columns: [t.organizationId, t.migrationId, t.recordId],
    }),
    foreignKey({
      name: 'migration_results_organization_id_migration_id_fkey',
      columns: [t.organizationId, t.migrationId],
      foreignColumns: [objectMigrations.organizationId, objectMigrations.id],
    }),
    foreignKey({
      name: 'migration_results_organization_id_record_id_fkey',
      columns: [t.organizationId, t.recordId],
      foreignColumns: [objectRecords.organizationId, objectRecords.id],
    }),
    check(
      'object_migration_results_shape',
      sql`${t.outcome} in ('migrated','failed') and (${t.errorCode} is null or ${t.errorCode}='OBJECT_RECORD_INVALID')`,
    ),
  ],
);

/** Metadata retained independently of type bodies for fresh floor decisions. */
export const objectTypeAclCatalog = pgSchema('objects').table(
  'type_acl_catalog',
  {
    organizationId: uuid().notNull(),
    typeId: uuid().notNull(),
    classification: text().notNull(),
  },
  (t) => [
    primaryKey({ name: 'type_acl_catalog_pkey', columns: [t.organizationId, t.typeId] }),
    check(
      'type_acl_catalog_classification_check',
      sql`${t.classification} in ('public','internal','confidential','restricted')`,
    ),
  ],
);

// No application read/write grant; fixed relation triggers reserve a single-valued slot atomically.
export const objectRelationSlots = pgSchema('objects').table(
  'relation_slots',
  {
    organizationId: uuid().notNull(),
    fromRecordId: uuid().notNull(),
    relationKey: text().notNull(),
    relationId: uuid().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'relation_slots_pkey',
      columns: [t.organizationId, t.fromRecordId, t.relationKey],
    }),
    unique('relation_slots_organization_id_relation_id_key').on(t.organizationId, t.relationId),
    foreignKey({
      name: 'relation_slots_organization_id_from_record_id_fkey',
      columns: [t.organizationId, t.fromRecordId],
      foreignColumns: [objectRecords.organizationId, objectRecords.id],
    }),
  ],
);
