// App-role control metadata only. SQL permits refusing an actually unclaimed zero-attempt job, never
// modifying a paid job's counters or certifying/deleting its private payload.
import { modelJobs, withTenantTx, type AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { and, eq } from 'drizzle-orm';
import {
  knowledgeModelJobInputSchema,
  type KnowledgeModelJobInput,
} from './knowledge-model-job-schemas';
export function createKnowledgeModelJobFallbackActivities(deps: { database: AppDatabase }) {
  return {
    async refuseUnclaimedModelJob(raw: KnowledgeModelJobInput): Promise<void> {
      const input = knowledgeModelJobInputSchema.parse(raw);
      await withTenantTx(deps.database, createServiceContext(input.organizationId), (tx) =>
        tx
          .update(modelJobs)
          .set({ state: 'refused', refusalCode: 'MODEL_UNAVAILABLE' })
          .where(and(eq(modelJobs.id, input.jobId), eq(modelJobs.state, 'prepared'))),
      );
    },
  };
}
export type KnowledgeModelJobFallbackActivities = ReturnType<
  typeof createKnowledgeModelJobFallbackActivities
>;
