// Worker-only authority and canonical money for actual Knowledge model operations. No transaction
// spans a provider call. Explicit real run/job identities remain exclusive in SQL and in this DAL.
import { randomUUID } from 'node:crypto';
import {
  agentRuns,
  budgetReservations,
  budgets,
  egressDecisions,
  executionSteps,
  knowledgeAnswerSources,
  knowledgeChunks,
  knowledgeEvidencePackages,
  knowledgeEvidenceItems,
  knowledgeModelCalls,
  knowledgeSources,
  memberships,
  modelCallAttempts,
  modelCallInputs,
  modelJobs,
  modelOperationQualifications,
  modelProfiles,
  modelWorkloadApprovals,
  modelWorkloadProfiles,
  organizations,
  rateCards,
  runInputCheckpoints,
  usageLedger,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  operationHash,
  operationKey,
  qualificationOperation,
  modelInputInventoryHash,
} from '@ensemus/knowledge/model-operations';
import { ModelCallFailed, type ModelUsage } from '@ensemus/knowledge/ports';
import {
  modelBoundsWithin,
  qualifiedFor,
  type KnowledgeModelPurpose,
  type QualifiedModelOperation,
} from '@ensemus/domain/knowledge-models';
import {
  isTerminalAgentRun,
  type AgentRunStatus,
  type BillingOwner,
  type ProviderKind,
} from '@ensemus/domain/ai';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { pickBounds } from '../knowledge/model-jobs';
import { toRoutableProfile } from './model-profiles';
import { billingPeriodOf, costMicros, isBillable } from './usage';
import { createHaltCheck } from './halt';
import { assertRunInputsReadable, lockRunInputsForContent } from './input-observations';
import { assertWithinAgentProtection, loadAgentReadScopeInTx } from './read-scope';
import type { HaltCheck, RateCardRef } from './ports';
import type {
  KnowledgeCallStore,
  KnowledgeCloudSpend,
  KnowledgeModelCandidate,
  KnowledgeModelPrincipal,
} from './knowledge-ports';

const fail = (
  code:
    | 'NO_APPROVED_MODEL'
    | 'EGRESS_DENIED'
    | 'BUDGET_EXHAUSTED'
    | 'MODEL_UNAVAILABLE' = 'EGRESS_DENIED',
) => new ModelCallFailed(code);
const rank = (value: string) => ['public', 'internal', 'confidential', 'restricted'].indexOf(value);
const fits = (limit: number, ...values: (number | string)[]) => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    values.some((value) =>
      typeof value === 'number' ? !Number.isSafeInteger(value) || value < 0 : !/^\d+$/.test(value),
    )
  )
    return false;
  return values.reduce<bigint>((sum, value) => sum + BigInt(value), 0n) <= BigInt(limit);
};
const id = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
type AccountingPrincipal =
  | { kind: 'job'; context: TenantContext; jobId: string }
  | {
      kind: 'agent_run';
      context: TenantContext;
      step: Extract<KnowledgeModelPrincipal, { kind: 'agent_run' }>['step'];
    };
export interface KnowledgeCallAccounting {
  reconcileJob(context: TenantContext, jobId: string): Promise<void>;
  /** Agent-role, metadata-only reconciliation after the real run is terminal and permanently fenced. */
  reconcileRun(context: TenantContext, runId: string): Promise<void>;
}
const shape = (principal: AccountingPrincipal) =>
  principal.kind === 'job'
    ? { modelJobId: principal.jobId, runId: null, stepId: null }
    : { modelJobId: null, runId: principal.step.runId, stepId: principal.step.stepId };
export async function bindModelPrincipal(tx: Tx, principal: KnowledgeModelPrincipal) {
  const c = principal.context;
  if (
    (principal.kind === 'job' && c.actorType !== 'delegated' && c.actorType !== 'user') ||
    (principal.kind === 'agent_run' &&
      (c.actorType !== 'agent' || c.agentRunId !== principal.step.runId))
  )
    throw fail();
  await tx.execute(
    sql`select set_config('app.knowledge_model_protocol','v1',true),set_config('app.model_job_id',${principal.kind === 'job' ? id(principal.jobId) : ''},true)`,
  );
}
export async function withModelPrincipalTx<T>(
  database: AppDatabase,
  principal: KnowledgeModelPrincipal,
  use: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTenantTx(database, principal.context, async (tx) => {
    await bindModelPrincipal(tx, principal);
    return use(tx);
  });
}
async function ownAttempt(tx: Tx, principal: AccountingPrincipal, callId: string, lock = false) {
  const where = and(
    eq(modelCallAttempts.id, id(callId)),
    principal.kind === 'job'
      ? eq(modelCallAttempts.jobId, principal.jobId)
      : and(
          eq(modelCallAttempts.runId, principal.step.runId),
          eq(modelCallAttempts.stepId, principal.step.stepId),
        ),
  );
  const query = tx.select().from(modelCallAttempts).where(where);
  const [call] = await (lock ? query.for('update') : query);
  if (!call) throw fail();
  return call;
}
async function requireNamedMember(tx: Tx, principal: KnowledgeModelPrincipal) {
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.id, principal.context.membershipId), eq(memberships.status, 'active')),
    )
    .for('share', { noWait: true });
  if (!member) throw fail();
}
async function principalFacts(tx: Tx, principal: AccountingPrincipal, lock = false) {
  if (principal.kind === 'job') {
    const query = tx.select().from(modelJobs).where(eq(modelJobs.id, principal.jobId));
    const [job] = await (lock ? query.for('update') : query);
    if (
      !job ||
      (principal.context.actorType !== 'service' &&
        job.requesterMembershipId !== principal.context.membershipId)
    )
      throw fail();
    return { kind: 'job' as const, job };
  }
  const query = tx.select().from(agentRuns).where(eq(agentRuns.id, principal.step.runId));
  const [run] = await (lock ? query.for('update') : query);
  if (
    !run ||
    (principal.context.actorType !== 'service' &&
      run.initiatorMembershipId !== principal.context.membershipId) ||
    run.workUnitId !== principal.step.workUnitId ||
    run.agentVersionId !== principal.step.agentVersionId
  )
    throw fail();
  return { kind: 'agent_run' as const, run };
}

