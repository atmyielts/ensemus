// Owned by the purge slice (KNOW-05). See docs/06-delivery/m5-slices.md. `purgeSource` runs in the knowledge
// worker. `purgeRunTranscripts` runs in M4's agent worker, because only its role can reach prompts.
import type { KnowledgeTranscriptDeps, KnowledgeWorkerDeps } from './knowledge-deps';
import type { KnowledgePurgeInput, KnowledgePurgeResult } from './knowledge-schemas';
import {
  failSourcePurge,
  purgeRunTranscriptsForSource,
  runSourcePurge,
  claimSourcePurgeRetries,
  sourcePurgeWorkerState,
} from '@ensemus/application/knowledge/purge';
import { createServiceContext } from '@ensemus/database/service';

export function createKnowledgePurgeActivities(deps: KnowledgeWorkerDeps) {
  return {
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
        deps.derivedArtifacts ? { derivedArtifacts: deps.derivedArtifacts } : undefined,
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
    /** Counts only. No prompt, and no run's content, comes back across Temporal. */
    async purgeRunTranscripts(input: KnowledgePurgeInput): Promise<{ removed: number }> {
      return purgeRunTranscriptsForSource(
        deps.database,
        createServiceContext(input.organizationId),
        deps,
        input,
      );
    },
  };
}
export type KnowledgeTranscriptActivities = ReturnType<typeof createKnowledgeTranscriptActivities>;
