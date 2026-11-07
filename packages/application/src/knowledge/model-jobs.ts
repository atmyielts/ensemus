// Public request/approval surface only. It cannot read private job payloads, unseal a key or call a
// provider. Every request is immutable, bounded and committed with its durable wake-up event.
import { createHash, randomUUID } from 'node:crypto';
import {
  approveModelWorkloadSchema,
  requestKnowledgeModelJobSchema,
  requestModelQualificationSchema,
  type ApproveModelWorkload,
  type RequestKnowledgeModelJob,
  type RequestModelQualification,
} from '@ensemus/contracts/knowledge-models';
import {
  actorOf,
  appendAudit,
  knowledgeAnswers,
  knowledgeDocuments,
  knowledgeSources,
  memberships,
  modelJobs,
  modelJobPayloads,
  modelOperationQualifications,
  modelProfiles,
  modelWorkloadApprovals,
  knowledgeEvidencePackages,
  modelWorkloadProfiles,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  MODEL_JOB_REQUESTED,
  AGGREGATE_MODEL_JOB,
  modelBoundsWithin,
  protocolForPurpose,
  qualifiedFor,
  type ModelJobBounds,
  type QualifiedModelOperation,
} from '@ensemus/domain/knowledge-models';
import { can, type Classification } from '@ensemus/domain/policy';
import { strongestClass } from '@ensemus/domain/knowledge';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { emit } from '../events';
import { idFromRequest } from '../request-id';
import { canonicalJson } from '@ensemus/domain/approval';
import { idSchema } from '../ids';
import { requireSearchPerson } from './retrieval';
import { assertInteractivePrivilege, withPrivilegeTx as withTenantTx } from '../product/privileged';

export const modelRequestHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const rank = (value: string) => ['public', 'internal', 'confidential', 'restricted'].indexOf(value);
/** The joined M7 verified-session gate binds this in the same effect transaction. A browser-supplied
 * flag/string is never admission, and an unavailable binding refuses new spend authority. */
export interface ModelAuthorityAdmission {
  assertInTx(tx: Tx, context: TenantContext): Promise<void>;
}

