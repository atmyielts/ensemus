// Actual run admission immediately before a main model reservation. Metadata only: no prompt/body,
// synthetic AgentContext, reconstructed observation or service-viewer substitution is accepted.
import {
  agentRuns,
  executionSteps,
  memberships,
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
import { lockRunInputsForContent } from './input-observations';
import { toRoutableProfile } from './model-profiles';
import { loadTenantPolicyBundleInTx } from './egress-log';
import { decideEgress } from '@ensemus/policy';

const classes = ['public', 'internal', 'confidential', 'restricted'] as const;
const knownClass = (value: unknown): value is AiClassification =>
  classes.includes(value as AiClassification);
export const isMainInputDenied = (error: unknown) =>
  error instanceof AppError && error.code === 'POLICY_DENIED';
type Ref = { kind: string; id: string };
/** Current class of every retained prior influence, including dropped retrieval candidates and files
 * whose original records were later reparented. Historical hashes are never compared with mutable rows. */
export async function currentRunInputClassInTx(
  tx: Tx,
  context: AgentContext,
): Promise<AiClassification> {
  if (context.actorType !== 'agent') throw new AppError('FORBIDDEN');
  const inventory = sql`with observations as(
    select input_kind kind,input_id id from ai.run_input_observations where organization_id=${context.organizationId}::uuid and run_id=${context.agentRunId}::uuid
  ), nodes as(
    select id from observations where kind='artifact'
    union select i.input_artifact_id from knowledge.artifact_lineage_inputs i join observations o on o.kind='artifact' and o.id=i.artifact_id where i.organization_id=${context.organizationId}::uuid
  ), package_ids as(
    select p.id from knowledge.evidence_packages p where p.organization_id=${context.organizationId}::uuid and p.run_id=${context.agentRunId}::uuid
    union select p.package_id from knowledge.artifact_lineage_packages p join nodes n on n.id=p.artifact_id where p.organization_id=${context.organizationId}::uuid
    union select p.id from knowledge.evidence_packages p join knowledge.artifact_lineage l on l.organization_id=p.organization_id and l.execution_kind='agent_run' and l.execution_id=p.run_id join nodes n on n.id=l.artifact_id where p.organization_id=${context.organizationId}::uuid
  ), call_inputs as(
    select i.kind,i.input_id id,i.source_id from ai.model_call_inputs i join ai.model_call_attempts c on c.organization_id=i.organization_id and c.id=i.call_id where c.organization_id=${context.organizationId}::uuid and c.run_id=${context.agentRunId}::uuid
  ), chunk_refs as(
    select i.chunk_id id from knowledge.evidence_items i join package_ids p on p.id=i.package_id where i.organization_id=${context.organizationId}::uuid
    union select c.chunk_id from knowledge.artifact_citations c join nodes n on n.id=c.artifact_id where c.organization_id=${context.organizationId}::uuid
    union select id from call_inputs where kind='chunk'
  ), all_refs as(
    select kind,id from observations
    union select 'artifact',id from nodes
    union select r.record_kind,r.record_id from observations o cross join lateral knowledge.artifact_required_records(o.id) r where o.kind='artifact'
    union select kind,id from call_inputs where kind<>'chunk'
    union select 'chunk',id from chunk_refs
    union select 'document',i.document_id from knowledge.evidence_items i join package_ids p on p.id=i.package_id where i.organization_id=${context.organizationId}::uuid
    union select 'document',ch.document_id from knowledge.chunks ch join chunk_refs r on r.id=ch.id where ch.organization_id=${context.organizationId}::uuid
    union select 'source',i.source_id from knowledge.evidence_items i join package_ids p on p.id=i.package_id where i.organization_id=${context.organizationId}::uuid
    union select 'source',source_id from call_inputs where source_id is not null
    union select 'source',knowledge.artifact_required_sources(o.id) from observations o where o.kind='artifact'
  ), current_projects as(
    select id from all_refs where kind='project'
    union select c.parent_record_id from knowledge.structured_record_catalog c join all_refs r on r.kind='work_unit' and r.id=c.record_id
      where c.organization_id=${context.organizationId}::uuid and c.record_kind='work_unit' and c.parent_record_id is not null
  ), scoped_refs as(
    select kind,id from all_refs
    union select 'project',id from current_projects
    union select 'client',c.parent_record_id from knowledge.structured_record_catalog c join current_projects p on p.id=c.record_id
      where c.organization_id=${context.organizationId}::uuid and c.record_kind='project' and c.parent_record_id is not null
  ) select kind,id from scoped_refs order by kind COLLATE "C",id limit 1001`;
  const refs = await tx.execute<Ref>(inventory);
  if (refs.rows.length === 0 || refs.rows.length > 1000) throw new AppError('POLICY_DENIED');
  const byKind = (kind: string) =>
    refs.rows.filter((ref) => ref.kind === kind).map((ref) => ref.id);
  // Sources/documents before metadata/checkpoints, matching close/purge and existing Knowledge writes.
  let floor: AiClassification = 'public';
  const add = (value: unknown) => {
    if (!knownClass(value)) throw new AppError('POLICY_DENIED');
    floor = strongestClassification(floor, value);
  };
  const ids = (values: readonly string[]) =>
    sql.join(
      values.map((value) => sql`${value}::uuid`),
      sql`,`,
    );
  const sources = byKind('source'),
    documents = byKind('document'),
    chunks = byKind('chunk');
  if (sources.length) {
    const result = await tx.execute<{ classification: string; readable: boolean }>(
      sql`select s.classification,s.state='active' and s.id in(select knowledge.readable_source_ids(${context.membershipId}::uuid)) readable from knowledge.sources s where s.organization_id=${context.organizationId}::uuid and s.id in(${ids(sources)}) order by s.id for share nowait`,
    );
    if (result.rows.length !== sources.length || result.rows.some((row) => !row.readable))
      throw new AppError('POLICY_DENIED');
    for (const row of result.rows) add(row.classification);
  }
  if (documents.length) {
    const result = await tx.execute<{ classification: string }>(
      sql`select d.classification from knowledge.documents d where d.organization_id=${context.organizationId}::uuid and d.id in(${ids(documents)}) order by d.id for share nowait`,
    );
    if (result.rows.length !== documents.length) throw new AppError('POLICY_DENIED');
    for (const row of result.rows) add(row.classification);
  }
  if (chunks.length) {
    const result = await tx.execute<{ classification: string }>(
      sql`select d.classification from knowledge.chunks c join knowledge.documents d on d.organization_id=c.organization_id and d.id=c.document_id where c.organization_id=${context.organizationId}::uuid and c.id in(${ids(chunks)})`,
    );
    if (result.rows.length !== chunks.length) throw new AppError('POLICY_DENIED');
    for (const row of result.rows) add(row.classification);
  }
  for (const artifactId of byKind('artifact')) {
    await tx.execute(sql`select knowledge.lock_artifact_catalog(${artifactId}::uuid)`);
    const result = await tx.execute<{ classification: string; readable: boolean }>(
      sql`select a.classification,a.alive and knowledge.artifact_readable(a.artifact_id,${context.membershipId}::uuid) readable from knowledge.artifact_acl_catalog a where a.organization_id=${context.organizationId}::uuid and a.artifact_id=${artifactId}::uuid`,
    );
    if (result.rows.length !== 1 || !result.rows[0]?.readable) throw new AppError('POLICY_DENIED');
    add(result.rows[0].classification);
  }
  for (const ref of refs.rows.filter(
    (ref) => !['source', 'document', 'chunk', 'artifact'].includes(ref.kind),
  )) {
    const locked = await tx.execute<{ locked: boolean }>(
      sql`select knowledge.lock_structured_record(${ref.kind},${ref.id}::uuid) locked`,
    );
    if (locked.rows[0]?.locked !== true) throw new AppError('POLICY_DENIED');
    const result = await tx.execute<{ classification: string; readable: boolean }>(
      sql`select knowledge.structured_record_class(${ref.kind},${ref.id}::uuid) classification,knowledge.structured_record_readable(${ref.kind},${ref.id}::uuid,${context.membershipId}::uuid) readable`,
    );
    if (result.rows[0]?.readable !== true) throw new AppError('POLICY_DENIED');
    add(result.rows[0].classification);
  }
  await lockRunInputsForContent(tx, context);
  await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.id, context.agentRunId))
    .for('update', { noWait: true });
  const checked = await tx.execute<Ref>(inventory);
  if (JSON.stringify(checked.rows) !== JSON.stringify(refs.rows))
    throw new AppError('POLICY_DENIED');
  return floor;
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
};
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
  return decision.decision === 'allow' ? null : refuse(decision.reasonCode);
}
