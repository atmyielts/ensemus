// 0419 purge-time control closure. Source version is the actual purge snapshot, never an input
// read-at-time version or financial/provider settlement assertion. Original checkpoints stay separate.
import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, integer, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agentRuns } from './schema-ai';
import { runInputCheckpoints } from './schema-ai-inputs';
import { knowledgeSources } from './schema-knowledge';
const ai = pgSchema('ai');
export const sourceRunClosures = ai.table('source_run_closures', {
  organizationId: uuid().notNull(), sourceId: uuid().notNull(), sourceVersion: integer().notNull(),
  runId: uuid().notNull(), terminalVersion: bigint({ mode: 'number' }).notNull(), fenceGeneration: integer().notNull(),
  terminalStatus: text().notNull(), closedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'source_run_closures_pk', columns: [t.organizationId, t.sourceId, t.sourceVersion, t.runId, t.terminalVersion, t.fenceGeneration] }),
  foreignKey({ name: 'source_run_closures_source_fk', columns: [t.organizationId, t.sourceId], foreignColumns: [knowledgeSources.organizationId, knowledgeSources.id] }),
  foreignKey({ name: 'source_run_closures_run_fk', columns: [t.organizationId, t.runId], foreignColumns: [agentRuns.organizationId, agentRuns.id] }),
  foreignKey({ name: 'source_run_closures_checkpoint_fk', columns: [t.organizationId, t.runId], foreignColumns: [runInputCheckpoints.organizationId, runInputCheckpoints.runId] }),
  index('source_run_closures_run_idx').on(t.organizationId, t.runId),
  check('source_run_closures_control', sql`${t.sourceVersion}>0 and ${t.terminalVersion}>0 and ${t.fenceGeneration}=1 and ${t.terminalStatus} in('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')`),
]);
