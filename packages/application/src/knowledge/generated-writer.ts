// Content-free exact-token protocol shared by generated writers. No transcript query or body grants.
import {
  agentRuns,
  runOutputWrites,
  withTenantTx,
  type AppDatabase,
  type AgentContext,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../errors';
import { loadAgentReadScopeInTx } from '../ai/read-scope';
import type { GeneratedArtifactWrite } from './artifact-provenance';

function requireAgentWriter(context: TenantContext): asserts context is AgentContext {
  if (context.actorType !== 'agent' || !context.agentRunId) throw new AppError('FORBIDDEN');
}

export async function registerGeneratedWriter(
  tx: Tx,
  context: TenantContext,
  write: GeneratedArtifactWrite,
) {
  requireAgentWriter(context);
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
  requireAgentWriter(context);
  await withTenantTx(database, context, async (tx) => {
    if (to === 'started') {
      const [run] = await tx
        .select({ workUnitId: agentRuns.workUnitId, agentVersionId: agentRuns.agentVersionId })
        .from(agentRuns)
        .where(eq(agentRuns.id, context.agentRunId));
      if (!run || run.workUnitId !== write.workUnitId) throw new AppError('POLICY_DENIED');
      // Each pre-network claim has a fresh transaction. Remint from actual immutable scope and
      // all retained inputs before the run lock; a token alone cannot reopen a closed input.
      await loadAgentReadScopeInTx(tx, context, run, { lockRun: true });
      const [current] = await tx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, context.agentRunId));
      if (current?.status !== 'running') throw new AppError('POLICY_DENIED');
    }
    // started->settled is solely the exact already-fulfilled put acknowledgement. It deliberately
    // remains possible after permanent fencing and never manufactures an object-quiescence proof.
    const rows = await tx
      .update(runOutputWrites)
      .set({ state: to })
      .where(
        and(
          eq(runOutputWrites.artifactId, write.artifactId),
          eq(runOutputWrites.runId, context.agentRunId),
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
