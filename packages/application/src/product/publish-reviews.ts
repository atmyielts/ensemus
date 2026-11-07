// Owned by the studio slice (AGENT-08). See docs/06-delivery/m7-slices.md and ADR-031 D6.
import { createHash } from 'node:crypto';
import {
  agentVersions,
  memberships,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  agentDrafts,
  processDrafts,
  publishReviews,
  simulationInputs,
  simulationRuns,
} from '@ensemus/database/product';
import { decidePublishReviewSchema, requestPublishReviewSchema } from '@ensemus/contracts/studio';
import { agentSpecV1Schema } from '@ensemus/contracts/ai';
import {
  assessDraft,
  compileBoundSpec,
  STUDIO_SUITE_REF,
  type AgentDraftAnswers,
  type RiskFinding,
} from '@ensemus/domain/agent-draft';
import { TOOL_MANIFESTS } from '@ensemus/domain/ai-tools';
import { canonicalJson } from '@ensemus/domain/approval';
import { canProduct, canReadRecord } from '@ensemus/domain/product-policy';
import type { ProcessGraph, ProcessSpec } from '@ensemus/domain/process-spec';
import {
  AGENT_DRAFT_PUBLISHED,
  AGENT_DRAFT_SUBMITTED,
  AGGREGATE_PUBLISH_REVIEW,
  NOTIFY_PUBLISH_REVIEW_DECIDED,
  NOTIFY_PUBLISH_REVIEW_REQUESTED,
  PROCESS_SPEC_PUBLISHED,
  PUBLISH_REVIEW_DECIDED,
  publishReviewTargetRef,
} from '@ensemus/domain/product-events';
import { requiredAgentScenarioKey, type SimulationReport } from '@ensemus/domain/simulation';
import { and, desc, eq } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { emit } from '../events';
import { canonicalId } from '../ids';
import { auditAction, notify } from '../work';
import type { ProductPorts } from './ports';
import { assertRecentMfa, type SessionProof } from './privileged';
import { publishProcessSpecInTx } from './process-specs';
import { compileCurrentProcess } from './simulations';
import { studioPerson, withStudioTx as withTenantTx } from './studio-authority';

type Row = typeof publishReviews.$inferSelect;
type Kind = 'agent_draft' | 'process_draft';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const view = (row: Row): PublishReviewView => ({
  id: row.id,
  subjectId: row.subjectId,
  subjectSha256: row.subjectSha256,
  simulationRunId: row.simulationRunId,
  requestedByMembershipId: row.requestedByMembershipId,
  reviewerMembershipId: row.reviewerMembershipId,
  decisionReason: row.decisionReason,
  publishedRef: row.publishedRef,
  version: row.version,
  createdAt: row.createdAt,
  subjectKind: row.subjectKind as Kind,
  status: row.status as PublishReviewView['status'],
  riskLevel: row.riskLevel as PublishReviewView['riskLevel'],
  riskSummary: row.riskSummary as RiskFinding[],
});