async function requireManager(tx: Tx, context: TenantContext) {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  await requireSearchPerson(tx, context);
  const [member] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, context.membershipId), eq(memberships.status, 'active')))
    .for('share');
  if (!member || !can(member.role, 'model.activate') || !can(member.role, 'budget.manage'))
    throw new AppError('FORBIDDEN');
}
export async function requestModelQualification(
  database: AppDatabase,
  context: TenantContext,
  raw: RequestModelQualification,
  admission: ModelAuthorityAdmission = {
    assertInTx: (tx, originalContext) =>
      assertInteractivePrivilege(tx, originalContext, 'model_profile.activate'),
  },
): Promise<{ qualificationId: string; jobId: string }> {
  const parsed = requestModelQualificationSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const input = parsed.data;
  return withTenantTx(database, context, async (tx) => {
    await requireManager(tx, context);
    await admission.assertInTx(tx, context);
    const [existing] = await tx
      .select()
      .from(modelOperationQualifications)
      .where(
        and(
          eq(modelOperationQualifications.requestedByMembershipId, context.membershipId),
          eq(modelOperationQualifications.requestKey, input.requestKey),
        ),
      );
    if (existing) {
      if (
        existing.profileId !== input.profileId ||
        existing.profileVersion !== input.expectedProfileVersion ||
        existing.purpose !== input.purpose ||
        existing.dimension !== input.dimension ||
        existing.vectorSpaceVersion !== input.vectorSpaceVersion ||
        !sameBounds(existing, input.bounds)
      )
        throw new AppError('INVALID_INPUT');
      const [job] = await tx
        .select({ id: modelJobs.id })
        .from(modelJobs)
        .where(eq(modelJobs.qualificationId, existing.id));
      if (!job) throw new AppError('INVALID_STATE');
      return { qualificationId: existing.id, jobId: job.id };
    }
    const [profile] = await tx
      .select()
      .from(modelProfiles)
      .where(
        and(
          eq(modelProfiles.id, input.profileId),
          eq(modelProfiles.version, input.expectedProfileVersion),
        ),
      )
      .for('update');
    if (!profile || !profile.allowedPurposes.includes(input.purpose))
      throw new AppError('NOT_FOUND');
    if (profile.providerKind === 'anthropic_hosted' && input.purpose === 'embed')
      throw new AppError('INVALID_INPUT');
    const qualificationId = randomUUID(),
      jobId = randomUUID();
    await tx
      .update(modelProfiles)
      .set({
        status: 'probing',
        probeRequestedByMembershipId: context.membershipId,
        updatedAt: new Date(),
      })
      .where(eq(modelProfiles.id, profile.id));
    const [insertedQualification] = await tx
      .insert(modelOperationQualifications)
      .values({
        organizationId: context.organizationId,
        id: qualificationId,
        profileId: profile.id,
        profileVersion: profile.version,
        purpose: input.purpose,
        protocol: protocolForPurpose(input.purpose),
        dimension: input.dimension,
        vectorSpaceVersion: input.vectorSpaceVersion,
        requestedByMembershipId: context.membershipId,
        requestKey: input.requestKey,
        ...input.bounds,
      })
      .onConflictDoNothing()
      .returning({ id: modelOperationQualifications.id });
    if (!insertedQualification) {
      const [prior] = await tx
        .select()
        .from(modelOperationQualifications)
        .where(
          and(
            eq(modelOperationQualifications.requestedByMembershipId, context.membershipId),
            eq(modelOperationQualifications.requestKey, input.requestKey),
          ),
        );
      if (
        !prior ||
        prior.profileId !== input.profileId ||
        prior.profileVersion !== input.expectedProfileVersion ||
        prior.purpose !== input.purpose ||
        prior.dimension !== input.dimension ||
        prior.vectorSpaceVersion !== input.vectorSpaceVersion ||
        !sameBounds(prior, input.bounds)
      )
        throw new AppError('INVALID_INPUT');
      const [priorJob] = await tx
        .select({ id: modelJobs.id })
        .from(modelJobs)
        .where(eq(modelJobs.qualificationId, prior.id));
      if (!priorJob) throw new AppError('INVALID_STATE');
      return { qualificationId: prior.id, jobId: priorJob.id };
    }
    await tx.insert(modelJobs).values({
      organizationId: context.organizationId,
      id: jobId,
      requesterMembershipId: context.membershipId,
      qualificationId,
      kind: 'qualification',
      requestKey: input.requestKey,
      requestHash: modelRequestHash(input),
      classification: 'public',
      ...input.bounds,
      deadlineAt: new Date(Date.now() + input.bounds.timeoutSeconds * 1000),
    });
    await wake(tx, context, jobId, 'public');
    await appendAudit(tx, {
      organizationId: context.organizationId,
      ...actorOf(context),
      action: 'model.qualification_requested',
      targetRef: `model_qualification:${qualificationId}`,
      decision: 'allow',
    });
    return { qualificationId, jobId };
  });
}

