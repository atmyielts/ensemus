// Durable, content-free read history and monotonic content fence for the v1 agent runtime protocol.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { aiSchema, agentRuns } from './schema-ai';
import { artifactLineage } from './schema-artifact-provenance';

export const runInputCheckpoints = aiSchema.table(
  'run_input_checkpoints',
  {
    organizationId: uuid().notNull(),
    runId: uuid().notNull(),
    historyComplete: boolean().notNull().default(false),
    protocolVersion: text().notNull().default('v1'),
    fencedAt: timestamp({ withTimezone: true }),
    fenceGeneration: bigint({ mode: 'number' }).notNull().default(0),
    payloadsPurgedAt: timestamp({ withTimezone: true }),
    purgedFenceGeneration: bigint({ mode: 'number' }),
    purgedRestoreGeneration: uuid(),
  },
  (t) => [
    primaryKey({ name: 'run_input_checkpoints_pk', columns: [t.organizationId, t.runId] }),
    foreignKey({
      name: 'run_input_checkpoints_run_fk',
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    check('run_input_checkpoint_protocol', sql`${t.protocolVersion}='v1'`),
    check(
      'run_input_restore_proof',
      sql`${t.purgedRestoreGeneration} is null or (${t.payloadsPurgedAt} is not null and ${t.purgedFenceGeneration}=1 and ${t.fenceGeneration}=1 and ${t.fencedAt} is not null)`,
    ),
    check(
      'run_input_checkpoint_receipt',
      sql`((${t.fencedAt} is null and ${t.fenceGeneration}=0) or (${t.fencedAt} is not null and ${t.fenceGeneration}=1)) and ((${t.payloadsPurgedAt} is null and ${t.purgedFenceGeneration} is null) or (${t.payloadsPurgedAt} is not null and ${t.purgedFenceGeneration} is not null and ${t.purgedFenceGeneration}=${t.fenceGeneration} and ${t.fenceGeneration}=1))`,
    ),
  ],
);

export const runInputObservations = aiSchema.table(
  'run_input_observations',
  {
    organizationId: uuid().notNull(),
    runId: uuid().notNull(),
    inputKind: text().notNull(),
    inputId: uuid().notNull(),
    inputSha256: text().notNull(),
    classification: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'run_input_observations_pk',
      columns: [t.organizationId, t.runId, t.inputKind, t.inputId, t.inputSha256],
    }),
    foreignKey({
      name: 'run_input_observations_checkpoint_fk',
      columns: [t.organizationId, t.runId],
      foreignColumns: [runInputCheckpoints.organizationId, runInputCheckpoints.runId],
    }),
    check(
      'run_input_observation_shape',
      sql`${t.inputKind} in ('work_unit','project','client','artifact') and ${t.inputSha256} ~ '^[0-9a-f]{64}$' and ${t.classification} in ('public','internal','confidential','restricted')`,
    ),
    index('run_input_observations_input_idx').on(t.organizationId, t.inputKind, t.inputId, t.runId),
  ],
);

/** One durable admission to ObjectStore.put for an exact generated writer token. */
export const runOutputWrites = aiSchema.table(
  'run_output_writes',
  {
    organizationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    runId: uuid().notNull(),
    writeId: uuid().notNull(),
    generation: bigint({ mode: 'number' }).notNull(),
    state: text().notNull(),
  },
  (t) => [
    primaryKey({ name: 'run_output_writes_pk', columns: [t.organizationId, t.artifactId] }),
    foreignKey({
      name: 'run_output_writes_lineage_fk',
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactLineage.organizationId, artifactLineage.artifactId],
    }),
    foreignKey({
      name: 'run_output_writes_checkpoint_fk',
      columns: [t.organizationId, t.runId],
      foreignColumns: [runInputCheckpoints.organizationId, runInputCheckpoints.runId],
    }),
    check(
      'run_output_writes_state',
      sql`${t.state} in ('registered','started','settled') and ${t.generation}>0`,
    ),
  ],
);
