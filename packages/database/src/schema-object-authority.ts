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
    primaryKey({ columns: [t.organizationId, t.migrationId, t.recordId] }),
    foreignKey({
      columns: [t.organizationId, t.migrationId],
      foreignColumns: [objectMigrations.organizationId, objectMigrations.id],
    }),
    foreignKey({
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
    primaryKey({ columns: [t.organizationId, t.typeId] }),
    check(
      'object_type_acl_class',
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
    primaryKey({ columns: [t.organizationId, t.fromRecordId, t.relationKey] }),
    unique().on(t.organizationId, t.relationId),
    foreignKey({
      columns: [t.organizationId, t.fromRecordId],
      foreignColumns: [objectRecords.organizationId, objectRecords.id],
    }),
  ],
);