async function subject(tx: Tx, context: TenantContext, kind: Kind, id: string) {
  const canonical = canonicalId(id);
  if (kind === 'agent_draft') {
    const [row] = await tx
      .select()
      .from(agentDrafts)
      .where(eq(agentDrafts.id, canonical))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (
      row.status === 'archived' ||
      !row.compiledSpecCanonical ||
      !row.specSha256 ||
      !row.compilePolicyVersion ||
      sha256(row.compiledSpecCanonical) !== row.specSha256
    )
      throw new AppError('DRAFT_INVALID');
    const parsedSpec = agentSpecV1Schema.safeParse(JSON.parse(row.compiledSpecCanonical));
    if (
      !parsedSpec.success ||
      compileBoundSpec(
        row.answers as AgentDraftAnswers,
        { name: parsedSpec.data.id, version: parsedSpec.data.version },
        sha256,
      ).specSha256 !== row.specSha256
    )
      throw new AppError('DRAFT_INVALID');
    const risk = assessDraft(
      row.answers as AgentDraftAnswers,
      TOOL_MANIFESTS,
      { maxTurns: 100, maxToolCalls: 500, timeoutSeconds: 86400 },
      sha256,
    );
    return {
      kind,
      row,
      spec: parsedSpec.data as Record<string, unknown>,
      hash: row.specSha256,
      policyVersion: row.compilePolicyVersion,
      risk: risk.risk,
      riskLevel: risk.riskLevel,
    };
  }
  const [row] = await tx
    .select()
    .from(processDrafts)
    .where(eq(processDrafts.id, canonical))
    .for('update');
  if (!row || !canReadRecord(row, context)) throw new AppError('NOT_FOUND');
  if (row.status === 'archived' || !row.specSha256) throw new AppError('GRAPH_INVALID');
  const compiled = await compileCurrentProcess(
    tx,
    row.graph as ProcessGraph,
    row.classification as ProcessSpec['classification'],
  );
  if (compiled.hash !== row.specSha256) throw new AppError('SIMULATION_STALE');
  const risk: RiskFinding[] = compiled.spec.steps.flatMap<RiskFinding>((step) =>
    step.kind === 'external_action'
      ? [{ code: 'WRITES_OUTSIDE' as const, subject: step.toolId ?? step.key }]
      : step.kind === 'agent_task'
        ? [{ code: 'DELEGATES' as const, subject: step.key }]
        : [],
  );
  if (['confidential', 'restricted'].includes(row.classification))
    risk.push({ code: 'READS_CONFIDENTIAL', subject: row.classification });
  return {
    kind,
    row,
    spec: compiled.spec as unknown as Record<string, unknown>,
    hash: compiled.hash,
    policyVersion: 'process-v1',
    risk,
    riskLevel: risk.length ? ('elevated' as const) : ('standard' as const),
  };
}

async function lockedReview(tx: Tx, context: TenantContext, id: string) {
  const canonical = canonicalId(id);
  // Metadata first, then the draft lock, then review: saves/cancellation take that same lock order.
  const [header] = await tx
    .select({ subjectKind: publishReviews.subjectKind, subjectId: publishReviews.subjectId })
    .from(publishReviews)
    .where(eq(publishReviews.id, canonical));
  if (!header) throw new AppError('NOT_FOUND');
  const current = await subject(tx, context, header.subjectKind as Kind, header.subjectId);
  const [review] = await tx
    .select()
    .from(publishReviews)
    .where(eq(publishReviews.id, canonical))
    .for('update');
  if (!review) throw new AppError('NOT_FOUND');
  return { review, current };
}

async function passedSimulation(tx: Tx, id: string, current: Awaited<ReturnType<typeof subject>>) {
  const [run] = await tx
    .select()
    .from(simulationRuns)
    .where(eq(simulationRuns.id, canonicalId(id)))
    .for('share');
  if (!run) throw new AppError('NOT_FOUND');
  if (
    run.subjectId !== current.row.id ||
    run.subjectKind !== current.kind ||
    run.subjectSha256 !== current.hash
  )
    throw new AppError('SIMULATION_STALE');
  const [snapshot] = await tx
    .select()
    .from(simulationInputs)
    .where(eq(simulationInputs.simulationRunId, run.id));
  const report = run.report as SimulationReport | null;
  if (
    run.status !== 'passed' ||
    !snapshot ||
    snapshot.specCanonical !== canonicalJson(current.spec) ||
    snapshot.policyVersion !== current.policyVersion ||
    !report ||
    report.outcome !== 'passed' ||
    report.subjectSha256 !== current.hash ||
    !run.reportSha256 ||
    sha256(canonicalJson(report)) !== run.reportSha256 ||
    run.scenarioKey !==
      (current.kind === 'agent_draft' ? requiredAgentScenarioKey(current.spec) : 'standard.process')
  )
    throw new AppError('SIMULATION_REQUIRED');
  return { run, snapshot, report };
}

