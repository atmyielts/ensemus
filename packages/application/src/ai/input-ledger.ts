// Only this module reaches private transcripts. Read observations live in the metadata-only module.
import {
  runInputCheckpoints,
  stepPayloads,
  executionSteps,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { inArray, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import type { RunTranscriptPurge } from '../knowledge/ports';
export * from './input-observations';
const id = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};

/** Run checkpoints serialize with every payload/step/publication write. No object-fence claim here. */
export function createRunTranscriptPurge(): RunTranscriptPurge {
  const authority = async (tx: Tx) => {
    const role = await tx.execute<{ allowed: boolean }>(
      sql`select current_user='ensemus_agent' as allowed`,
    );
    if (!role.rows[0]?.allowed) throw new AppError('FORBIDDEN');
  };
  const checked = (context: TenantContext, values: readonly string[]) => {
    if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
    if (values.length > 100) throw new AppError('INVALID_INPUT');
    return [...new Set(values.map(id))].sort();
  };
  return {
    async fenceUsing(tx, context, input) {
      const runIds = checked(context, input.runIds);
      await authority(tx);
      for (const runId of runIds) await tx.execute(sql`select ai.fence_run_inputs(${runId}::uuid)`);
      const result = runIds.length
        ? await tx
            .select()
            .from(runInputCheckpoints)
            .where(inArray(runInputCheckpoints.runId, runIds))
        : [];
      return {
        fenced: result.length === runIds.length && result.every((row) => row.fencedAt !== null),
      };
    },
    async purgeUsing(tx, context, input) {
      const runIds = checked(context, input.runIds);
      await authority(tx);
      if (!runIds.length) return { removed: 0, remaining: 0 };
      const checkpoints = await tx
        .select()
        .from(runInputCheckpoints)
        .where(inArray(runInputCheckpoints.runId, runIds))
        .orderBy(runInputCheckpoints.runId)
        .for('update');
      if (checkpoints.length !== runIds.length || checkpoints.some((row) => !row.fencedAt))
        throw new AppError('INVALID_STATE');
      const steps = tx
        .select({ id: executionSteps.id })
        .from(executionSteps)
        .where(inArray(executionSteps.runId, runIds));
      const removed = await tx
        .delete(stepPayloads)
        .where(inArray(stepPayloads.stepId, steps))
        .returning({ id: stepPayloads.id });
      const result = await tx.execute<{ remaining: number }>(
        sql`select count(*)::integer as remaining from ai.step_payloads p join ai.execution_steps s on s.organization_id=p.organization_id and s.id=p.step_id where s.organization_id=${context.organizationId}::uuid and s.run_id in (${sql.join(
          runIds.map((runId) => sql`${runId}::uuid`),
          sql`,`,
        )})`,
      );
      const remaining = Number(result.rows[0]?.remaining ?? 1);
      if (remaining === 0)
        await tx
          .update(runInputCheckpoints)
          .set({
            payloadsPurgedAt: sql`coalesce(${runInputCheckpoints.payloadsPurgedAt},clock_timestamp())`,
            purgedFenceGeneration: runInputCheckpoints.fenceGeneration,
          })
          .where(inArray(runInputCheckpoints.runId, runIds));
      return { removed: removed.length, remaining };
    },
  };
}