export async function approveModelWorkload(
  database: AppDatabase,
  context: TenantContext,
  raw: ApproveModelWorkload,
  admission: ModelAuthorityAdmission = {
    assertInTx: (tx, originalContext) =>
      assertInteractivePrivilege(tx, originalContext, 'model_workload.approve'),
  },
): Promise<{ approvalId: string }> {
  const parsed = approveModelWorkloadSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const input = parsed.data;
  if (new Date(input.expiresAt).getTime() <= Date.now()) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    await requireManager(tx, context);
    await admission.assertInTx(tx, context);
    if (input.sourceId) {
      const source = await tx.execute(
        sql`select s.id from knowledge.sources s where s.id=${input.sourceId}::uuid and s.state='active' and s.id in(select knowledge.readable_source_ids(${context.membershipId}::uuid)) for share`,
      );
      if (!source.rows.length) throw new AppError('NOT_FOUND');
    }
    const qualificationIds = [...new Set(input.qualificationIds)].sort();
    const qualifications: QualifiedModelOperation[] = [];
    for (const qualificationId of qualificationIds) {
      const result = await tx
        .select({ qualification: modelOperationQualifications, profile: modelProfiles })
        .from(modelOperationQualifications)
        .innerJoin(
          modelProfiles,
          and(
            eq(modelProfiles.organizationId, modelOperationQualifications.organizationId),
            eq(modelProfiles.id, modelOperationQualifications.profileId),
          ),
        )
        .where(eq(modelOperationQualifications.id, qualificationId));
      const row = result[0];
      if (!row) throw new AppError('NOT_FOUND');
      const q = row.qualification as QualifiedModelOperation;
      if (
        !input.purposes.includes(q.purpose) ||
        row.profile.status !== 'active' ||
        !qualifiedFor(q, row.profile as Parameters<typeof qualifiedFor>[1], q.purpose)
      )
        throw new AppError('INVALID_STATE');
      qualifications.push(q);
    }
    if (input.purposes.some((purpose) => !qualifications.some((q) => q.purpose === purpose)))
      throw new AppError('INVALID_INPUT');
    const approvalId = idFromRequest(
      'model-workload-approval',
      context.membershipId,
      input.requestKey,
      [modelRequestHash({ ...input, qualificationIds })],
    );
    const [existing] = await tx
      .select({ id: modelWorkloadApprovals.id })
      .from(modelWorkloadApprovals)
      .where(
        and(
          eq(modelWorkloadApprovals.approvedByMembershipId, context.membershipId),
          eq(modelWorkloadApprovals.requestKey, input.requestKey),
        ),
      );
    if (existing) {
      if (existing.id !== approvalId) throw new AppError('INVALID_INPUT');
      return { approvalId };
    }
    const [insertedApproval] = await tx
      .insert(modelWorkloadApprovals)
      .values({
        organizationId: context.organizationId,
        id: approvalId,
        kind: input.kind,
        scope: input.scope,
        sourceId: input.sourceId,
        connectionId: input.connectionId,
        purposes: [...new Set(input.purposes)].sort(),
        maxClassification: input.maxClassification,
        ...input.bounds,
        approvedByMembershipId: context.membershipId,
        requestKey: input.requestKey,
        expiresAt: new Date(input.expiresAt),
      })
      .onConflictDoNothing()
      .returning({ id: modelWorkloadApprovals.id });
    if (!insertedApproval) {
      const [prior] = await tx
        .select({ id: modelWorkloadApprovals.id })
        .from(modelWorkloadApprovals)
        .where(
          and(
            eq(modelWorkloadApprovals.approvedByMembershipId, context.membershipId),
            eq(modelWorkloadApprovals.requestKey, input.requestKey),
          ),
        );
      if (prior?.id !== approvalId) throw new AppError('INVALID_INPUT');
      return { approvalId };
    }
    await tx.insert(modelWorkloadProfiles).values(
      qualificationIds.map((qualificationId) => ({
        organizationId: context.organizationId,
        approvalId,
        qualificationId,
      })),
    );
    await appendAudit(tx, {
      organizationId: context.organizationId,
      ...actorOf(context),
      action: 'model.workload_approved',
      targetRef: `model_workload:${approvalId}`,
      decision: 'allow',
    });
    return { approvalId };
  });
}

export async function revokeModelWorkload(
  database: AppDatabase,
  context: TenantContext,
  approvalId: string,
): Promise<void> {
  const id = idSchema.safeParse(approvalId);
  if (!id.success) throw new AppError('INVALID_INPUT');
  await withTenantTx(database, context, async (tx) => {
    await requireManager(tx, context);
    const rows = await tx
      .update(modelWorkloadApprovals)
      .set({ revokedAt: new Date() })
      .where(and(eq(modelWorkloadApprovals.id, id.data), isNull(modelWorkloadApprovals.revokedAt)))
      .returning({ id: modelWorkloadApprovals.id });
    if (rows.length)
      await appendAudit(tx, {
        organizationId: context.organizationId,
        ...actorOf(context),
        action: 'model.workload_revoked',
        targetRef: `model_workload:${id.data}`,
        decision: 'allow',
      });
  });
}

