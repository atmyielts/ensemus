// Owned by the compile slice (UX-18's backend). See docs/06-delivery/m5-slices.md. `answerQuestion` runs in
// M4's agent worker, under a delegated context for the person who asked, and never a bare service context.
// `failAnswer` runs in the knowledge worker, for when no agent worker came.
import { knowledgeAnswers, withTenantTx, type AppDatabase } from '@ensemus/database';
import { createDelegatedContext, createServiceContext } from '@ensemus/database/service';
import { failKnowledgeAnswer, runAnswer } from '@ensemus/application/knowledge/answers';
import { eq } from 'drizzle-orm';
import type { KnowledgeModelDeps } from './knowledge-deps';
import type { KnowledgeAnswerInput, KnowledgeAnswerResult } from './knowledge-schemas';

export function createKnowledgeAnswerActivities(deps: KnowledgeModelDeps) {
  return {
    async answerQuestion(input: KnowledgeAnswerInput): Promise<KnowledgeAnswerResult> {
      const service = createServiceContext(input.organizationId);
      const [row] = await withTenantTx(deps.database, service, (tx) =>
        tx
          .select({ membershipId: knowledgeAnswers.requesterMembershipId })
          .from(knowledgeAnswers)
          .where(eq(knowledgeAnswers.id, input.answerId)),
      );
      if (!row) return { outcome: 'already_done' };
      let asker;
      try {
        asker = await createDelegatedContext(deps.database, input.organizationId, row.membershipId);
      } catch {
        await failKnowledgeAnswer(deps.database, service, input.answerId);
        return { outcome: 'failed' };
      }
      const result = await runAnswer(deps.database, { service, asker }, deps, {
        answerId: input.answerId,
        signal: deps.activitySignal?.() ?? AbortSignal.timeout(240_000),
      });
      return { outcome: result.outcome };
    },
  };
}
export type KnowledgeAnswerActivities = ReturnType<typeof createKnowledgeAnswerActivities>;

export function createKnowledgeAnswerFallbackActivities(deps: { database: AppDatabase }) {
  return {
    async failAnswer(input: KnowledgeAnswerInput): Promise<void> {
      await failKnowledgeAnswer(
        deps.database,
        createServiceContext(input.organizationId),
        input.answerId,
      );
    },
  };
}
export type KnowledgeAnswerFallbackActivities = ReturnType<
  typeof createKnowledgeAnswerFallbackActivities
>;