async function currentReviewer(tx: Tx, id: string) {
  const [person] = await tx
    .select({ id: memberships.id, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.id, canonicalId(id)), eq(memberships.status, 'active')))
    .for('share');
  if (!person || !canProduct(person.role, 'studio.review')) throw new AppError('NOT_FOUND');
  return person.id;
}

export type PublishReviewView = {
  id: string;
  subjectKind: 'agent_draft' | 'process_draft';
  subjectId: string;
  subjectSha256: string;
  simulationRunId: string;
  riskLevel: 'standard' | 'elevated';
  riskSummary: readonly RiskFinding[];
  requestedByMembershipId: string;
  reviewerMembershipId: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'published';
  decisionReason: string | null;
  publishedRef: string | null;
  version: number;
  createdAt: Date;
};

/**
 * Needs `studio.author`. Refuses without a passed simulation of the current hash (SIMULATION_REQUIRED or
 * SIMULATION_STALE). Standard risk may name no reviewer, and the author can then decide it themselves.
 */
export async function requestPublishReview(
  database: AppDatabase,
  context: TenantContext,
  input: {
    subjectKind: 'agent_draft' | 'process_draft';
    subjectId: string;
    simulationRunId: string;
    reviewerMembershipId?: string;
  },
): Promise<PublishReviewView> {
  const parsed = requestPublishReviewSchema.safeParse({
    subject_kind: input.subjectKind,
    subject_id: input.subjectId,
    simulation_run_id: input.simulationRunId,
    ...(input.reviewerMembershipId ? { reviewer_membership_id: input.reviewerMembershipId } : {}),
  });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  try {
    return await withTenantTx(database, context, async (tx) => {
      const actor = await studioPerson(tx, context),
        current = await subject(tx, actor, input.subjectKind, input.subjectId);
      await passedSimulation(tx, input.simulationRunId, current);
      const reviewer = input.reviewerMembershipId
        ? await currentReviewer(tx, input.reviewerMembershipId)
        : null;
      if (current.riskLevel === 'elevated' && reviewer === actor.membershipId)
        throw new AppError('REVIEW_SELF_DECISION');
      const [row] = await tx
        .insert(publishReviews)
        .values({
          organizationId: actor.organizationId,
          subjectKind: current.kind,
          subjectId: current.row.id,
          subjectSha256: current.hash,
          simulationRunId: canonicalId(input.simulationRunId),
          riskLevel: current.riskLevel,
          riskSummary: current.risk,
          requestedByMembershipId: actor.membershipId,
          reviewerMembershipId: reviewer,
        })
        .returning();
      if (!row) throw new AppError('INVALID_STATE');
      const table = current.kind === 'agent_draft' ? agentDrafts : processDrafts;
      await tx
        .update(table)
        .set({ status: 'in_review', version: current.row.version + 1, updatedAt: new Date() })
        .where(eq(table.id, current.row.id));
      await auditAction(tx, actor, 'publish_review.requested', `publish_review:${row.id}`);
      await notify(
        tx,
        actor,
        [reviewer],
        NOTIFY_PUBLISH_REVIEW_REQUESTED,
        publishReviewTargetRef(row.id),
      );
      await emit(tx, actor, {
        eventType: AGENT_DRAFT_SUBMITTED,
        aggregateType: AGGREGATE_PUBLISH_REVIEW,
        aggregateId: row.id,
        aggregateVersion: 1,
        classification: 'internal',
        payload: { subject_kind: current.kind, subject_id: current.row.id },
      });
      return view(row);
    });
  } catch (error) {
    if (pgCode(error) === '23505') throw new AppError('REVIEW_ALREADY_OPEN');
    throw error;
  }
}