export async function requestKnowledgeModelJob(
  database: AppDatabase,
  context: TenantContext,
  raw: RequestKnowledgeModelJob,
): Promise<{ jobId: string }> {
  const parsed = requestKnowledgeModelJobSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  if (context.actorType !== 'user' && context.actorType !== 'delegated')
    throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, (tx) =>
    requestKnowledgeModelJobInTx(tx, context, parsed.data),
  );
}
export async function requestKnowledgeModelJobInTx(
  tx: Tx,
  context: TenantContext,
  input: RequestKnowledgeModelJob,
): Promise<{ jobId: string }> {
  await requireSearchPerson(tx, context);
  const [approval] = await tx
    .select()
    .from(modelWorkloadApprovals)
    .where(eq(modelWorkloadApprovals.id, input.approvalId))
    .for('share');
  if (
    !approval ||
    approval.kind !== input.kind ||
    approval.revokedAt ||
    approval.expiresAt.getTime() <= Date.now() ||
    !modelBoundsWithin(input.bounds, approval) ||
    rank(input.classification) < 0 ||
    rank(input.classification) > rank(approval.maxClassification)
  )
    throw new AppError('FORBIDDEN');
  if (input.answerId) {
    const [answer] = await tx
      .select()
      .from(knowledgeAnswers)
      .where(eq(knowledgeAnswers.id, input.answerId));
    if (
      !answer ||
      answer.requesterMembershipId !== context.membershipId ||
      answer.question !== input.query ||
      answer.questionClassification !== input.classification ||
      answer.state !== 'queued'
    )
      throw new AppError('NOT_FOUND');
  }
  const requestHash = modelRequestHash(input);
  const [prior] = await tx
    .select()
    .from(modelJobs)
    .where(
      and(
        eq(modelJobs.requesterMembershipId, context.membershipId),
        eq(modelJobs.requestKey, input.requestKey),
      ),
    );
  if (prior) {
    if (prior.requestHash !== requestHash) throw new AppError('INVALID_INPUT');
    return { jobId: prior.id };
  }
  const jobId = randomUUID();
  const [insertedJob] = await tx
    .insert(modelJobs)
    .values({
      organizationId: context.organizationId,
      id: jobId,
      requesterMembershipId: context.membershipId,
      approvalId: approval.id,
      kind: input.kind,
      answerId: input.answerId,
      requestKey: input.requestKey,
      requestHash,
      classification: input.classification,
      ...input.bounds,
      deadlineAt: new Date(
        Math.min(approval.expiresAt.getTime(), Date.now() + input.bounds.timeoutSeconds * 1000),
      ),
    })
    .onConflictDoNothing()
    .returning({ id: modelJobs.id });
  if (!insertedJob) {
    const [prior] = await tx
      .select()
      .from(modelJobs)
      .where(
        and(
          eq(modelJobs.requesterMembershipId, context.membershipId),
          eq(modelJobs.requestKey, input.requestKey),
        ),
      );
    if (!prior || prior.requestHash !== requestHash) throw new AppError('INVALID_INPUT');
    return { jobId: prior.id };
  }
  // An answer already has its question in the existing source-guarded answer table. A query's private
  // payload is one write-only insert from web; the model worker is the sole reader/purger.
  if (input.kind === 'query')
    await tx
      .insert(modelJobPayloads)
      .values({ organizationId: context.organizationId, jobId, query: input.query });
  // Answers already have their durable knowledgeAnswerWorkflow wake-up. A second model-job workflow
  // could close its shared job while the first Activity is still publishing the answer.
  if (input.kind !== 'answer') await wake(tx, context, jobId, input.classification);
  return { jobId };
}

/** Automatic embedding is permitted only by a current explicit source/connection workload approval.
 * Its named approver remains the viewer: service inspection never widens that person's source ACL. */
