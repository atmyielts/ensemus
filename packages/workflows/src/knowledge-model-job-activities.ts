import {
  runKnowledgeModelJob,
  type KnowledgeModelJobDeps,
} from '@ensemus/application/ai-knowledge-model-jobs';
import { requestDocumentModelJob } from '@ensemus/application/knowledge/model-jobs';
import { failKnowledgeAnswer } from '@ensemus/application/knowledge/answers';
import { knowledgeAnswers, modelJobs, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { and, eq } from 'drizzle-orm';
import {
  knowledgeModelJobInputSchema,
  type KnowledgeModelJobInput,
  type KnowledgeModelJobResult,
} from './knowledge-model-job-schemas';
import {
  knowledgeAnswerInputSchema,
  knowledgeIngestInputSchema,
  type KnowledgeAnswerInput,
  type KnowledgeAnswerResult,
  type KnowledgeIngestInput,
} from './knowledge-schemas';
import type { EmbedStepResult } from './knowledge-embed-activities';

export function createKnowledgeModelJobActivities(
  deps: KnowledgeModelJobDeps & { activitySignal?: () => AbortSignal },
) {
  const signal = () => deps.activitySignal?.() ?? Context.current().cancellationSignal;
  const run = async (input: KnowledgeModelJobInput): Promise<KnowledgeModelJobResult> => {
    try {
      return await runKnowledgeModelJob(deps, {
        ...knowledgeModelJobInputSchema.parse(input),
        signal: signal(),
      });
    } catch {
      throw ApplicationFailure.create({
        type: 'MODEL_JOB_FAILED',
        message: 'Knowledge model job failed',
      });
    }
  };
  return {
    runKnowledgeModelJob: run,
    async embedDocumentChunks(raw: KnowledgeIngestInput): Promise<EmbedStepResult> {
      const input = knowledgeIngestInputSchema.parse(raw);
      // Keyless ingest may enqueue this Activity, but only the actual durable job performs paid work.
      // The document remains lexically searchable while its explicit approved embedding job runs.
      const job = await requestDocumentModelJob(
        deps.database,
        createServiceContext(input.organizationId),
        input.documentId,
      );
      return { state: job ? 'skipped' : 'denied', count: 0 };
    },
    async answerQuestion(raw: KnowledgeAnswerInput): Promise<KnowledgeAnswerResult> {
      const input = knowledgeAnswerInputSchema.parse(raw),
        service = createServiceContext(input.organizationId);
      const [answer] = await withTenantTx(deps.database, service, (tx) =>
        tx
          .select({
            requester: knowledgeAnswers.requesterMembershipId,
            state: knowledgeAnswers.state,
          })
          .from(knowledgeAnswers)
          .where(eq(knowledgeAnswers.id, input.answerId)),
      );
      if (!answer || !['queued', 'running'].includes(answer.state))
        return { outcome: 'already_done' };
      const [job] = await withTenantTx(deps.database, service, (tx) =>
        tx
          .select({ id: modelJobs.id })
          .from(modelJobs)
          .where(
            and(
              eq(modelJobs.answerId, input.answerId),
              eq(modelJobs.requesterMembershipId, answer.requester),
              eq(modelJobs.kind, 'answer'),
            ),
          ),
      );
      if (!job) {
        await failKnowledgeAnswer(deps.database, service, input.answerId, 'NO_APPROVED_MODEL');
        return { outcome: 'refused' };
      }
      const result = await run({ organizationId: input.organizationId, jobId: job.id });
      if (result.state !== 'completed') return { outcome: 'refused' };
      const [done] = await withTenantTx(deps.database, service, (tx) =>
        tx
          .select({ state: knowledgeAnswers.state })
          .from(knowledgeAnswers)
          .where(eq(knowledgeAnswers.id, input.answerId)),
      );
      return {
        outcome:
          done?.state === 'answered'
            ? 'answered'
            : done?.state === 'no_evidence'
              ? 'no_evidence'
              : 'refused',
      };
    },
  };
}
export type KnowledgeModelJobActivities = ReturnType<typeof createKnowledgeModelJobActivities>;
