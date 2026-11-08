// Actual run admission immediately before a main model reservation. Metadata only: no prompt/body,
// synthetic AgentContext, reconstructed observation or service-viewer substitution is accepted.
import {
  agentRuns,
  executionSteps,
  memberships,
  mainInputSnapshots,
  modelProfiles,
  withTenantTx,
  type AgentContext,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import { and, eq, sql } from 'drizzle-orm';
import {
  AGENT_TURN_PURPOSE,
  strongestClassification,
  type AiClassification,
  type AiReasonCode,
} from '@ensemus/domain/ai';
import { AppError } from '../errors';
import { toRoutableProfile } from './model-profiles';
import { loadTenantPolicyBundleInTx } from './egress-log';
import { decideEgress } from '@ensemus/policy';
import { loadAgentReadScopeInTx } from './read-scope';
import { idSchema } from '../ids';

const classes = ['public', 'internal', 'confidential', 'restricted'] as const;
const knownClass = (value: unknown): value is AiClassification =>
  classes.includes(value as AiClassification);
export const isMainInputDenied = (error: unknown) =>
  error instanceof AppError && error.code === 'POLICY_DENIED';
/** Actual company influences must exist before dispatch; birth completeness alone is not input evidence. */
export async function currentRunInputClassInTx(
  tx: Tx,
  context: AgentContext,
): Promise<AiClassification> {
  const proof = await loadAgentReadScopeInTx(tx, context, undefined, { lockRun: true });
  if (!proof.hasTargetWork) throw new AppError('POLICY_DENIED');
  return proof.companyClassification;
}
export async function currentRunInputClass(database: AppDatabase, context: AgentContext) {
  return withTenantTx(database, context, (tx) => currentRunInputClassInTx(tx, context));
}
/** Pins the actual originating model attempt before any completion/proposal payload mutation. */
export async function bindModelResultWriteInTx(
  tx: Tx,
  context: AgentContext,
  input: { stepId: string; attempt: number; classification: AiClassification; stepNumber?: number },
) {
  await tx.execute(sql`select set_config('app.knowledge_model_protocol','',true)`);
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
    throw new AppError('POLICY_DENIED');
  const floor = await currentRunInputClassInTx(tx, context);
  if (strongestClassification(floor, input.classification) !== input.classification)
    throw new AppError('POLICY_DENIED');
  const [step] = await tx
    .select()
    .from(executionSteps)
    .where(and(eq(executionSteps.id, input.stepId), eq(executionSteps.runId, context.agentRunId)))
    .for('update', { noWait: true });
  if (
    !step ||
    step.kind !== 'model_turn' ||
    step.state !== 'in_flight' ||
    step.attempt !== input.attempt ||
    (input.stepNumber !== undefined && step.stepNumber !== input.stepNumber)
  )
    throw new AppError('POLICY_DENIED');
  await tx.execute(
    sql`select set_config('app.knowledge_model_protocol',${`model-result-v1:${context.agentRunId}:${step.id}:${input.attempt}`},true)`,
  );
}
const fits = (limit: number, ...values: (number | string)[]) =>
  Number.isSafeInteger(limit) &&
  values.every((v) =>
    typeof v === 'string' ? /^\d+$/.test(v) : Number.isSafeInteger(v) && v >= 0,
  ) &&
  values.reduce<bigint>((sum, v) => sum + BigInt(v), 0n) <= BigInt(limit);
export type MainModelAdmission = {
  runId: string;
  stepId: string;
  attempt: number;
  agentVersionId: string;
  workUnitId: string;
  purpose: string;
  classification: AiClassification;
  profileId: string;
  profileVersion: number;
  reservationAttempt: number;
  ceiling: { inputTokens: number; outputTokens: number };
  costMicros: number;
  priorUsage: { inputTokens: number; outputTokens: number; costMicros: number };
  /** Issued by the actual gateway, never compiler/model/tool args. Unique writer claim per invocation. */
  snapshot?: {
    id: string;
    writerToken: string;
    requestHash: string;
    phase: 'prepare' | 'dispatch';
  };
};

async function admitMainInputSnapshotInTx(
  tx: Tx,
  context: AgentContext,
  input: MainModelAdmission,
) {
  const snapshot = input.snapshot;
  if (
    !snapshot ||
    !idSchema.safeParse(snapshot.id).success ||
    !idSchema.safeParse(snapshot.writerToken).success ||
    !/^[0-9a-f]{64}$/.test(snapshot.requestHash)
  )
    return false;
  if (snapshot.phase === 'prepare') {
    const current = await tx.execute<{
      inventory: unknown;
      hash: string;
    }>(sql`with current_inputs as(select ai.current_main_input_inventory(${context.agentRunId}::uuid) inventory)
      select inventory,encode(sha256(convert_to(inventory::text,'UTF8')),'hex') hash from current_inputs`);
    const proof = current.rows[0];
    if (
      !proof ||
      !Array.isArray(proof.inventory) ||
      proof.inventory.length < 1 ||
      proof.inventory.length > 1000
    )
      return false;
    const [created] = await tx
      .insert(mainInputSnapshots)
      .values({
        organizationId: context.organizationId,
        id: snapshot.id,
        runId: input.runId,
        stepId: input.stepId,
        attempt: input.attempt,
        reservationAttempt: input.reservationAttempt,
        writerToken: snapshot.writerToken,
        requestHash: snapshot.requestHash,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        maxInputTokens: input.ceiling.inputTokens,
        maxOutputTokens: input.ceiling.outputTokens,
        viewerMembershipId: context.membershipId,
        inputInventory: proof.inventory,
        inventorySha256: proof.hash,
      })
      .onConflictDoNothing()
      .returning({ id: mainInputSnapshots.id });
    // Never let a duplicate invocation borrow another invocation's hold and then release it.
    return created?.id === snapshot.id;
  }
  if (snapshot.phase !== 'dispatch') return false;
  const [claimed] = await tx
    .update(mainInputSnapshots)
    .set({ state: 'dispatched' })
    .where(
      and(
        eq(mainInputSnapshots.id, snapshot.id),
        eq(mainInputSnapshots.runId, input.runId),
        eq(mainInputSnapshots.stepId, input.stepId),
        eq(mainInputSnapshots.attempt, input.attempt),
        eq(mainInputSnapshots.reservationAttempt, input.reservationAttempt),
        eq(mainInputSnapshots.writerToken, snapshot.writerToken),
        eq(mainInputSnapshots.requestHash, snapshot.requestHash),
        eq(mainInputSnapshots.profileId, input.profileId),
        eq(mainInputSnapshots.profileVersion, input.profileVersion),
        eq(mainInputSnapshots.state, 'prepared'),
      ),
    )
    .returning({ id: mainInputSnapshots.id });
  return claimed?.id === snapshot.id;
}

/** Records only the hash of an already validated adapter response after canonical usage settlement.
 * No unconfirmed network attempt or stale original attempt can become delegation authority. */
export async function receiveMainInputSnapshotInTx(
  tx: Tx,
  context: AgentContext,
  input: {
    snapshotId: string;
    writerToken: string;
    kind: 'final' | 'tool_call';
    toolId: string | null;
    payloadHash: string;
  },
) {
  if (
    !idSchema.safeParse(input.snapshotId).success ||
    !idSchema.safeParse(input.writerToken).success ||
    !/^[0-9a-f]{64}$/.test(input.payloadHash)
  )
    throw new AppError('POLICY_DENIED');
  const [snapshot] = await tx
    .select()
    .from(mainInputSnapshots)
    .where(
      and(
        eq(mainInputSnapshots.id, input.snapshotId),
        eq(mainInputSnapshots.runId, context.agentRunId),
        eq(mainInputSnapshots.writerToken, input.writerToken),
        eq(mainInputSnapshots.state, 'dispatched'),
      ),
    );
  const [run] = await tx
    .select({ classification: agentRuns.effectiveClassification })
    .from(agentRuns)
    .where(eq(agentRuns.id, context.agentRunId));
  if (!snapshot || !run || !knownClass(run.classification)) throw new AppError('POLICY_DENIED');
  await bindModelResultWriteInTx(tx, context, {
    stepId: snapshot.stepId,
    attempt: snapshot.attempt,
    classification: run.classification,
  });
  const [received] = await tx
    .update(mainInputSnapshots)
    .set({
      state: 'response_received',
      resultKind: input.kind,
      resultToolId: input.toolId,
      resultPayloadHash: input.payloadHash,
    })
    .where(
      and(
        eq(mainInputSnapshots.id, snapshot.id),
        eq(mainInputSnapshots.writerToken, input.writerToken),
        eq(mainInputSnapshots.state, 'dispatched'),
      ),
    )
    .returning({ id: mainInputSnapshots.id });
  if (!received) throw new AppError('POLICY_DENIED');
}
/** Must run inside the very reservation transaction, after current body locks and before money moves. */
export async function admitMainModelInTx(
  tx: Tx,
  context: AgentContext,
  input: MainModelAdmission,
): Promise<AiReasonCode | null> {
  // A later refusal in this transaction must not inherit an earlier successful admission scope.
  await tx.execute(sql`select set_config('app.knowledge_model_protocol','',true)`);
  if (
    context.actorType !== 'agent' ||
    input.runId !== context.agentRunId ||
    input.purpose !== AGENT_TURN_PURPOSE
  )
    return 'POLICY_UNREADABLE';
  const floor = await currentRunInputClassInTx(tx, context);
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.id, context.membershipId), eq(memberships.status, 'active')))
    .for('share', { noWait: true });
  const [run] = await tx
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, input.runId))
    .for('update', { noWait: true });
  if (
    !member ||
    !run ||
    run.status !== 'running' ||
    run.initiatorMembershipId !== context.membershipId ||
    run.workUnitId !== input.workUnitId ||
    run.agentVersionId !== input.agentVersionId
  )
    return 'INITIATOR_INACTIVE';
  const [step] = await tx
    .select({ id: executionSteps.id })
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.id, input.stepId),
        eq(executionSteps.runId, run.id),
        eq(executionSteps.attempt, input.attempt),
        eq(executionSteps.state, 'in_flight'),
        eq(executionSteps.kind, 'model_turn'),
      ),
    );
  if (!step) return 'INITIATOR_INACTIVE';
  if (
    !knownClass(run.effectiveClassification) ||
    classes.indexOf(input.classification) <
      classes.indexOf(strongestClassification(floor, run.effectiveClassification))
  )
    return 'CLASS_DENIED';
  if (
    run.boundProfileId &&
    (run.boundProfileId !== input.profileId || run.boundProfileVersion !== input.profileVersion)
  )
    return 'PROFILE_CHANGED';
  const pending = await tx.execute<{
    cost: string;
    tokens: string;
    legacy: number;
    unconfirmed: number;
    accounted_cost: string;
    accounted_tokens: string;
  }>(sql`select
    greatest(${run.costMicros}::bigint,(select coalesce(sum(cost_micros),0) from platform.usage_ledger where organization_id=${context.organizationId}::uuid and run_id=${run.id}::uuid))::text accounted_cost,
    greatest(${run.inputTokens}::bigint+${run.outputTokens}::bigint,
      (select coalesce(sum(quantity),0) from platform.usage_ledger where organization_id=${context.organizationId}::uuid and run_id=${run.id}::uuid and model_call_id is null and meter in('model_input_tokens','model_output_tokens'))
      +(select coalesce(sum(case when status='estimated' then max_input_tokens::bigint+max_output_tokens::bigint else coalesce(input_tokens,0)::bigint+coalesce(output_tokens,0)::bigint end),0) from ai.model_call_attempts where organization_id=${context.organizationId}::uuid and run_id=${run.id}::uuid and state not in('prepared','dispatched')))::text accounted_tokens,
    (select coalesce(sum(v.amount),0)::text from(select max(amount_micros) amount from platform.budget_reservations where organization_id=${context.organizationId}::uuid and run_id=${run.id}::uuid and status='held' and not(model_call_id is null and step_id=${input.stepId}::uuid and attempt=${input.reservationAttempt}) group by model_call_id,step_id,attempt)v) cost,
    (select coalesce(sum(max_input_tokens::bigint+max_output_tokens::bigint),0)::text from ai.model_call_attempts where organization_id=${context.organizationId}::uuid and run_id=${run.id}::uuid and state in('prepared','dispatched')) tokens,
    (select count(*)::int from platform.budget_reservations where organization_id=${context.organizationId}::uuid and run_id=${run.id}::uuid and status='held' and model_call_id is null and not(step_id=${input.stepId}::uuid and attempt=${input.reservationAttempt})) legacy,
    (select count(*)::int from ai.model_call_attempts where organization_id=${context.organizationId}::uuid and run_id=${run.id}::uuid and state in('dispatched','unknown')) unconfirmed`);
  const held = pending.rows[0];
  if (held && held.unconfirmed > 0) return 'POLICY_UNREADABLE';
  // Canonical rows include already settled fallback calls even if completeTurn has not posted its
  // counters yet. Auxiliary unknown quantities use their admitted token ceiling, never a zero guess.
  if (
    !held ||
    held.legacy > 0 ||
    run.modelTurns >= run.maxModelTurns ||
    !fits(run.maxCostMicros, held.accounted_cost, held.cost, input.costMicros) ||
    !fits(
      run.maxTotalTokens,
      held.accounted_tokens,
      held.tokens,
      input.ceiling.inputTokens,
      input.ceiling.outputTokens,
    )
  )
    return 'BUDGET_EXHAUSTED';
  await tx.execute(
    sql`select set_config('app.knowledge_model_protocol',${`main-v1:${run.id}:${input.stepId}:${input.reservationAttempt}:${input.costMicros}`},true)`,
  );
  return null;
}