export async function requestDocumentModelJob(
  database: AppDatabase,
  context: TenantContext,
  documentId: string,
): Promise<{ jobId: string } | null> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const id = idSchema.safeParse(documentId);
  if (!id.success) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    const [document] = await tx
      .select({ document: knowledgeDocuments, source: knowledgeSources })
      .from(knowledgeDocuments)
      .innerJoin(
        knowledgeSources,
        and(
          eq(knowledgeSources.organizationId, knowledgeDocuments.organizationId),
          eq(knowledgeSources.id, knowledgeDocuments.sourceId),
        ),
      )
      .where(
        and(
          eq(knowledgeDocuments.id, id.data),
          eq(knowledgeDocuments.state, 'searchable'),
          isNull(knowledgeDocuments.supersededAt),
          eq(knowledgeSources.state, 'active'),
        ),
      );
    if (!document) return null;
    const approvals = await tx
      .select()
      .from(modelWorkloadApprovals)
      .where(
        and(
          eq(modelWorkloadApprovals.kind, 'document_embed'),
          isNull(modelWorkloadApprovals.revokedAt),
          sql`${modelWorkloadApprovals.expiresAt}>now()`,
          sql`(${modelWorkloadApprovals.sourceId}=${document.source.id}::uuid or (${modelWorkloadApprovals.connectionId}=${document.source.connectionId}::uuid and ${modelWorkloadApprovals.scope}='connection'))`,
        ),
      )
      .orderBy(asc(modelWorkloadApprovals.id));
    const classification = strongestClass([
      document.document.classification as Classification,
      document.source.classification as Classification,
    ]);
    for (const approval of approvals) {
      if (
        !approval.purposes.includes('embed') ||
        rank(classification) > rank(approval.maxClassification)
      )
        continue;
      const allowed = await tx.execute(
        sql`select 1 where ${document.source.id}::uuid in(select knowledge.readable_source_ids(${approval.approvedByMembershipId}::uuid))`,
      );
      if (!allowed.rows.length) continue;
      const requestKey = idFromRequest(
        'document-model-job',
        approval.approvedByMembershipId,
        document.document.id,
        [approval.id, document.document.contentSha256],
      );
      const requestHash = modelRequestHash({
        documentId: document.document.id,
        contentSha256: document.document.contentSha256,
        approvalId: approval.id,
      });
      const [prior] = await tx
        .select({ id: modelJobs.id })
        .from(modelJobs)
        .where(
          and(
            eq(modelJobs.requesterMembershipId, approval.approvedByMembershipId),
            eq(modelJobs.requestKey, requestKey),
          ),
        );
      if (prior) return { jobId: prior.id };
      const jobId = randomUUID();
      const [inserted] = await tx
        .insert(modelJobs)
        .values({
          organizationId: context.organizationId,
          id: jobId,
          requesterMembershipId: approval.approvedByMembershipId,
          approvalId: approval.id,
          kind: 'document_embed',
          documentId: document.document.id,
          requestKey,
          requestHash,
          classification,
          ...pickBounds(approval),
          deadlineAt: new Date(
            Math.min(approval.expiresAt.getTime(), Date.now() + approval.timeoutSeconds * 1000),
          ),
        })
        .onConflictDoNothing()
        .returning({ id: modelJobs.id });
      if (!inserted) {
        const [prior] = await tx
          .select()
          .from(modelJobs)
          .where(
            and(
              eq(modelJobs.requesterMembershipId, approval.approvedByMembershipId),
              eq(modelJobs.requestKey, requestKey),
            ),
          );
        if (!prior || prior.requestHash !== requestHash) throw new AppError('INVALID_INPUT');
        return { jobId: prior.id };
      }
      await wake(tx, context, jobId, classification);
      return { jobId };
    }
    return null;
  });
}
export const pickBounds = (value: ModelJobBounds): ModelJobBounds => ({
  maxCalls: value.maxCalls,
  maxInputTokens: value.maxInputTokens,
  maxOutputTokens: value.maxOutputTokens,
  maxTotalTokens: value.maxTotalTokens,
  maxCostMicros: value.maxCostMicros,
  timeoutSeconds: value.timeoutSeconds,
});
const sameBounds = (a: ModelJobBounds, b: ModelJobBounds) =>
  modelRequestHash(pickBounds(a)) === modelRequestHash(pickBounds(b));
async function wake(tx: Tx, context: TenantContext, jobId: string, classification: Classification) {
  await emit(tx, context, {
    eventType: MODEL_JOB_REQUESTED,
    aggregateType: AGGREGATE_MODEL_JOB,
    aggregateId: jobId,
    aggregateVersion: 1,
    classification,
    payload: { model_job_id: jobId },
  });
}
export type KnowledgeModelJobView = {
  id: string;
  kind: string;
  state: string;
  code: string | null;
  costMicros: number;
  result: null | {
    packageId: string;
    classification: Classification;
    engine: 'lexical' | 'hybrid';
    items: readonly {
      chunkId: string;
      sourceId: string;
      documentId: string;
      title: string;
      excerpt: string;
    }[];
  };
};
/** Reads an already durable semantic result under the original requester's fresh live ACL. No query
 * payload or raw provider response is read by the app role, and no model is called from HTTP. */