/** Fresh body/catalog locks precede checkpoint/attempt locks for dispatch and result publication. */
export async function lockKnowledgeModelInputs(
  tx: Tx,
  inputs: readonly { kind: string; id: string; sourceId?: string }[],
) {
  if (
    !Array.isArray(inputs) ||
    inputs.length > 1000 ||
    inputs.some((value) => !['chunk', 'work_unit', 'project', 'client'].includes(value.kind))
  )
    throw fail();
  const sourceIds = [
    ...new Set(
      inputs.filter((value) => value.kind === 'chunk').map((value) => id(value.sourceId ?? '')),
    ),
  ].sort();
  if (sourceIds.length)
    await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(inArray(knowledgeSources.id, sourceIds))
      .orderBy(asc(knowledgeSources.id))
      .for('share', { noWait: true });
  const chunkIds = [
    ...new Set(inputs.filter((value) => value.kind === 'chunk').map((value) => id(value.id))),
  ].sort();
  if (chunkIds.length)
    await tx.execute(
      sql`select d.id from knowledge.documents d where d.organization_id=app.current_organization_id() and d.id in(select c.document_id from knowledge.chunks c where c.organization_id=d.organization_id and c.id in(${sql.join(
        chunkIds.map((value) => sql`${value}::uuid`),
        sql`,`,
      )})) order by d.id for share nowait`,
    );
  for (const value of [...inputs]
    .filter((value) => value.kind !== 'chunk')
    .sort((a, b) => {
      const left = `${a.kind}:${a.id}`,
        right = `${b.kind}:${b.id}`;
      return left < right ? -1 : left > right ? 1 : 0;
    })) {
    const result = await tx.execute<{ locked: boolean }>(
      sql`select knowledge.lock_structured_record(${value.kind},${id(value.id)}::uuid) as locked`,
    );
    if (!result.rows[0]?.locked) throw fail();
  }
}

/** The actual immutable manifest narrows both the current operation and every retained prior
 * influence. This is content admission only; late accounting settlement deliberately remains open. */
export async function assertKnowledgeAgentScopeInTx(
  tx: Tx,
  principal: KnowledgeModelPrincipal,
  classification: string,
  inputs: readonly { kind: string; sourceId?: string | null }[],
) {
  if (principal.kind !== 'agent_run') return;
  const scope = await loadAgentReadScopeInTx(tx, principal.context, principal.step, {
    lockRun: true,
  });
  if (
    !scope.sourceIds.length ||
    rank(classification) < 0 ||
    inputs.some(
      (input) => input.kind === 'chunk' && !scope.sourceIds.includes(input.sourceId ?? ''),
    )
  )
    throw fail();
  assertWithinAgentProtection(
    scope,
    classification as import('@ensemus/domain/ai').AiClassification,
  );
  if (!scope.hasTargetWork || rank(classification) < rank(scope.companyClassification))
    throw fail();
}