/** Production main dispatch binding: exact current profile/version and actual tenant tightening. */
export async function admitMainModelDispatchInTx(
  tx: Tx,
  context: AgentContext,
  input: MainModelAdmission,
): Promise<AiReasonCode | null> {
  const denial = await admitMainModelInTx(tx, context, input);
  if (denial) return denial;
  const refuse = async (code: AiReasonCode) => {
    await tx.execute(sql`select set_config('app.knowledge_model_protocol','',true)`);
    return code;
  };
  const [row] = await tx
    .select()
    .from(modelProfiles)
    .where(eq(modelProfiles.id, input.profileId))
    .for('share', { noWait: true });
  if (!row || row.version !== input.profileVersion || row.status !== 'active')
    return refuse('PROFILE_CHANGED');
  const profile = toRoutableProfile(row);
  if (
    input.ceiling.inputTokens > profile.limits.maxInputTokens ||
    input.ceiling.outputTokens > profile.limits.maxOutputTokens
  )
    return refuse('BUDGET_EXHAUSTED');
  const decision = decideEgress({
    dataClass: input.classification,
    purpose: AGENT_TURN_PURPOSE,
    requiredRegion: null,
    profile: { ...profile, active: true, destinationHost: new URL(profile.endpointUrl).hostname },
    bundle: await loadTenantPolicyBundleInTx(tx, context),
    now: new Date(),
  });
  if (decision.decision !== 'allow') return refuse(decision.reasonCode);
  return (await admitMainInputSnapshotInTx(tx, context, input))
    ? null
    : refuse('POLICY_UNREADABLE');
}
