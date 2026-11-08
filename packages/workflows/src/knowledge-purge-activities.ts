// Owned by the purge slice (KNOW-05). See docs/06-delivery/m5-slices.md. `purgeSource` runs in the knowledge
// worker. `purgeRunTranscripts` runs in M4's agent worker, because only its role can reach prompts.
import type { KnowledgeTranscriptDeps, KnowledgeWorkerDeps } from './knowledge-deps';
import type { KnowledgePurgeInput, KnowledgePurgeResult } from './knowledge-schemas';
import {
  knowledgeRecordPurgeInputSchema,
  type KnowledgeRecordPurgeInput,
} from './knowledge-schemas';
import {
  failSourcePurge,
  purgeRunTranscriptsForSource,
  runSourcePurge,
  claimSourcePurgeRetries,
  sourcePurgeWorkerState,
} from '@ensemus/application/knowledge/purge';
import { createServiceContext } from '@ensemus/database/service';
import { withTenantTx } from '@ensemus/database';

export function createKnowledgePurgeActivities(deps: KnowledgeWorkerDeps) {
  return {
    async purgeRecordFiles(raw: KnowledgeRecordPurgeInput) {
      const input = knowledgeRecordPurgeInputSchema.parse(raw);
      if (!deps.derivedArtifacts?.purgeRecord) throw new Error('RECORD_ARTIFACT_PURGE_UNAVAILABLE');
      return deps.derivedArtifacts.purgeRecord(createServiceContext(input.organizationId), input);
    },
    async confirmRecordPurge(raw: KnowledgeRecordPurgeInput) {
      const input = knowledgeRecordPurgeInputSchema.parse(raw);
      if (!deps.recordWorks || !deps.derivedArtifacts?.confirmRecordInTx)
        throw new Error('RECORD_PURGE_CONFIRM_UNAVAILABLE');
      const context = createServiceContext(input.organizationId);
      const records = deps.recordWorks,
        files = deps.derivedArtifacts.confirmRecordInTx;
      return withTenantTx(deps.database, context, async (tx) => {
        const work = await records.confirmRecordInTx(tx, context, input);
        if (!work.confirmed) return { work, filesRemaining: null };
        const fileProof = await files(tx, context, input);
        return { work, filesRemaining: fileProof.remaining };
      });
    },
    async claimSourcePurgeRetries(input: {
      organizationId: string;
    }): Promise<readonly { sourceId: string }[]> {
      return claimSourcePurgeRetries(deps.database, createServiceContext(input.organizationId));
    },
    async readSourcePurgeState(input: KnowledgePurgeInput) {
      return sourcePurgeWorkerState(
        deps.database,
        createServiceContext(input.organizationId),
        input,
      );
    },
    async purgeSource(input: KnowledgePurgeInput): Promise<KnowledgePurgeResult> {
      const result = await runSourcePurge(
        deps.database,
        deps.store,
        createServiceContext(input.organizationId),
        input,
        {
          ...(deps.derivedArtifacts ? { derivedArtifacts: deps.derivedArtifacts } : {}),
          ...(deps.delegatedWorks ? { delegatedWorks: deps.delegatedWorks } : {}),
        },
      );
      return {
        state: result.state === 'completed' ? 'completed' : 'failed',
        chunks: result.chunks,
      };
    },
    async markPurgeFailed(
      input: KnowledgePurgeInput & { reason: 'TRANSCRIPT_PURGE_UNCONFIRMED' | 'PURGE_FAILED' },
    ): Promise<KnowledgePurgeResult> {
      const result = await failSourcePurge(
        deps.database,
        createServiceContext(input.organizationId),
        input,
      );
      return {
        state: result.state === 'completed' ? 'completed' : 'failed',
        chunks: result.chunks,
      };
    },
  };
}
export type KnowledgePurgeActivities = ReturnType<typeof createKnowledgePurgeActivities>;

export function createKnowledgeTranscriptActivities(deps: KnowledgeTranscriptDeps) {
  return {
    async purgeRecordMaterials(raw: KnowledgeRecordPurgeInput) {
      const input = knowledgeRecordPurgeInputSchema.parse(raw);
      if (!deps.delegatedRecords) throw new Error('RECORD_WORK_PURGE_UNAVAILABLE');
      return deps.delegatedRecords.purgeRecord(createServiceContext(input.organizationId), input);
    },
    /** Counts only. No prompt, and no run's content, comes back across Temporal. */
    async purgeRunTranscripts(input: KnowledgePurgeInput): Promise<{ removed: number }> {
      const context = createServiceContext(input.organizationId);
      const result = await purgeRunTranscriptsForSource(deps.database, context, deps, input);
      if (!deps.delegatedWorks) throw new Error('DELEGATED_WORK_PURGE_UNAVAILABLE');
      const work = await deps.delegatedWorks.purgeSource(context, {
        sourceId: input.sourceId,
        limit: 25,
      });
      if (
        !work.confirmed ||
        work.remaining !== 0 ||
        work.controlsRemaining !== 0 ||
        work.unproven !== 0
      )
        throw new Error('DELEGATED_WORK_PURGE_UNCONFIRMED');
      return result;
    },
  };
}
export type KnowledgeTranscriptActivities = ReturnType<typeof createKnowledgeTranscriptActivities>;