export async function listPublishReviews(
  database: AppDatabase,
  context: TenantContext,
  input: { status?: PublishReviewView['status'] } = {},
): Promise<readonly PublishReviewView[]> {
  if (
    input.status &&
    !['pending', 'approved', 'rejected', 'cancelled', 'published'].includes(input.status)
  )
    throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    await studioPerson(tx, context);
    return (
      await tx
        .select()
        .from(publishReviews)
        .where(input.status ? eq(publishReviews.status, input.status) : undefined)
        .orderBy(desc(publishReviews.createdAt), desc(publishReviews.id))
        .limit(200)
    ).map(view);
  });
}

export async function getPublishReview(
  database: AppDatabase,
  context: TenantContext,
  reviewId: string,
): Promise<PublishReviewView> {
  return withTenantTx(database, context, async (tx) => {
    await studioPerson(tx, context);
    const [row] = await tx
      .select()
      .from(publishReviews)
      .where(eq(publishReviews.id, canonicalId(reviewId)));
    if (!row) throw new AppError('NOT_FOUND');
    return view(row);
  });
}

/** Needs `studio.review` and recent MFA. A reason is required to reject. REVIEW_SELF_DECISION on elevated. */
export async function decidePublishReview(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof | null,
  input: {
    reviewId: string;
    expectedVersion: number;
    decision: 'approved' | 'rejected';
    reason?: string;
  },
): Promise<PublishReviewView> {
  const parsed = decidePublishReviewSchema.safeParse({
    decision: input.decision,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  if (!parsed.success || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    const actor = await studioPerson(tx, context, 'studio.review');
    await assertRecentMfa(tx, actor, 'studio.review_decision', proof);
    const { review, current } = await lockedReview(tx, actor, input.reviewId);
    if (review.riskLevel === 'elevated' && review.requestedByMembershipId === actor.membershipId)
      throw new AppError('REVIEW_SELF_DECISION');
    if (review.reviewerMembershipId && review.reviewerMembershipId !== actor.membershipId)
      throw new AppError('FORBIDDEN');
    if (review.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (review.status !== 'pending') throw new AppError('INVALID_STATE');
    if (current.hash !== review.subjectSha256) throw new AppError('SIMULATION_STALE');
    await passedSimulation(tx, review.simulationRunId, current);
    const [saved] = await tx
      .update(publishReviews)
      .set({
        status: input.decision,
        decidedByMembershipId: actor.membershipId,
        decidedAt: new Date(),
        decisionReason: parsed.data.reason ?? null,
        version: review.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(publishReviews.id, review.id))
      .returning();
    if (!saved) throw new AppError('NOT_FOUND');
    if (input.decision === 'rejected') {
      const table = current.kind === 'agent_draft' ? agentDrafts : processDrafts;
      await tx
        .update(table)
        .set({ status: 'editing', version: current.row.version + 1, updatedAt: new Date() })
        .where(eq(table.id, current.row.id));
    }
    await notify(
      tx,
      actor,
      [review.requestedByMembershipId],
      NOTIFY_PUBLISH_REVIEW_DECIDED,
      publishReviewTargetRef(review.id),
    );
    await auditAction(
      tx,
      actor,
      'publish_review.decided',
      `publish_review:${review.id}`,
      input.decision === 'approved' ? 'APPROVED' : 'REJECTED',
    );
    await emit(tx, actor, {
      eventType: PUBLISH_REVIEW_DECIDED,
      aggregateType: AGGREGATE_PUBLISH_REVIEW,
      aggregateId: review.id,
      aggregateVersion: saved.version,
      classification: 'internal',
      payload: { decision: input.decision, subject_kind: current.kind },
    });
    return view(saved);
  });
}

/**
 * Needs `studio.publish` and recent MFA. Under a lock: the draft's current hash still equals the review's,
 * or SIMULATION_STALE. M4 publication joins this transaction through an actual savepoint: its activation
 * and the review receipt either both commit or both roll back. A process uses publishProcessSpecInTx.
 */
export async function publishApproved(
  database: AppDatabase,
  context: TenantContext,
  ports: Pick<ProductPorts, 'agentRegistry'>,
  proof: SessionProof | null,
  input: { reviewId: string; expectedVersion: number },
): Promise<{ publishedRef: string }> {
  return withTenantTx(database, context, async (tx) => {
    const actor = await studioPerson(tx, context, 'studio.publish');
    await assertRecentMfa(tx, actor, 'studio.publish', proof);
    const [receipt] = await tx
      .select({ status: publishReviews.status, publishedRef: publishReviews.publishedRef })
      .from(publishReviews)
      .where(eq(publishReviews.id, canonicalId(input.reviewId)));
    if (receipt?.status === 'published' && receipt.publishedRef)
      return { publishedRef: receipt.publishedRef };
    const { review, current } = await lockedReview(tx, actor, input.reviewId);
    if (review.status === 'published' && review.publishedRef)
      return { publishedRef: review.publishedRef };
    if (review.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (review.status !== 'approved') throw new AppError('REVIEW_NOT_APPROVED');
    if (current.hash !== review.subjectSha256) throw new AppError('SIMULATION_STALE');
    if (!review.decidedByMembershipId) throw new AppError('REVIEW_NOT_APPROVED');
    await currentReviewer(tx, review.decidedByMembershipId);
    const simulation = await passedSimulation(tx, review.simulationRunId, current);
    let publishedRef: string;
    if (current.kind === 'agent_draft') {
      const version = await ports.agentRegistry.publishInTransaction(tx, actor, {
        spec: current.spec,
        evaluationReport: {
          report_version: 1,
          spec_sha256: current.hash,
          policy_version: current.policyVersion,
          suite_ref: STUDIO_SUITE_REF,
          dataset_version: 'studio-synthetic-v1',
          model_label: 'synthetic-rules-no-model',
          pass_rate: 1,
          cases: simulation.report.steps.length,
          passed: true,
          scripted_model: true,
        },
      });
      const [actual] = await tx
        .select()
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.id, canonicalId(version.versionId)),
            eq(agentVersions.specSha256, current.hash),
            eq(agentVersions.definitionId, canonicalId(version.definitionId)),
          ),
        );
      if (
        !actual ||
        ('agentDefinitionId' in current.row &&
          current.row.agentDefinitionId &&
          current.row.agentDefinitionId !== actual.definitionId)
      )
        throw new AppError('SIMULATION_STALE');
      publishedRef = actual.id;
      await tx
        .update(agentDrafts)
        .set({
          status: 'published',
          agentDefinitionId: actual.definitionId,
          version: current.row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(agentDrafts.id, current.row.id));
    } else {
      const result = await publishProcessSpecInTx(tx, actor, {
        processKey: `process-${current.row.id}`,
        name: current.row.name,
        classification: (current.spec as unknown as ProcessSpec).classification,
        spec: current.spec as unknown as ProcessSpec,
        specSha256: current.hash,
        source: 'graph',
        sourceRef: current.row.id,
      });
      publishedRef = result.specId;
      await tx
        .update(processDrafts)
        .set({ status: 'published', version: current.row.version + 1, updatedAt: new Date() })
        .where(eq(processDrafts.id, current.row.id));
    }
    await tx
      .update(publishReviews)
      .set({
        status: 'published',
        publishedRef,
        publishedAt: new Date(),
        version: review.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(publishReviews.id, review.id));
    await auditAction(
      tx,
      actor,
      'publish_review.published',
      `publish_review:${review.id}`,
      'REVIEWED_REVISION',
    );
    await emit(tx, actor, {
      eventType: current.kind === 'agent_draft' ? AGENT_DRAFT_PUBLISHED : PROCESS_SPEC_PUBLISHED,
      aggregateType: AGGREGATE_PUBLISH_REVIEW,
      aggregateId: review.id,
      aggregateVersion: review.version + 1,
      classification: 'internal',
      payload: {
        subject_kind: current.kind,
        subject_id: current.row.id,
        published_ref: publishedRef,
      },
    });
    return { publishedRef };
  });
}
