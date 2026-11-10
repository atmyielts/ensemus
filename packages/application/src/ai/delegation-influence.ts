// Exact pre-network/proposal birth authority. No body, service context or caller inventory escapes.
import { memberships, type AgentContext, type Tx } from '@ensemus/database';
import type { AiClassification } from '@ensemus/domain/ai';
import { and, eq, sql } from 'drizzle-orm';
import { idSchema } from '../ids';
import { loadAgentReadScopeInTx } from './read-scope';

export async function lockDelegationInfluenceInTx(
  tx: Tx,
  context: AgentContext,
  input: {
    parentRunId: string;
    childRunId: string;
    childWorkUnitId: string;
    toolStepNumber: number;
    proposalId: string;
    inputSnapshotId: string | null;
    birthContentSha256: string;
  },
): Promise<{ classification: AiClassification } | null> {
  if (
    context.actorType !== 'agent' ||
    context.agentRunId !== input.parentRunId ||
    !input.inputSnapshotId ||
    !/^[0-9a-f]{64}$/.test(input.birthContentSha256) ||
    !Number.isSafeInteger(input.toolStepNumber) ||
    input.toolStepNumber < 1 ||
    [
      input.parentRunId,
      input.childRunId,
      input.childWorkUnitId,
      input.proposalId,
      input.inputSnapshotId,
    ].some((id) => !idSchema.safeParse(id).success)
  )
    return null;
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.id, context.membershipId), eq(memberships.status, 'active')))
    .for('share', { noWait: true });
  // Never mutate a stale branded context or give its old administrative role to a new effect.
  if (!member || member.role !== context.role) return null;
  await loadAgentReadScopeInTx(tx, context);
  const available = await tx.execute<{ ready: boolean }>(sql`select
    to_regprocedure('ai.lock_delegation_birth(uuid,uuid)') is not null ready`);
  if (available.rows[0]?.ready !== true) return null;
  const locked = await tx.execute<{ classification: string | null }>(sql`select
    ai.lock_delegation_birth(${input.parentRunId}::uuid,${input.childRunId}::uuid) classification`);
  const classification = locked.rows[0]?.classification;
  if (
    classification !== 'public' &&
    classification !== 'internal' &&
    classification !== 'confidential' &&
    classification !== 'restricted'
  )
    return null;
  const candidate = await tx.execute<{
    childWorkUnitId: string;
    proposalId: string;
    snapshotId: string;
    toolStepNumber: number;
    birthContentSha256: string;
  }>(sql`select child_work_unit_id "childWorkUnitId",proposal_id "proposalId",snapshot_id "snapshotId",
    tool_step_number "toolStepNumber",birth_content_sha256 "birthContentSha256"
    from ai.delegation_birth_candidate(${input.parentRunId}::uuid,${input.childRunId}::uuid)`);
  const proof = candidate.rows[0];
  if (
    candidate.rows.length !== 1 ||
    !proof ||
    proof.childWorkUnitId !== input.childWorkUnitId ||
    proof.proposalId !== input.proposalId ||
    proof.snapshotId !== input.inputSnapshotId ||
    proof.toolStepNumber !== input.toolStepNumber ||
    proof.birthContentSha256 !== input.birthContentSha256
  )
    return null;
  return { classification };
}
