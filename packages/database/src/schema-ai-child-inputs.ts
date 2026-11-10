// Durable inventory of actual legacy delegated Work whose inherited inputs have no positive proof.
// No text or fabricated read history. It must outlive operational run deletion until 0416 disposition.
import { sql } from 'drizzle-orm';
import { check, foreignKey, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { aiSchema } from './schema-ai';
import { organizations } from './schema';

export const unprovenChildWorkInputs = aiSchema.table(
  'unproven_child_work_inputs',
  {
    organizationId: uuid().notNull(),
    workUnitId: uuid().notNull(),
    childRunId: uuid().notNull(),
    parentRunId: uuid().notNull(),
    recordedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'unproven_child_work_inputs_pk',
      columns: [t.organizationId, t.workUnitId, t.childRunId],
    }),
    foreignKey({
      name: 'unproven_child_work_inputs_org_fk',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    check('unproven_child_work_inputs_parent', sql`${t.childRunId}<>${t.parentRunId}`),
  ],
);
