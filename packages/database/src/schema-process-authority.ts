//0418: fixed Work INSERT receipts, never importable execution authority. SQL owns permissions,
// reciprocal deferred intent checks, and the intentionally deferred run FK (root Work is born first).
import { sql } from 'drizzle-orm';
import { check, foreignKey, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { memberships, organizations } from './schema';
import { workUnits } from './schema-work';
import { processRuns, processSpecs, studioSchema } from './schema-product';
export const processRunIntents = studioSchema.table(
  'process_run_intents',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    runId: uuid().notNull(),
    specId: uuid().notNull(),
    rootWorkUnitId: uuid().notNull(),
    startedByMembershipId: uuid().notNull(),
    specSha256: text().notNull(),
    birthNonce: uuid().notNull().defaultRandom(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.runId] }),
    unique().on(t.organizationId, t.rootWorkUnitId),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [processRuns.organizationId, processRuns.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.specId],
      foreignColumns: [processSpecs.organizationId, processSpecs.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.rootWorkUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.startedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check('process_run_intents_sha', sql`${t.specSha256}~'^[0-9a-f]{64}$'`),
  ],
);
export const processStepBirths = studioSchema.table(
  'process_step_births',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    runId: uuid().notNull(),
    stepKey: text().notNull(),
    workUnitId: uuid().notNull(),
    startedByMembershipId: uuid().notNull(),
    specSha256: text().notNull(),
    birthNonce: uuid().notNull().defaultRandom(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.runId, t.stepKey] }),
    unique().on(t.organizationId, t.workUnitId),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [processRunIntents.organizationId, processRunIntents.runId],
    }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.startedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check('process_step_births_sha', sql`${t.specSha256}~'^[0-9a-f]{64}$'`),
  ],
);
