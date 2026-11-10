import type { Tx } from '@ensemus/database';
import type { ProcessSpec } from '@ensemus/domain/process-spec';
import { sql } from 'drizzle-orm';
import { AppError } from '../errors';

/** Absence is unavailable inventory, never an invented pending step or a successful empty run. */
export function assertProcessInventory(
  spec: Pick<ProcessSpec, 'steps'>,
  rows: readonly { stepKey: string }[],
): void {
  const keys = new Set(spec.steps.map((step) => step.key));
  if (
    !keys.size ||
    keys.size !== spec.steps.length ||
    rows.length !== keys.size ||
    new Set(rows.map((row) => row.stepKey)).size !== keys.size ||
    rows.some((row) => !keys.has(row.stepKey))
  )
    throw new AppError('CAPABILITY_UNAVAILABLE');
}

/** Set only INSIDE the actor-bound transaction, around the actual Work kernel INSERT. These
 * selectors are not authority: SQL verifies the native start or the real durable delegated intent,
 * exact new Work body, reciprocal binding, requested event, and outbox before commit. */
export async function withProcessBirth<T>(
  tx: Tx,
  input: { runId: string; specId: string } | { runId: string; stepKey: string },
  effect: () => Promise<T>,
): Promise<T> {
  const bindings =
    'specId' in input
      ? { 'app.process_start_run_id': input.runId, 'app.process_start_spec_id': input.specId }
      : { 'app.process_step_run_id': input.runId, 'app.process_step_key': input.stepKey };
  const previous = new Map<string, string>();
  let failed = false;
  let result: T;
  let restoreFailure: unknown;
  let restoreFailed = false;
  try {
    for (const [key, value] of Object.entries(bindings)) {
      const row = await tx.execute<{ value: string | null }>(
        sql`select current_setting(${key},true) as value`,
      );
      previous.set(key, row.rows[0]?.value ?? '');
      await tx.execute(sql`select set_config(${key},${value},true)`);
    }
    result = await effect();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    for (const [key, value] of previous) {
      try {
        await tx.execute(sql`select set_config(${key},${value},true)`);
      } catch (error) {
        // A SQL failure can leave this savepoint aborted; its mandatory rollback restores SET LOCAL.
        // Keep that original failure rather than replacing it with 25P02 from the restoration query.
        if (!failed && !restoreFailed) {
          restoreFailed = true;
          restoreFailure = error;
        }
      }
    }
  }
  if (restoreFailed) throw restoreFailure;
  return result;
}

export async function processProof(tx: Tx, runId: string, stepKey: string): Promise<boolean> {
  const result = await tx.execute<{ valid: boolean }>(
    sql`select studio.process_step_proof(${runId}::uuid,${stepKey}) as valid`,
  );
  return result.rows[0]?.valid === true;
}
export async function processIntent(tx: Tx, runId: string): Promise<void> {
  const result = await tx.execute<{ valid: boolean }>(
    sql`select exists(select 1 from studio.process_run_intents where organization_id=app.current_organization_id() and run_id=${runId}::uuid) as valid`,
  );
  if (result.rows[0]?.valid !== true) throw new AppError('CAPABILITY_UNAVAILABLE');
}
export async function processApproval(
  tx: Tx,
  runId: string,
  stepKey: string,
  approvalId: string,
): Promise<boolean> {
  const result = await tx.execute<{ valid: boolean }>(
    sql`select studio.process_approval_valid(${runId}::uuid,${stepKey},${approvalId}::uuid) as valid`,
  );
  return result.rows[0]?.valid === true;
}
export async function processReceipt(tx: Tx, actionId: string, workId: string): Promise<boolean> {
  const result = await tx.execute<{ valid: boolean }>(
    sql`select studio.process_external_valid(${actionId}::uuid,${workId}::uuid) as valid`,
  );
  return result.rows[0]?.valid === true;
}
