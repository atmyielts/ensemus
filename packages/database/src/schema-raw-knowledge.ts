//0516: retained native identity/control metadata. No source/document/writer FK may erase history.
import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, integer, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './schema';

const lifecycle = pgSchema('lifecycle');
export const rawSourceInventories = lifecycle.table('raw_source_inventories', {
  organizationId: uuid().notNull(), id: uuid().notNull().defaultRandom(),
  scopeKind: text().notNull(), sourceId: uuid(), protocolVersion: integer().notNull(),
  materialRestoreGeneration: uuid().notNull(), state: text().notNull(),
  purgeJobId: uuid(), sourceVersion: bigint({ mode: 'bigint' }),
  captureCursor: uuid(), captureCount: bigint({ mode: 'bigint' }).notNull().default(0n), captureSha256: text(),
  sealedAt: timestamp({ withTimezone: true }),
  bornAt: timestamp({ withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  primaryKey({ name: 'raw_source_inventories_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'raw_source_inventory_org_fk', columns: [t.organizationId], foreignColumns: [organizations.id] }),
  uniqueIndex('raw_source_inventory_one_org').on(t.organizationId).where(sql`${t.scopeKind}='organization'`),
  uniqueIndex('raw_source_inventory_one_source').on(t.organizationId, t.sourceId).where(sql`${t.scopeKind}='source'`),
  check('raw_source_inventory_scope', sql`(${t.scopeKind}='organization' and ${t.sourceId} is null and ${t.purgeJobId} is null and ${t.sourceVersion} is null) or (${t.scopeKind}='source' and ${t.sourceId} is not null)`),
  check('raw_source_inventory_protocol', sql`${t.protocolVersion} in (0,1) and ${t.captureCount}>=0`),
  check('raw_source_inventory_state', sql`${t.state} in ('open','capturing','sealed','legacy','restore_debt')`),
  check('raw_source_inventory_hash', sql`${t.captureSha256} is null or ${t.captureSha256} ~ '^[0-9a-f]{64}$'`),
]);

export const rawObjectWrites = lifecycle.table('raw_object_writes', {
  organizationId: uuid().notNull(), id: uuid().notNull().defaultRandom(), sourceId: uuid().notNull(),
  documentId: uuid().notNull(), writeId: uuid().notNull(), generation: bigint({ mode: 'bigint' }).notNull(),
  objectKey: text().notNull(), contentSha256: text().notNull(), sizeBytes: bigint({ mode: 'bigint' }).notNull(),
  materialRestoreGeneration: uuid().notNull(), state: text().notNull(), startedByMembershipId: uuid(), startedByUserId: uuid(),
  putTokenSha256: text(), putAuthRestoreGeneration: uuid(), admittedAt: timestamp({ withTimezone: true }),
  finishedAt: timestamp({ withTimezone: true }),
  bornAt: timestamp({ withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  primaryKey({ name: 'raw_object_writes_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'raw_object_write_org_fk', columns: [t.organizationId], foreignColumns: [organizations.id] }),
  uniqueIndex('raw_object_write_generation').on(t.organizationId, t.documentId, t.generation),
  uniqueIndex('raw_object_write_token').on(t.organizationId, t.writeId),
  index('raw_object_source_inventory').on(t.organizationId, t.sourceId, t.id),
  check('raw_object_write_key', sql`${t.objectKey}=${t.organizationId}::text||'/knowledge/'||${t.documentId}::text`),
  check('raw_object_write_hash', sql`${t.contentSha256} ~ '^[0-9a-f]{64}$' and ${t.sizeBytes}>=0`),
  check('raw_object_write_state', sql`(${t.generation}=0 and ${t.state}='catalog') or (${t.generation}>0 and ${t.state} in ('intent','put_admitted','finished','unknown','legacy'))`),
  check('raw_object_write_receipt', sql`(${t.state} not in ('put_admitted','finished','unknown') or (${t.putTokenSha256} is not null and ${t.putAuthRestoreGeneration} is not null and ${t.admittedAt} is not null)) and (${t.state}<>'finished' or ${t.finishedAt} is not null)`),
]);
