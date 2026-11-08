// 0515 retained technical cleanup witness. It never attests final row erasure or paid settlement.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './schema';
import { offboardings } from './schema-saas';

export const delegatedErasureReceipts = pgSchema('lifecycle').table(
  'delegated_erasure_receipts',
  {
    organizationId: uuid().notNull(),
    offboardingId: uuid().notNull(),
    materialRestoreGeneration: uuid().notNull(),
    authRestoreGeneration: uuid().notNull(),
    admittedAt: timestamp({ withTimezone: true }).notNull(),
    erasureStartedAt: timestamp({ withTimezone: true }).notNull(),
    proofSha256: text().notNull(),
    runCount: bigint({ mode: 'bigint' }).notNull(),
    childCount: bigint({ mode: 'bigint' }).notNull(),
    sourceCount: bigint({ mode: 'bigint' }).notNull(),
    rawProtocolVersion: integer(),
    rawInventorySha256: text(),
    rawScopeCount: bigint({ mode: 'bigint' }),
    rawWriteCount: bigint({ mode: 'bigint' }),
    sealedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({
      name: 'delegated_erasure_receipts_pk',
      columns: [t.organizationId, t.offboardingId, t.materialRestoreGeneration],
    }),
    foreignKey({
      name: 'delegated_erasure_receipts_org_fk',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      name: 'delegated_erasure_receipts_offboarding_fk',
      columns: [t.organizationId, t.offboardingId],
      foreignColumns: [offboardings.organizationId, offboardings.id],
    }),
    check('delegated_erasure_receipts_hash', sql`${t.proofSha256} ~ '^[0-9a-f]{64}$'`),
    check('delegated_erasure_raw_pin', sql`(${t.rawProtocolVersion} is null and ${t.rawInventorySha256} is null and ${t.rawScopeCount} is null and ${t.rawWriteCount} is null) or (${t.rawProtocolVersion}=1 and ${t.rawInventorySha256} is not null and ${t.rawInventorySha256} ~ '^[0-9a-f]{64}$' and ${t.rawScopeCount} is not null and ${t.rawScopeCount}>=0 and ${t.rawWriteCount} is not null and ${t.rawWriteCount}>=0)`),
    check(
      'delegated_erasure_receipts_counts',
      sql`${t.runCount}>=0 and ${t.childCount}>=0 and ${t.sourceCount}>=0`,
    ),
  ],
);
