// Before-material runtime version admission and genuine read-time metadata closure receipts.
// No company body, guessed old parent or user-provided authority list is accepted here.
import { runReadAuthorities, type AgentContext, type Tx } from '@ensemus/database';
import { sql } from 'drizzle-orm';
import { AppError } from '../errors';

/** Called only after immutable manifest/current-influence admission in this same transaction.
 * Birth protocol is immutable: rereading the same body cannot promote a legacy run's history. */
export async function bindAgentAuthorityProtocolInTx(tx: Tx, context: AgentContext) {
  await tx.execute(sql`select set_config('app.agent_authority_protocol','',true)`);
  const state = await tx.execute<{ protocol: string | null; ready: boolean }>(sql`select
    ai.run_authority_protocol_version(${context.agentRunId}::uuid) protocol,
    ai.run_authority_ready(${context.agentRunId}::uuid,${context.membershipId}::uuid) ready`);
  const row = state.rows[0];
  if (row?.protocol === 'legacy') return { complete: false };
  if (context.actorType !== 'agent' || row?.protocol !== 'authority-v1' || row.ready !== true)
    throw new AppError('POLICY_DENIED');
  await tx.execute(
    sql`select set_config('app.agent_authority_protocol',${`authority-v1:${context.agentRunId}`},true)`,
  );
  const admitted = await tx.execute<{ admitted: boolean }>(
    sql`select ai.run_authority_read_admitted(${context.agentRunId}::uuid) admitted`,
  );
  if (admitted.rows[0]?.admitted !== true) throw new AppError('POLICY_DENIED');
  return { complete: true };
}

/** Pins exact authority metadata BEFORE its body read; NOWAIT preserves closure/reparent lock order.
 * The fixed SQL helper knows the closure; callers cannot submit an authority list. */
export async function lockReadAuthorityBeforeBody(
  tx: Tx,
  context: AgentContext,
  input: { kind: string; id: string; authorizationWorkUnitId?: string },
) {
  const result = await tx.execute<{ locked: boolean }>(sql`select ai.lock_read_authority(
    ${input.kind},${input.id}::uuid,${input.authorizationWorkUnitId ?? null}::uuid) locked`);
  if (context.actorType !== 'agent' || result.rows[0]?.locked !== true)
    throw new AppError('NOT_FOUND');
}

/** Durable before material leaves. SQL computes the actual locked closure and its digest; defaults
 * are not an empty-inventory capability. A repeated body hash can acquire another genuine closure. */
export async function captureReadAuthoritiesInTx(
  tx: Tx,
  context: AgentContext,
  inputs: readonly { kind: string; id: string; sha256: string; authorizationWorkUnitId?: string }[],
) {
  const state = await tx.execute<{ protocol: string | null }>(
    sql`select ai.run_authority_protocol_version(${context.agentRunId}::uuid) protocol`,
  );
  if (state.rows[0]?.protocol === 'legacy') return;
  if (context.actorType !== 'agent' || state.rows[0]?.protocol !== 'authority-v1')
    throw new AppError('POLICY_DENIED');
  for (const input of [...inputs].sort((a, b) =>
    `${a.kind}:${a.id}:${a.sha256}`.localeCompare(`${b.kind}:${b.id}:${b.sha256}`),
  )) {
    if ((input.kind === 'artifact') !== (input.authorizationWorkUnitId !== undefined))
      throw new AppError('POLICY_DENIED');
    await tx
      .insert(runReadAuthorities)
      .values({
        organizationId: context.organizationId,
        runId: context.agentRunId,
        inputKind: input.kind,
        inputId: input.id,
        inputSha256: input.sha256,
        authorizationWorkUnitId: input.authorizationWorkUnitId ?? null,
      })
      .onConflictDoNothing();
  }
}
