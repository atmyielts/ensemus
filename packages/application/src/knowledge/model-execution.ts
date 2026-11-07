// Agent-worker orchestration. Temporal carries the durable job ID, never a query, vector or answer.
// An unacknowledged paid attempt is reconciled as unknown and never automatically resent.
import {
  knowledgeAnswers,
  modelCallAttempts,
  modelEvaluations,
  modelJobPayloads,
  modelJobs,
  modelOperationQualifications,
  modelProfiles,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { createDelegatedContext, createServiceContext } from '@ensemus/database/service';
import { operationKey, qualificationOperation } from '@ensemus/knowledge/model-operations';
import { ModelCallFailed, type ModelUsage } from '@ensemus/knowledge/ports';
import type { KnowledgeModelPurpose } from '@ensemus/domain/knowledge-models';
import type { Classification } from '@ensemus/domain/policy';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../errors';
import { compileEvidence, type CompileDeps } from './compiler';
import { embedDocument } from './embeddings';
import { failKnowledgeAnswer, runAnswer } from './answers';
import { modelRequestHash, pickBounds } from './model-jobs';
import { withModelPrincipalTx, type KnowledgeCallAccounting } from '../ai/knowledge-call-store';
import { purgeModelJobPayloads, purgeModelJobPayloadsInTx } from '../ai/knowledge-job-content';
import type { KnowledgeCallStore, KnowledgeModelPrincipal } from '../ai/knowledge-ports';

export type KnowledgeModelJobDeps = {
  database: AppDatabase;
  calls: KnowledgeCallStore & KnowledgeCallAccounting;
  forPrincipal: (principal: KnowledgeModelPrincipal) => CompileDeps;
};
export type ModelJobOutcome = { state: 'completed' | 'refused' | 'missing'; code: string | null };

export async function runKnowledgeModelJob(
  deps: KnowledgeModelJobDeps,
  input: { organizationId: string; jobId: string; signal: AbortSignal },
): Promise<ModelJobOutcome> {
  const { database } = deps,
    service = createServiceContext(input.organizationId);
  const [initial] = await withTenantTx(database, service, (tx) =>
    tx.select().from(modelJobs).where(eq(modelJobs.id, input.jobId)),
  );
  if (!initial) return { state: 'missing', code: null };
  if (initial.state === 'completed') {
    await purgeModelJobPayloads(database, service, initial.id);
    return { state: 'completed', code: null };
  }
  if (initial.state === 'refused' || initial.state === 'fenced') {
    await deps.calls.reconcileJob(service, initial.id);
    await purgeModelJobPayloads(database, service, initial.id);
    return { state: 'refused', code: initial.refusalCode ?? 'MODEL_UNAVAILABLE' };
  }
  let requester: TenantContext;
  try {
    requester = await createDelegatedContext(
      database,
      input.organizationId,
      initial.requesterMembershipId,
    );
  } catch {
    await deps.calls.reconcileJob(service, initial.id);
    await endJob(database, service, initial.id, 'refused', 'REQUESTER_INACTIVE');
    return { state: 'refused', code: 'REQUESTER_INACTIVE' };
  }
  const principal: KnowledgeModelPrincipal = { kind: 'job', context: requester, jobId: initial.id };
  try {
    const attempts = await withModelPrincipalTx(database, principal, (tx) =>
      tx
        .select({ id: modelCallAttempts.id, state: modelCallAttempts.state })
        .from(modelCallAttempts)
        .where(eq(modelCallAttempts.jobId, initial.id)),
    );
    for (const attempt of attempts)
      if (attempt.state === 'dispatched') await deps.calls.recoverUnknown(principal, attempt.id);
    if (attempts.some((attempt) => attempt.state === 'dispatched' || attempt.state === 'unknown'))
      throw new ModelCallFailed('MODEL_UNAVAILABLE');
    const model = deps.forPrincipal(principal);
    let successful = false,
      resultPackageId: string | null = null,
      code: string | null = null;
    if (initial.kind === 'qualification')
      successful = await qualify(deps, principal, model, initial.qualificationId!, input.signal);
    else if (initial.kind === 'document_embed') {
      const result = await embedDocument(database, service, model, {
        documentId: initial.documentId!,
        signal: input.signal,
      });
      successful = result.state === 'embedded';
      code = result.code;
    } else if (initial.kind === 'answer') {
      const result = await runAnswer(database, { service, asker: requester }, model, {
        answerId: initial.answerId!,
        signal: input.signal,
      });
      if (result.outcome === 'already_done') {
        const [answer] = await withTenantTx(database, service, (tx) =>
          tx
            .select({ state: knowledgeAnswers.state })
            .from(knowledgeAnswers)
            .where(eq(knowledgeAnswers.id, initial.answerId!)),
        );
        successful = answer?.state === 'answered' || answer?.state === 'no_evidence';
      } else successful = result.outcome === 'answered' || result.outcome === 'no_evidence';
      code = result.code;
    } else {
      const [payload] = await withModelPrincipalTx(database, principal, (tx) =>
        tx.select().from(modelJobPayloads).where(eq(modelJobPayloads.jobId, initial.id)),
      );
      if (
        !payload ||
        modelRequestHash({
          kind: 'query',
          approvalId: initial.approvalId,
          requestKey: initial.requestKey,
          bounds: pickBounds(initial),
          classification: initial.classification,
          query: payload.query,
          answerId: null,
        }) !== initial.requestHash
      )
        throw new ModelCallFailed('EGRESS_DENIED');
      const compiled = await compileEvidence(database, requester, model, {
        purpose: 'query',
        question: payload.query,
        queryClassification: initial.classification as Classification,
        budgetTokens: initial.maxInputTokens,
        signal: input.signal,
      });
      successful = compiled.ok;
      if (compiled.ok) resultPackageId = compiled.packageId;
      else code = compiled.code;
    }
    if (!successful) await deps.calls.reconcileJob(service, initial.id);
    await endJob(
      database,
      service,
      initial.id,
      successful ? 'completed' : 'refused',
      code,
      resultPackageId,
    );
    return { state: successful ? 'completed' : 'refused', code };
  } catch (error) {
    const code = error instanceof ModelCallFailed ? error.code : 'MODEL_UNAVAILABLE';
    await deps.calls.reconcileJob(service, initial.id);
    if (initial.answerId) await failKnowledgeAnswer(database, service, initial.answerId);
    await endJob(database, service, initial.id, 'refused', code);
    return { state: 'refused', code };
  }
}

async function qualify(
  deps: KnowledgeModelJobDeps,
  principal: Extract<KnowledgeModelPrincipal, { kind: 'job' }>,
  model: CompileDeps,
  qualificationId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const [q] = await withModelPrincipalTx(deps.database, principal, (tx) =>
    tx
      .select()
      .from(modelOperationQualifications)
      .where(eq(modelOperationQualifications.id, qualificationId)),
  );
  if (!q || q.state !== 'requested') return false;
  const operation = qualificationOperation(q.purpose as KnowledgeModelPurpose, q.dimension);
  const decision = await model.model.route({
    organizationId: principal.context.organizationId,
    purpose: operation.purpose,
    classification: 'public',
  });
  if (decision.decision !== 'allow' || decision.route.qualificationId !== q.id) return false;
  const metadata = {
    operationKey: operationKey({ kind: 'qualification', qualificationId: q.id }),
    inputs: [],
  };
  let usage: ModelUsage, resultDigest: string;
  if (operation.purpose === 'embed') {
    const result = await model.model.embed(
      principal.context.organizationId,
      decision.route,
      operation.inputs,
      signal,
      metadata,
    );
    if (result.vectors.length !== 2) return false;
    usage = result.usage;
    resultDigest = operationKey(result.vectors);
  } else if (operation.purpose === 'rerank') {
    const result = await model.model.rerank(
      principal.context.organizationId,
      decision.route,
      operation.query,
      operation.passages,
      signal,
      metadata,
    );
    if (JSON.stringify(result.order) !== '[1,0]') return false;
    usage = result.usage;
    resultDigest = operationKey(result.order);
  } else {
    const result = await model.model.answer(
      principal.context.organizationId,
      decision.route,
      operation.messages,
      signal,
      metadata,
    );
    if (result.text.trim() !== 'ready') return false;
    usage = result.usage;
    resultDigest = operationKey(result.text);
  }
  if (!model.acceptResultInTx || !usage.callId) return false;
  await withModelPrincipalTx(deps.database, principal, async (tx) => {
    await model.acceptResultInTx!(tx, usage, { kind: 'qualification', id: q.id });
    await tx
      .update(modelOperationQualifications)
      .set({ state: 'passed', qualifiedAt: new Date(), resultDigest })
      .where(
        and(
          eq(modelOperationQualifications.id, q.id),
          eq(modelOperationQualifications.state, 'requested'),
        ),
      );
    const activated = await tx
      .update(modelProfiles)
      .set({ status: 'active', qualifiedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(modelProfiles.id, q.profileId),
          eq(modelProfiles.version, q.profileVersion),
          eq(modelProfiles.status, 'probing'),
        ),
      )
      .returning({ id: modelProfiles.id });
    if (!activated.length) throw new AppError('INVALID_STATE');
    await tx.insert(modelEvaluations).values({
      organizationId: principal.context.organizationId,
      profileId: q.profileId,
      profileVersion: q.profileVersion,
      suite: q.protocol,
      passed: true,
    });
  });
  return true;
}
async function endJob(
  database: AppDatabase,
  service: TenantContext,
  jobId: string,
  state: 'completed' | 'refused',
  code: string | null,
  resultPackageId: string | null = null,
) {
  await withTenantTx(database, service, async (tx) => {
    const [job] = await tx.select().from(modelJobs).where(eq(modelJobs.id, jobId)).for('update');
    if (!job) return;
    if (state === 'refused' && job.qualificationId) {
      await tx
        .update(modelOperationQualifications)
        .set({ state: 'failed', qualifiedAt: null })
        .where(
          and(
            eq(modelOperationQualifications.id, job.qualificationId),
            eq(modelOperationQualifications.state, 'requested'),
          ),
        );
      const [q] = await tx
        .select()
        .from(modelOperationQualifications)
        .where(eq(modelOperationQualifications.id, job.qualificationId));
      if (q?.state === 'failed')
        await tx
          .update(modelProfiles)
          .set({ status: 'probe_failed', qualifiedAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(modelProfiles.id, q.profileId),
              eq(modelProfiles.version, q.profileVersion),
              eq(modelProfiles.status, 'probing'),
            ),
          );
    }
    if (['prepared', 'running'].includes(job.state))
      await tx
        .update(modelJobs)
        .set({ state, refusalCode: code, resultPackageId })
        .where(eq(modelJobs.id, jobId));
    else if (job.state === 'fenced' && state === 'refused' && code)
      await tx.update(modelJobs).set({ refusalCode: code }).where(eq(modelJobs.id, jobId));
    // Only this actual agent role can delete private request text. The permanent job fence also
    // rejects a late/in-flight insertion; durable zero-count certification is recorded separately.
    await purgeModelJobPayloadsInTx(tx, service, jobId);
  });
}