export function createKnowledgeCallStore(
  database: AppDatabase,
  options: { halt?: HaltCheck; cloudSpend?: KnowledgeCloudSpend; now?: () => Date } = {},
): KnowledgeCallStore & KnowledgeCallAccounting {
  const halt = options.halt ?? createHaltCheck(),
    now = options.now ?? (() => new Date());
  const candidatesInTx = async (
    tx: Tx,
    principal: KnowledgeModelPrincipal,
    purpose: KnowledgeModelPurpose,
  ): Promise<KnowledgeModelCandidate[]> => {
    const facts = await principalFacts(tx, principal);
    let approvals: (typeof modelWorkloadApprovals.$inferSelect)[] = [],
      qualifying = false;
    let bounds,
      deadlineAt: Date,
      qualificationId: string | null = null;
    if (facts.kind === 'job') {
      const j = facts.job;
      if (!['prepared', 'running'].includes(j.state) || j.fencedAt || j.deadlineAt <= now())
        return [];
      bounds = pickBounds(j);
      deadlineAt = j.deadlineAt;
      if (j.kind === 'qualification') {
        qualifying = true;
        qualificationId = j.qualificationId;
      } else
        approvals = await tx
          .select()
          .from(modelWorkloadApprovals)
          .where(
            and(
              eq(modelWorkloadApprovals.id, j.approvalId!),
              isNull(modelWorkloadApprovals.revokedAt),
              sql`${modelWorkloadApprovals.expiresAt}>${now()}`,
            ),
          );
    } else {
      const r = facts.run;
      if (r.status !== 'running') return [];
      if (principal.kind !== 'agent_run') throw fail();
      await assertRunInputsReadable(tx, principal.context);
      approvals = await tx
        .select()
        .from(modelWorkloadApprovals)
        .where(
          and(
            eq(modelWorkloadApprovals.kind, 'agent_context'),
            isNull(modelWorkloadApprovals.revokedAt),
            sql`${modelWorkloadApprovals.expiresAt}>${now()}`,
          ),
        )
        .orderBy(asc(modelWorkloadApprovals.id));
      deadlineAt = new Date(now().getTime() + Math.max(0, r.timeoutSeconds * 1000 - r.activeMs));
    }
    const out: KnowledgeModelCandidate[] = [];
    const rows = await tx
      .select({ q: modelOperationQualifications, p: modelProfiles })
      .from(modelOperationQualifications)
      .innerJoin(
        modelProfiles,
        and(
          eq(modelProfiles.organizationId, modelOperationQualifications.organizationId),
          eq(modelProfiles.id, modelOperationQualifications.profileId),
        ),
      )
      .where(
        and(
          eq(modelOperationQualifications.purpose, purpose),
          qualificationId
            ? eq(modelOperationQualifications.id, qualificationId)
            : eq(modelOperationQualifications.state, 'passed'),
        ),
      )
      .orderBy(asc(modelProfiles.id), asc(modelOperationQualifications.id));
    for (const row of rows) {
      const q = row.q as QualifiedModelOperation,
        p = toRoutableProfile(row.p);
      if (
        qualifying
          ? q.state !== 'requested' || p.status !== 'probing' || q.profileVersion !== p.version
          : !qualifiedFor(q, p, purpose) || p.status !== 'active'
      )
        continue;
      const [card] = await tx
        .select()
        .from(rateCards)
        .where(eq(rateCards.profileId, p.id))
        .orderBy(desc(rateCards.version))
        .limit(1);
      if (!card) continue;
      const rateCard: RateCardRef = {
        id: card.id,
        version: card.version,
        inputMicrosPerMtok: card.inputMicrosPerMtok,
        outputMicrosPerMtok: card.outputMicrosPerMtok,
        source: card.source as RateCardRef['source'],
      };
      if (qualifying) {
        out.push({
          profile: p,
          qualification: q,
          rateCard,
          approvalId: null,
          bounds: bounds!,
          deadlineAt,
          qualifying: true,
        });
        continue;
      }
      for (const approval of approvals) {
        if (!approval.purposes.includes(purpose)) continue;
        const [binding] = await tx
          .select({ id: modelWorkloadProfiles.qualificationId })
          .from(modelWorkloadProfiles)
          .where(
            and(
              eq(modelWorkloadProfiles.approvalId, approval.id),
              eq(modelWorkloadProfiles.qualificationId, q.id),
            ),
          );
        if (!binding) continue;
        if (
          facts.kind === 'job' &&
          (!modelBoundsWithin(facts.job, approval) || approval.kind !== facts.job.kind)
        )
          continue;
        out.push({
          profile: p,
          qualification: q,
          rateCard,
          approvalId: approval.id,
          bounds: bounds ?? pickBounds(approval),
          deadlineAt: new Date(Math.min(deadlineAt.getTime(), approval.expiresAt.getTime())),
          qualifying: false,
        });
      }
    }
    return out;
  };
  const settleInTx = async (
    tx: Tx,
    principal: AccountingPrincipal,
    callId: string,
    result: {
      usage: { inputTokens: number; outputTokens: number } | null;
      mayHaveBilled: boolean;
      reasonCode: string | null;
    },
  ): Promise<ModelUsage> => {
    const facts = await principalFacts(tx, principal, true),
      c = await ownAttempt(tx, principal, callId, true);
    if (!['prepared', 'dispatched'].includes(c.state))
      return {
        inputTokens: c.inputTokens ?? 0,
        outputTokens: c.outputTokens ?? 0,
        costMicros: c.costMicros,
        callId: c.id,
      };
    const [card] = await tx
      .select()
      .from(rateCards)
      .where(and(eq(rateCards.id, c.rateCardId), eq(rateCards.version, c.rateCardVersion)));
    if (!card) throw fail('MODEL_UNAVAILABLE');
    const known =
      result.usage !== null &&
      [result.usage.inputTokens, result.usage.outputTokens].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      );
    const paid = result.mayHaveBilled;
    const usage = known ? result.usage! : { inputTokens: 0, outputTokens: 0 };
    const status = known || !paid ? ('final' as const) : ('estimated' as const);
    const cost = known ? costMicros(usage, card) : paid ? c.reservedMicros : 0;
    const next =
      c.state === 'prepared'
        ? 'refused'
        : !paid
          ? 'refused'
          : known || result.reasonCode === null
            ? 'response_received'
            : 'unknown';
    await tx
      .update(modelCallAttempts)
      .set({
        state: next,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicros: cost,
        status,
        reasonCode: result.reasonCode,
      })
      .where(eq(modelCallAttempts.id, c.id));
    const holds = await tx
      .select({ hold: budgetReservations, period: budgets.period })
      .from(budgetReservations)
      .innerJoin(
        budgets,
        and(
          eq(budgets.organizationId, budgetReservations.organizationId),
          eq(budgets.id, budgetReservations.budgetId),
        ),
      )
      .where(eq(budgetReservations.modelCallId, c.id))
      .orderBy(asc(budgetReservations.budgetId));
    if (!holds.length) throw fail('MODEL_UNAVAILABLE');
    const [profile] = await tx
      .select({ providerKind: modelProfiles.providerKind })
      .from(modelProfiles)
      .where(eq(modelProfiles.id, c.profileId));
    if (!profile) throw fail('MODEL_UNAVAILABLE');
    const base = {
      organizationId: principal.context.organizationId,
      ...shape(principal),
      modelCallId: c.id,
      workUnitId: facts.kind === 'agent_run' ? facts.run.workUnitId : null,
      rateCardId: c.rateCardId,
      rateCardVersion: c.rateCardVersion,
      reservationId: holds[0]!.hold.id,
      billingPeriod: c.billingPeriod,
      commercialMode: c.commercialMode,
      profileId: c.profileId,
      profileVersion: c.profileVersion,
      providerKind: profile.providerKind,
      requestHash: c.requestHash,
      status,
      billable: isBillable(
        c.commercialMode as Parameters<typeof isBillable>[0],
        c.billingOwner as BillingOwner,
      ),
      unit: 'token',
    };
    const inputCost =
      status === 'estimated'
        ? cost
        : costMicros({ inputTokens: usage.inputTokens, outputTokens: 0 }, card);
    const outputCost = cost - inputCost;
    await tx
      .insert(usageLedger)
      .values([
        {
          ...base,
          idempotencyKey: `knowledge_model:${c.id}:input`,
          meter: 'model_input_tokens',
          quantity: usage.inputTokens,
          costMicros: inputCost,
        },
        {
          ...base,
          idempotencyKey: `knowledge_model:${c.id}:output`,
          meter: 'model_output_tokens',
          quantity: usage.outputTokens,
          costMicros: outputCost,
        },
      ])
      .onConflictDoNothing();
    for (const { hold } of holds) {
      if (hold.status === 'settled') continue;
      await tx
        .update(budgets)
        .set({
          reservedMicros: sql`${budgets.reservedMicros}-${hold.status === 'held' ? hold.amountMicros : 0}::bigint`,
          spentMicros: sql`${budgets.spentMicros}+${cost}::bigint`,
        })
        .where(eq(budgets.id, hold.budgetId));
      await tx
        .update(budgetReservations)
        .set({ status: 'settled', settledAt: now() })
        .where(eq(budgetReservations.id, hold.id));
    }
    const used =
      status === 'estimated'
        ? c.maxInputTokens + c.maxOutputTokens
        : usage.inputTokens + usage.outputTokens;
    if (facts.kind === 'job')
      await tx
        .update(modelJobs)
        .set({
          reservedMicros: sql`${modelJobs.reservedMicros}-${c.reservedMicros}::bigint`,
          spentMicros: sql`${modelJobs.spentMicros}+${cost}::bigint`,
          reservedTokens: sql`${modelJobs.reservedTokens}-${c.maxInputTokens + c.maxOutputTokens}::bigint`,
          usedTokens: sql`${modelJobs.usedTokens}+${used}::bigint`,
        })
        .where(eq(modelJobs.id, facts.job.id));
    else
      await tx
        .update(agentRuns)
        .set({
          costMicros: sql`${agentRuns.costMicros}+${cost}::bigint`,
          inputTokens: sql`${agentRuns.inputTokens}+${status === 'estimated' ? c.maxInputTokens : usage.inputTokens}::bigint`,
          outputTokens: sql`${agentRuns.outputTokens}+${status === 'estimated' ? c.maxOutputTokens : usage.outputTokens}::bigint`,
        })
        .where(eq(agentRuns.id, facts.run.id));
    if (c.commercialMode === 'cloud' && c.billingOwner === 'ensemus') {
      if (!options.cloudSpend) throw fail('BUDGET_EXHAUSTED');
      await options.cloudSpend.settleInTx(tx, principal.context, {
        callId: c.id,
        costMicros: cost,
        status,
      });
    }
    return { ...usage, costMicros: cost, callId: c.id };
  };
  return {
    reconcileRun: async (context, runId) => {
      if (context.actorType !== 'service') throw fail();
      await withTenantTx(database, context, async (tx) => {
        const [checkpoint] = await tx
          .select({ fencedAt: runInputCheckpoints.fencedAt })
          .from(runInputCheckpoints)
          .where(eq(runInputCheckpoints.runId, id(runId)))
          .for('share', { noWait: true });
        const [run] = await tx
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .for('update', { noWait: true });
        if (!checkpoint?.fencedAt || !run || !isTerminalAgentRun(run.status as AgentRunStatus))
          throw fail();
        await tx.execute(
          sql`select set_config('app.knowledge_model_protocol','accounting-v1',true),set_config('app.model_job_id','',true),set_config('app.agent_run_id',${run.id},true)`,
        );
        const pending = await tx
          .select({
            id: modelCallAttempts.id,
            state: modelCallAttempts.state,
            stepId: executionSteps.id,
            stepNumber: executionSteps.stepNumber,
            attempt: executionSteps.attempt,
          })
          .from(modelCallAttempts)
          .innerJoin(executionSteps, eq(executionSteps.id, modelCallAttempts.stepId))
          .where(
            and(
              eq(modelCallAttempts.runId, run.id),
              inArray(modelCallAttempts.state, ['prepared', 'dispatched']),
            ),
          )
          .orderBy(asc(modelCallAttempts.id));
        for (const call of pending)
          await settleInTx(
            tx,
            {
              kind: 'agent_run',
              context,
              step: {
                runId: run.id,
                stepId: call.stepId,
                stepNumber: call.stepNumber,
                attempt: call.attempt,
                workUnitId: run.workUnitId,
                agentVersionId: run.agentVersionId,
              },
            },
            call.id,
            {
              usage: null,
              mayHaveBilled: call.state === 'dispatched',
              reasonCode: 'RESPONSE_UNCONFIRMED',
            },
          );
      });
    },
    reconcileJob: async (context, jobId) => {
      if (context.actorType !== 'service') throw fail();
      await withTenantTx(database, context, async (tx) => {
        const [job] = await tx
          .select()
          .from(modelJobs)
          .where(eq(modelJobs.id, id(jobId)))
          .for('update');
        if (!job) throw fail();
        if (!job.fencedAt)
          await tx
            .update(modelJobs)
            .set({ state: 'fenced', refusalCode: 'MODEL_UNAVAILABLE' })
            .where(eq(modelJobs.id, job.id));
        await tx.execute(
          sql`select set_config('app.knowledge_model_protocol','accounting-v1',true),set_config('app.model_job_id',${job.id},true)`,
        );
        const pending = await tx
          .select({ id: modelCallAttempts.id, state: modelCallAttempts.state })
          .from(modelCallAttempts)
          .where(
            and(
              eq(modelCallAttempts.jobId, job.id),
              inArray(modelCallAttempts.state, ['prepared', 'dispatched']),
            ),
          )
          .orderBy(asc(modelCallAttempts.id));
        for (const call of pending)
          await settleInTx(tx, { kind: 'job', context, jobId: job.id }, call.id, {
            usage: null,
            mayHaveBilled: call.state === 'dispatched',
            reasonCode: 'RESPONSE_UNCONFIRMED',
          });
      });
    },
    candidates: (principal, purpose) =>
      withModelPrincipalTx(database, principal, (tx) => candidatesInTx(tx, principal, purpose)),
    prepare: (principal, input) =>
      withModelPrincipalTx(database, principal, async (tx) => {
        await requireNamedMember(tx, principal);
        await lockKnowledgeModelInputs(tx, input.metadata.inputs);
        await assertKnowledgeAgentScopeInTx(
          tx,
          principal,
          input.classification,
          input.metadata.inputs,
        );
        if (principal.kind === 'agent_run') await lockRunInputsForContent(tx, principal.context);
        const facts = await principalFacts(tx, principal, true);
        const [prior] = await tx
          .select()
          .from(modelCallAttempts)
          .where(
            and(
              principal.kind === 'job'
                ? eq(modelCallAttempts.jobId, principal.jobId)
                : and(
                    eq(modelCallAttempts.runId, principal.step.runId),
                    eq(modelCallAttempts.stepId, principal.step.stepId),
                  ),
              eq(modelCallAttempts.operationKey, input.metadata.operationKey),
            ),
          );
        if (prior) {
          if (
            prior.requestHash !== input.requestHash ||
            prior.inputInventoryHash !== modelInputInventoryHash(input.metadata.inputs) ||
            prior.purpose !== input.purpose ||
            prior.profileId !== input.candidate.profile.id ||
            prior.profileVersion !== input.candidate.profile.version ||
            prior.qualificationId !== input.candidate.qualification.id ||
            prior.classification !== input.classification ||
            prior.policyVersion !== input.policyVersion ||
            prior.rateCardId !== input.candidate.rateCard.id ||
            prior.rateCardVersion !== input.candidate.rateCard.version
          )
            throw fail();
          return { callId: prior.id, state: prior.state };
        }
        const current = (await candidatesInTx(tx, principal, input.purpose)).find(
          (value) =>
            value.qualification.id === input.candidate.qualification.id &&
            value.profile.version === input.candidate.profile.version &&
            value.approvalId === input.candidate.approvalId,
        );
        if (
          !current ||
          rank(input.classification) < 0 ||
          input.ceiling.inputTokens > current.bounds.maxInputTokens ||
          input.ceiling.outputTokens > current.bounds.maxOutputTokens
        )
          throw fail();
        if (
          current.qualifying &&
          input.qualificationProofHash !==
            operationHash(qualificationOperation(input.purpose, current.qualification.dimension))
        )
          throw fail();
        const amount = costMicros(input.ceiling, current.rateCard),
          tokens = input.ceiling.inputTokens + input.ceiling.outputTokens;
        if (facts.kind === 'job') {
          const j = facts.job;
          if (
            j.calls >= j.maxCalls ||
            !fits(j.maxCostMicros, j.spentMicros, j.reservedMicros, amount) ||
            !fits(j.maxTotalTokens, j.usedTokens, j.reservedTokens, tokens)
          )
            throw fail('BUDGET_EXHAUSTED');
          if (
            j.kind === 'document_embed' &&
            !input.metadata.inputs.some((value) => value.kind === 'chunk')
          )
            throw fail();
        } else {
          const r = facts.run;
          const legacyHeld = await tx
            .select({ id: budgetReservations.id })
            .from(budgetReservations)
            .where(
              and(
                eq(budgetReservations.runId, r.id),
                eq(budgetReservations.status, 'held'),
                isNull(budgetReservations.modelCallId),
              ),
            )
            .limit(1);
          if (legacyHeld.length) throw fail('MODEL_UNAVAILABLE');
          const unconfirmed = await tx
            .select({ id: modelCallAttempts.id })
            .from(modelCallAttempts)
            .where(
              and(
                eq(modelCallAttempts.runId, r.id),
                inArray(modelCallAttempts.state, ['dispatched', 'unknown']),
              ),
            )
            .limit(1);
          if (unconfirmed.length) throw fail('MODEL_UNAVAILABLE');
          const totals = await tx.execute<{
            cost: string;
            tokens: string;
            calls: number;
          }>(sql`select coalesce(sum(case when state in('prepared','dispatched') then reserved_micros else coalesce(cost_micros,0) end),0)::text cost,
          coalesce(sum(case when state in('prepared','dispatched') then max_input_tokens::bigint+max_output_tokens::bigint else coalesce(input_tokens,0)::bigint+coalesce(output_tokens,0)::bigint end),0)::text tokens,count(*)::int calls
          from ai.model_call_attempts where organization_id=${r.organizationId}::uuid and run_id=${r.id}::uuid and approval_id=${current.approvalId}::uuid`);
          const pending = await tx.execute<{ tokens: string; cost: string }>(sql`select
          (select coalesce(sum(max_input_tokens::bigint+max_output_tokens::bigint),0)::text from ai.model_call_attempts where organization_id=${r.organizationId}::uuid and run_id=${r.id}::uuid and state in('prepared','dispatched')) tokens,
          (select coalesce(sum(v.amount),0)::text from(select max(amount_micros) amount from platform.budget_reservations where organization_id=${r.organizationId}::uuid and run_id=${r.id}::uuid and status='held' group by model_call_id,step_id,attempt)v) cost`);
          const t = totals.rows[0],
            p = pending.rows[0];
          if (
            r.modelTurns >= r.maxModelTurns ||
            !fits(r.maxCostMicros, r.costMicros, p?.cost ?? '0', amount) ||
            !fits(r.maxTotalTokens, r.inputTokens, r.outputTokens, p?.tokens ?? '0', tokens) ||
            !fits(current.bounds.maxCostMicros, t?.cost ?? '0', amount) ||
            !fits(current.bounds.maxTotalTokens, t?.tokens ?? '0', tokens) ||
            (t?.calls ?? 0) >= current.bounds.maxCalls
          )
            throw fail('BUDGET_EXHAUSTED');
        }
        const [org] = await tx.select({ mode: organizations.commercialMode }).from(organizations);
        if (!org) throw fail();
        const card = current.rateCard,
          callId = randomUUID();
        await halt.assertRunning(tx, principal.context, {
          providerKind: current.profile.providerKind,
          ...(facts.kind === 'agent_run' ? { agentVersionId: facts.run.agentVersionId } : {}),
        });
        await tx.insert(modelCallAttempts).values({
          organizationId: principal.context.organizationId,
          id: callId,
          jobId: principal.kind === 'job' ? principal.jobId : null,
          runId: principal.kind === 'agent_run' ? principal.step.runId : null,
          stepId: principal.kind === 'agent_run' ? principal.step.stepId : null,
          operationKey: input.metadata.operationKey,
          requestHash: input.requestHash,
          inputInventoryHash: modelInputInventoryHash(input.metadata.inputs),
          purpose: input.purpose,
          profileId: current.profile.id,
          profileVersion: current.profile.version,
          qualificationId: current.qualification.id,
          approvalId: current.approvalId,
          classification: input.classification,
          policyVersion: input.policyVersion,
          rateCardId: card.id,
          rateCardVersion: card.version,
          commercialMode: org.mode,
          billingOwner: current.profile.billingOwner,
          billingPeriod: billingPeriodOf(now()),
          maxInputTokens: input.ceiling.inputTokens,
          maxOutputTokens: input.ceiling.outputTokens,
          reservedMicros: amount,
        });
        if (input.metadata.inputs.length)
          await tx
            .insert(modelCallInputs)
            .values(
              input.metadata.inputs.map((value) => ({
                organizationId: principal.context.organizationId,
                callId,
                kind: value.kind,
                inputId: id(value.id),
                sourceId: value.kind === 'chunk' ? id(value.sourceId ?? '') : null,
                sha256: value.sha256,
                classification: value.classification,
              })),
            )
            .onConflictDoNothing();
        if (facts.kind === 'job' && facts.job.kind === 'answer') {
          const sourceIds = [
            ...new Set(
              input.metadata.inputs.flatMap((value) => (value.sourceId ? [value.sourceId] : [])),
            ),
          ].sort();
          if (sourceIds.length)
            await tx
              .insert(knowledgeAnswerSources)
              .values(
                sourceIds.map((sourceId) => ({
                  organizationId: principal.context.organizationId,
                  answerId: facts.job.answerId!,
                  sourceId,
                })),
              )
              .onConflictDoNothing();
        }
        if (principal.kind === 'agent_run') {
          // Retain every source read by optional ranking, including candidates later dropped from the
          // final context. Existing generated-artifact lineage independently reads ALL run packages.
          const refs = input.metadata.inputs.filter((value) => value.kind === 'chunk');
          const ids = [...new Set(refs.map((value) => value.id))].sort();
          const chunks = ids.length
            ? await tx
                .select({
                  id: knowledgeChunks.id,
                  documentId: knowledgeChunks.documentId,
                  sourceId: knowledgeChunks.sourceId,
                  sha256: knowledgeChunks.contentSha256,
                  tokens: knowledgeChunks.tokenEstimate,
                })
                .from(knowledgeChunks)
                .where(inArray(knowledgeChunks.id, ids))
                .orderBy(asc(knowledgeChunks.id))
            : [];
          if (
            chunks.length !== ids.length ||
            chunks.some(
              (chunk) =>
                !refs.some(
                  (ref) =>
                    ref.id === chunk.id &&
                    ref.sourceId === chunk.sourceId &&
                    ref.sha256 === chunk.sha256,
                ),
            )
          )
            throw fail();
          const usedTokens = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
          if (usedTokens > input.ceiling.inputTokens) throw fail();
          await tx.insert(knowledgeEvidencePackages).values({
            organizationId: principal.context.organizationId,
            id: callId,
            purpose: 'agent_turn',
            runId: principal.step.runId,
            workUnitId: principal.step.workUnitId,
            viewerMembershipId: principal.context.membershipId,
            querySha256: input.requestHash,
            policyVersion: `model-input-v1:${input.purpose}:${input.policyVersion}`,
            budgetTokens: Math.max(1, input.ceiling.inputTokens),
            usedTokens,
            strongestClassification: input.classification,
            packageSha256: operationKey({ callId, inputs: input.metadata.inputs }),
          });
          if (chunks.length)
            await tx.insert(knowledgeEvidenceItems).values(
              chunks.map((chunk, index) => ({
                organizationId: principal.context.organizationId,
                packageId: callId,
                ordinal: index + 1,
                chunkId: chunk.id,
                documentId: chunk.documentId,
                sourceId: chunk.sourceId,
                contentSha256: chunk.sha256,
                classification: refs.find((ref) => ref.id === chunk.id)!.classification,
                tokenEstimate: chunk.tokens,
              })),
            );
        }
        const applicable = await tx
          .select()
          .from(budgets)
          .where(
            and(
              eq(budgets.period, billingPeriodOf(now())),
              facts.kind === 'job'
                ? eq(budgets.scope, 'organization')
                : sql`(${budgets.scope}='organization' or ${budgets.agentVersionId}=${facts.run.agentVersionId}::uuid)`,
            ),
          )
          .orderBy(asc(budgets.id))
          .for('update');
        if (!applicable.some((value) => value.scope === 'organization'))
          throw fail('BUDGET_EXHAUSTED');
        for (const budget of applicable) {
          if (!fits(budget.limitMicros, budget.reservedMicros, budget.spentMicros, amount))
            throw fail('BUDGET_EXHAUSTED');
          await tx.insert(budgetReservations).values({
            organizationId: principal.context.organizationId,
            budgetId: budget.id,
            ...shape(principal),
            modelCallId: callId,
            amountMicros: amount,
          });
          await tx
            .update(budgets)
            .set({ reservedMicros: sql`${budgets.reservedMicros}+${amount}::bigint` })
            .where(eq(budgets.id, budget.id));
        }
        if (facts.kind === 'job')
          await tx
            .update(modelJobs)
            .set({
              calls: sql`${modelJobs.calls}+1`,
              reservedMicros: sql`${modelJobs.reservedMicros}+${amount}::bigint`,
              reservedTokens: sql`${modelJobs.reservedTokens}+${tokens}::bigint`,
              state: 'running',
            })
            .where(eq(modelJobs.id, facts.job.id));
        else
          await tx
            .update(agentRuns)
            .set({
              modelTurns: sql`${agentRuns.modelTurns}+1`,
              effectiveClassification:
                rank(input.classification) > rank(facts.run.effectiveClassification)
                  ? input.classification
                  : facts.run.effectiveClassification,
            })
            .where(eq(agentRuns.id, facts.run.id));
        if (org.mode === 'cloud' && current.profile.billingOwner === 'ensemus') {
          if (!options.cloudSpend) throw fail('BUDGET_EXHAUSTED');
          await options.cloudSpend.reserveInTx(tx, principal.context, {
            callId,
            ceilingMicros: amount,
            profileId: current.profile.id,
            ...{
              modelJobId: principal.kind === 'job' ? principal.jobId : null,
              runId: principal.kind === 'agent_run' ? principal.step.runId : null,
            },
          });
        }
        await tx.insert(egressDecisions).values({
          organizationId: principal.context.organizationId,
          runId: principal.kind === 'agent_run' ? principal.step.runId : null,
          stepId: principal.kind === 'agent_run' ? principal.step.stepId : null,
          profileId: current.profile.id,
          dataClass: input.classification,
          purpose: input.purpose,
          destinationHost: new URL(current.profile.endpointUrl).hostname,
          decision: 'allow',
          reasonCode: 'ALLOWED',
          policyVersion: input.policyVersion,
          requestHash: input.requestHash,
        });
        await tx.insert(knowledgeModelCalls).values({
          organizationId: principal.context.organizationId,
          purpose: input.purpose,
          dataClass: input.classification,
          decision: 'allow',
          reasonCode: 'ALLOWED',
          policyVersion: input.policyVersion,
          requestSha256: input.requestHash,
          modelProfileRef: current.profile.id,
          modelProfileVersion: current.profile.version,
          providerKind: current.profile.providerKind,
          destinationHost: new URL(current.profile.endpointUrl).hostname,
          inputCount: input.metadata.inputs.length,
        });
        return { callId, state: 'prepared' };
      }),
    dispatch: (principal, callId) =>
      withModelPrincipalTx(database, principal, async (tx) => {
        await requireNamedMember(tx, principal);
        const c = await ownAttempt(tx, principal, callId);
        const inputs = await tx
          .select()
          .from(modelCallInputs)
          .where(eq(modelCallInputs.callId, c.id))
          .limit(1001);
        await lockKnowledgeModelInputs(
          tx,
          inputs.map((input) => ({
            kind: input.kind,
            id: input.inputId,
            ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          })),
        );
        await assertKnowledgeAgentScopeInTx(tx, principal, c.classification, inputs);
        if (principal.kind === 'agent_run') await lockRunInputsForContent(tx, principal.context);
        await halt.assertRunning(tx, principal.context, {
          providerKind: (
            await tx
              .select({ kind: modelProfiles.providerKind })
              .from(modelProfiles)
              .where(eq(modelProfiles.id, c.profileId))
          )[0]?.kind as ProviderKind,
        });
        const rows = await tx
          .update(modelCallAttempts)
          .set({ state: 'dispatched' })
          .where(and(eq(modelCallAttempts.id, c.id), eq(modelCallAttempts.state, 'prepared')))
          .returning({ id: modelCallAttempts.id });
        return rows.length === 1;
      }),
    settle: (principal, callId, result) =>
      withModelPrincipalTx(database, principal, (tx) => settleInTx(tx, principal, callId, result)),
    recoverUnknown: (principal, callId) =>
      withModelPrincipalTx(database, principal, async (tx) => {
        await settleInTx(tx, principal, callId, {
          usage: null,
          mayHaveBilled: true,
          reasonCode: 'RESPONSE_UNCONFIRMED',
        });
      }),
    assertResultFresh: (principal, callId) =>
      withModelPrincipalTx(database, principal, async (tx) => {
        const c = await ownAttempt(tx, principal, callId);
        if (c.state !== 'response_received') throw fail('MODEL_UNAVAILABLE');
        const inputs = await tx
          .select({ kind: modelCallInputs.kind, sourceId: modelCallInputs.sourceId })
          .from(modelCallInputs)
          .where(eq(modelCallInputs.callId, c.id))
          .limit(1001);
        if (inputs.length > 1000) throw fail();
        await assertKnowledgeAgentScopeInTx(tx, principal, c.classification, inputs);
        await tx.execute(
          sql`select ai.assert_model_call(c) from ai.model_call_attempts c where c.organization_id=${principal.context.organizationId}::uuid and c.id=${c.id}::uuid`,
        );
        const fresh = await tx.execute<{ readable: boolean }>(
          sql`select ai.model_call_inputs_readable(${c.id}::uuid,${principal.context.membershipId}::uuid) readable`,
        );
        if (!fresh.rows[0]?.readable) throw fail();
        const facts = await principalFacts(tx, principal);
        if (
          facts.kind === 'job' &&
          (facts.job.spentMicros > facts.job.maxCostMicros ||
            facts.job.usedTokens > facts.job.maxTotalTokens)
        )
          throw fail('BUDGET_EXHAUSTED');
        if (
          facts.kind === 'agent_run' &&
          (!fits(facts.run.maxCostMicros, facts.run.costMicros) ||
            !fits(facts.run.maxTotalTokens, facts.run.inputTokens, facts.run.outputTokens))
        )
          throw fail('BUDGET_EXHAUSTED');
      }),
  };
}
