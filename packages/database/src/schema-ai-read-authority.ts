// 0417: genuine per-read authority closures. A body hash can have several actual parent closures;
// a later reread never converts a legacy run's unknown earlier authority into a complete history.
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { aiSchema, agentRuns } from './schema-ai';
import { runInputObservations } from './schema-ai-inputs';

export const runAuthorityCheckpoints = aiSchema.table('run_authority_checkpoints', {
  organizationId: uuid().notNull(),
  runId: uuid().notNull(),
  workUnitId: uuid().notNull(),
  agentVersionId: uuid().notNull(),
  initiatorMembershipId: uuid().notNull(),
  protocolVersion: text().notNull(),
  historyComplete: boolean().notNull(),
  bornAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'run_authority_checkpoints_pk', columns: [t.organizationId, t.runId] }),
  foreignKey({ name: 'run_authority_checkpoints_run_fk', columns: [t.organizationId, t.runId], foreignColumns: [agentRuns.organizationId, agentRuns.id] }),
  check('run_authority_checkpoints_protocol', sql`(${t.protocolVersion}='legacy' and not ${t.historyComplete}) or (${t.protocolVersion}='authority-v1' and ${t.historyComplete})`),
]);

export const runReadAuthorities = aiSchema.table('run_read_authorities', {
  organizationId: uuid().notNull(),
  runId: uuid().notNull(),
  inputKind: text().notNull(),
  inputId: uuid().notNull(),
  inputSha256: text().notNull(),
  /** Actual Work link used to authorize an artifact read; absent for structured record bodies. */
  authorizationWorkUnitId: uuid(),
  // The fixed SQL guard replaces these defaults with the actual locked metadata closure.
  authorityInventory: jsonb().notNull().default(sql`'[]'::jsonb`),
  authoritySha256: text().notNull().default(''),
  capturedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'run_read_authorities_pk', columns: [t.organizationId, t.runId, t.inputKind, t.inputId, t.inputSha256, t.authoritySha256] }),
  foreignKey({ name: 'run_read_authorities_observation_fk', columns: [t.organizationId, t.runId, t.inputKind, t.inputId, t.inputSha256], foreignColumns: [runInputObservations.organizationId, runInputObservations.runId, runInputObservations.inputKind, runInputObservations.inputId, runInputObservations.inputSha256] }),
  check('run_read_authorities_shape', sql`${t.inputKind} in('work_unit','project','client','object_record','artifact') and ${t.inputSha256} ~ '^[0-9a-f]{64}$' and ${t.authoritySha256} ~ '^[0-9a-f]{64}$' and (${t.inputKind}='artifact')=(${t.authorizationWorkUnitId} is not null) and jsonb_typeof(${t.authorityInventory})='array' and jsonb_array_length(${t.authorityInventory}) between 1 and 1000 and octet_length(${t.authorityInventory}::text)<=1048576`),
]);
