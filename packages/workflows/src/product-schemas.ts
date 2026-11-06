// Temporal input shapes for M7 (ADR-031). Only IDs cross Temporal (ADR-024 D2): a draft, a report and a record
// all stay in PostgreSQL, and each Activity reads what it needs from there.
import { z } from 'zod';

export const simulationInputSchema = z.strictObject({
  organizationId: z.uuid(),
  simulationId: z.uuid(),
});
export type SimulationInput = z.infer<typeof simulationInputSchema>;
export const simulationWorkflowIdFor = (input: SimulationInput) =>
  `simulation-${input.organizationId}-${input.simulationId}`;
export type SimulationOutcome = 'passed' | 'failed' | 'errored' | 'already_finished';

export const processRunInputSchema = z.strictObject({
  organizationId: z.uuid(),
  processRunId: z.uuid(),
});
export type ProcessRunInput = z.infer<typeof processRunInputSchema>;
export const processRunWorkflowIdFor = (input: ProcessRunInput) =>
  `process-run-${input.organizationId}-${input.processRunId}`;
export type ProcessRunStep =
  | { next: 'wait' }
  | { next: 'finished'; status: 'completed' | 'failed' | 'cancelled' };
export type ProcessRunOutcome = 'completed' | 'failed' | 'cancelled';

export const objectMigrationInputSchema = z.strictObject({
  organizationId: z.uuid(),
  migrationId: z.uuid(),
});
export type ObjectMigrationInput = z.infer<typeof objectMigrationInputSchema>;
export const objectMigrationWorkflowIdFor = (input: ObjectMigrationInput) =>
  `object-migration-${input.organizationId}-${input.migrationId}`;
export type ObjectMigrationOutcome = 'completed' | 'failed';

/** The signal the dispatcher sends a run on PROCESS_RUN_WAKE. It carries nothing. */
export const PROCESS_RUN_WAKE_SIGNAL = 'processRunWake';