export async function getKnowledgeModelJob(
  database: AppDatabase,
  context: TenantContext,
  jobId: string,
): Promise<KnowledgeModelJobView> {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  const parsed = idSchema.safeParse(jobId);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    const [job] = await tx
      .select()
      .from(modelJobs)
      .where(
        and(
          eq(modelJobs.id, parsed.data),
          eq(modelJobs.requesterMembershipId, context.membershipId),
        ),
      );
    if (!job) throw new AppError('NOT_FOUND');
    if (!Number.isSafeInteger(job.spentMicros)) throw new AppError('INVALID_STATE');
    const view: KnowledgeModelJobView = {
      id: job.id,
      kind: job.kind,
      state: job.state,
      code: job.refusalCode,
      costMicros: job.spentMicros,
      result: null,
    };
    if (job.kind !== 'query' || job.state !== 'completed' || !job.resultPackageId) return view;
    const [pkg] = await tx
      .select()
      .from(knowledgeEvidencePackages)
      .where(
        and(
          eq(knowledgeEvidencePackages.id, job.resultPackageId),
          eq(knowledgeEvidencePackages.viewerMembershipId, context.membershipId),
        ),
      );
    if (!pkg) throw new AppError('NOT_FOUND');
    const sources = await tx.execute<{ id: string }>(sql`select distinct v.id from(
      select i.source_id id from knowledge.evidence_items i where i.organization_id=${context.organizationId}::uuid and i.package_id=${pkg.id}::uuid
      union select i.source_id id from ai.model_call_inputs i join ai.model_call_attempts c on c.organization_id=i.organization_id and c.id=i.call_id where c.organization_id=${context.organizationId}::uuid and c.job_id=${job.id}::uuid and i.source_id is not null)v order by v.id limit 1001`);
    if (sources.rows.length > 1000) throw new AppError('NOT_FOUND');
    if (sources.rows.length)
      await tx.execute(
        sql`select s.id from knowledge.sources s where s.organization_id=${context.organizationId}::uuid and s.id in(${sql.join(
          sources.rows.map((row) => sql`${row.id}::uuid`),
          sql`,`,
        )}) order by s.id for share nowait`,
      );
    const records = await tx.execute<{ kind: string; id: string }>(
      sql`select distinct i.kind,i.input_id id from ai.model_call_inputs i join ai.model_call_attempts c on c.organization_id=i.organization_id and c.id=i.call_id where c.organization_id=${context.organizationId}::uuid and c.job_id=${job.id}::uuid and i.kind<>'chunk' order by i.kind,i.input_id limit 1001`,
    );
    if (records.rows.length > 1000) throw new AppError('NOT_FOUND');
    for (const record of records.rows) {
      const locked = await tx.execute<{ ok: boolean }>(
        sql`select knowledge.lock_structured_record(${record.kind},${record.id}::uuid) ok`,
      );
      if (!locked.rows[0]?.ok) throw new AppError('NOT_FOUND');
    }
    const proof = await tx.execute<{ ok: boolean }>(
      sql`select ai.model_job_inputs_readable(${job.id}::uuid,${context.membershipId}::uuid,${pkg.strongestClassification}) ok`,
    );
    if (!proof.rows[0]?.ok) throw new AppError('NOT_FOUND');
    const items = await tx.execute<{
      chunkId: string;
      sourceId: string;
      documentId: string;
      title: string;
      excerpt: string;
    }>(sql`select c.id "chunkId",c.source_id "sourceId",c.document_id "documentId",d.title,c.text_body excerpt
      from knowledge.evidence_items i join knowledge.chunks c on c.organization_id=i.organization_id and c.id=i.chunk_id and c.content_sha256=i.content_sha256
      join knowledge.documents d on d.organization_id=c.organization_id and d.id=c.document_id
      join knowledge.sources s on s.organization_id=c.organization_id and s.id=c.source_id
      where i.organization_id=${context.organizationId}::uuid and i.package_id=${pkg.id}::uuid and d.state='searchable' and d.superseded_at is null
        and greatest(knowledge.class_rank(d.classification),knowledge.class_rank(s.classification))<=knowledge.class_rank(${pkg.strongestClassification})
        and c.source_id in(select knowledge.readable_source_ids(${context.membershipId}::uuid)) order by i.ordinal limit 50`);
    const count = await tx.execute<{ count: number }>(
      sql`select count(*)::int count from knowledge.evidence_items where organization_id=${context.organizationId}::uuid and package_id=${pkg.id}::uuid`,
    );
    if (count.rows[0]?.count !== items.rows.length) throw new AppError('NOT_FOUND');
    view.result = {
      packageId: pkg.id,
      classification: pkg.strongestClassification as Classification,
      engine: pkg.spaceId ? 'hybrid' : 'lexical',
      items: items.rows,
    };
    return view;
  });
}
