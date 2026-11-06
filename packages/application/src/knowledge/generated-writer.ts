// Content-free exact-token protocol shared by generated writers. No transcript query or body grants.
import {
  runOutputWrites,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../errors';
import type { GeneratedArtifactWrite } from './artifact-provenance';

export async function registerGeneratedWriter(
  tx: Tx,
  context: TenantContext,
  write: GeneratedArtifactWrite,
) {
  if (context.actorType !== 'agent' || !context.agentRunId) throw new AppError('FORBIDDEN');
  await tx.insert(runOutputWrites).values({
    organizationId: context.organizationId,
    artifactId: write.artifactId,
    runId: context.agentRunId,
    writeId: write.writeId,
    generation: write.generation,
    state: 'registered',
  });
}
async function move(
  database: AppDatabase,
  context: TenantContext,
  write: GeneratedArtifactWrite,
  from: 'registered' | 'started',
  to: 'started' | 'settled',
) {
  if (context.actorType !== 'agent' || !context.agentRunId) throw new AppError('FORBIDDEN');
  await withTenantTx(database, context, async (tx) => {
    const rows = await tx
      .update(runOutputWrites)
      .set({ state: to })
      .where(
        and(
          eq(runOutputWrites.artifactId, write.artifactId),
          eq(runOutputWrites.runId, context.agentRunId!),
          eq(runOutputWrites.writeId, write.writeId),
          eq(runOutputWrites.generation, write.generation),
          eq(runOutputWrites.state, from),
        ),
      )
      .returning({ id: runOutputWrites.artifactId });
    if (rows.length !== 1) throw new AppError('INVALID_STATE');
  });
}
export const claimGeneratedPut = (
  database: AppDatabase,
  context: TenantContext,
  write: GeneratedArtifactWrite,
) => move(database, context, write, 'registered', 'started');
/** Only after the exact put promise fulfilled. A rejection/timeout never calls this function. */
export const settleGeneratedPut = (
  database: AppDatabase,
  context: TenantContext,
  write: GeneratedArtifactWrite,
) => move(database, context, write, 'started', 'settled');
