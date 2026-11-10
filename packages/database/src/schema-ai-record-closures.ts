// 0419 typed-record purge snapshots. These hashes describe actual dead/tombstoned metadata at
// purge time, never historical content or observed authority. Original read receipts remain separate.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentRuns } from './schema-ai';
import { runInputCheckpoints } from './schema-ai-inputs';
import { structuredRecordCatalog } from './schema-artifact-provenance';
const ai = pgSchema('ai');
export const recordPurgeJobs = ai.table(
  'record_purge_jobs',
  {
    organizationId: uuid().notNull(),
    recordKind: text().notNull(),
    recordId: uuid().notNull(),
    snapshotSha256: text().notNull(),
    afterRun: uuid(),
    afterChild: uuid(),
    workRemoved: integer().notNull().default(0),
    workRemaining: integer(),
    unknownWork: integer(),
    controlsRemaining: integer(),
    checkedAt: timestamp({ withTimezone: true }),
    restoreGeneration: uuid(),
    receiptsSha256: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // 0554: the durable completion, NULL until PostgreSQL's own composite proof attests it (0419's guard
    // calls ai.attest_record_purge_completion and clears both on any agent write). Never written from
    // here: ensemus_app holds UPDATE on completed_restore_generation only, and whatever it sends is
    // replaced by the guard's value; completed_at has no runtime privilege at all (0555 pins both).
    completedRestoreGeneration: uuid('completed_restore_generation'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({
      name: 'record_purge_jobs_pk',
      columns: [t.organizationId, t.recordKind, t.recordId, t.snapshotSha256],
    }),
    foreignKey({
      name: 'record_purge_jobs_catalog_fk',
      columns: [t.organizationId, t.recordKind, t.recordId],
      foreignColumns: [
        structuredRecordCatalog.organizationId,
        structuredRecordCatalog.recordKind,
        structuredRecordCatalog.recordId,
      ],
    }),
    check(
      'record_purge_jobs_scope',
      sql`${t.recordKind} in('work_unit','project','client','object_record') and ${t.snapshotSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'record_purge_jobs_counts',
      sql`${t.workRemoved}>=0 and (${t.workRemaining} is null or ${t.workRemaining}>=0) and (${t.unknownWork} is null or ${t.unknownWork}>=0) and (${t.controlsRemaining} is null or ${t.controlsRemaining}>=0)`,
    ),
    check(
      'record_purge_jobs_proof',
      sql`(${t.checkedAt} is null and ${t.receiptsSha256} is null) or (${t.checkedAt} is not null and ${t.receiptsSha256} is not null and ${t.receiptsSha256} ~ '^[0-9a-f]{64}$'
    and ${t.workRemaining} is not null and ${t.workRemaining}=0 and ${t.unknownWork} is not null and ${t.unknownWork}=0 and ${t.controlsRemaining} is not null and ${t.controlsRemaining}=0)`,
    ),
    // 0554:81-83: both completion columns or neither, and only on a checked job, at its own generation.
    check(
      'record_purge_jobs_completion',
      sql`(${t.completedRestoreGeneration} is null and ${t.completedAt} is null) or (${t.completedRestoreGeneration} is not null and ${t.completedAt} is not null and ${t.checkedAt} is not null
    and ${t.restoreGeneration} is not null and ${t.restoreGeneration}=${t.completedRestoreGeneration})`,
    ),
  ],
);
export const recordRunClosures = ai.table(
  'record_run_closures',
  {
    organizationId: uuid().notNull(),
    recordKind: text().notNull(),
    recordId: uuid().notNull(),
    snapshotSha256: text().notNull(),
    runId: uuid().notNull(),
    restoreGeneration: uuid()
      .notNull()
      .default(sql`ai.current_material_restore_generation()`),
    terminalVersion: bigint({ mode: 'number' }).notNull(),
    fenceGeneration: integer().notNull(),
    terminalStatus: text().notNull(),
    closedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'record_run_closures_pk',
      columns: [
        t.organizationId,
        t.recordKind,
        t.recordId,
        t.snapshotSha256,
        t.restoreGeneration,
        t.runId,
        t.terminalVersion,
        t.fenceGeneration,
      ],
    }),
    foreignKey({
      name: 'record_run_closures_job_fk',
      columns: [t.organizationId, t.recordKind, t.recordId, t.snapshotSha256],
      foreignColumns: [
        recordPurgeJobs.organizationId,
        recordPurgeJobs.recordKind,
        recordPurgeJobs.recordId,
        recordPurgeJobs.snapshotSha256,
      ],
    }),
    foreignKey({
      name: 'record_run_closures_run_fk',
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      name: 'record_run_closures_checkpoint_fk',
      columns: [t.organizationId, t.runId],
      foreignColumns: [runInputCheckpoints.organizationId, runInputCheckpoints.runId],
    }),
    index('record_run_closures_run_idx').on(t.organizationId, t.runId),
    check(
      'record_run_closures_scope',
      sql`${t.recordKind} in('work_unit','project','client','object_record') and ${t.snapshotSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'record_run_closures_control',
      sql`${t.terminalVersion}>0 and ${t.fenceGeneration}=1 and ${t.terminalStatus} in('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')`,
    ),
  ],
);
