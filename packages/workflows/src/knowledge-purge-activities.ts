// Owned by the purge slice (KNOW-05). See docs/06-delivery/m5-slices.md. `purgeSource` runs in the knowledge
// worker. `purgeRunTranscripts` runs in M4's agent worker, because only its role can reach prompts.
import type { KnowledgeTranscriptDeps, KnowledgeWorkerDeps } from './knowledge-deps';
import type { KnowledgePurgeInput, KnowledgePurgeResult } from './knowledge-schemas';
import {
  knowledgeRecordPurgeInputSchema,
  RECORD_PURGE_PAGE_LIMIT,
  type KnowledgeRecordPurgeInput,
} from './knowledge-schemas';
import type { RecordPurgeResult } from './knowledge-record-purge-step';
import {
  failSourcePurge,
  purgeRunTranscriptsForSource,
  runSourcePurge,
  claimSourcePurgeRetries,
  sourcePurgeWorkerState,
} from '@ensemus/application/knowledge/purge';
import { listRecordPurgeCandidates } from '@ensemus/application/knowledge/record-closure';
import { AppError, pgCode } from '@ensemus/application';
import { createServiceContext } from '@ensemus/database/service';
import { withTenantTx } from '@ensemus/database';

/** A sweep restarts at most this many typed-record purges per tick, like source purges. */
const RECORD_PURGE_RESTARTS = 5;

export function createKnowledgePurgeActivities(deps: KnowledgeWorkerDeps) {
  /** The canonical record purge proof: copied Work and control first, then generated files. */
  const confirmRecord = async (input: KnowledgeRecordPurgeInput) => {
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
  };
  const proven = (current: Awaited<ReturnType<typeof confirmRecord>>) =>
    current.work.confirmed &&
    current.work.remaining === 0 &&
    current.work.controlsRemaining === 0 &&
    current.work.unproven === 0 &&
    current.filesRemaining === 0;
  return {
    async purgeRecordFiles(raw: KnowledgeRecordPurgeInput) {
      const input = knowledgeRecordPurgeInputSchema.parse(raw);
      if (!deps.derivedArtifacts?.purgeRecord) throw new Error('RECORD_ARTIFACT_PURGE_UNAVAILABLE');
      return deps.derivedArtifacts.purgeRecord(createServiceContext(input.organizationId), input);
    },
    async confirmRecordPurge(raw: KnowledgeRecordPurgeInput) {
      return confirmRecord(knowledgeRecordPurgeInputSchema.parse(raw));
    },
    /**
     * The typed-record restart path (ADR-028 lifecycle item 8a). Dead or tombstoned records are ranked
     * by metadata, then each is re-proved, one transaction each, with the same composite proof
     * confirmRecordPurge uses. Only a record PostgreSQL does not prove purged is due. Nothing is stored:
     * the next sweep simply proves again, so no retry counter can run out and no Temporal result is reused.
     */
    async claimRecordPurgeRestarts(input: {
      organizationId: string;
    }): Promise<readonly KnowledgeRecordPurgeInput[]> {
      const context = createServiceContext(input.organizationId);
      const candidates = await listRecordPurgeCandidates(deps.database, context, {
        limit: RECORD_PURGE_PAGE_LIMIT,
      });
      const due: KnowledgeRecordPurgeInput[] = [];
      for (const candidate of candidates) {
        if (due.length >= RECORD_PURGE_RESTARTS) break;
        const record = knowledgeRecordPurgeInputSchema.parse({
          organizationId: context.organizationId,
          kind: candidate.kind,
          id: candidate.id,
          limit: RECORD_PURGE_PAGE_LIMIT,
        });
        try {
          if (!proven(await confirmRecord(record))) due.push(record);
        } catch (error) {
          // No proof yet (no snapshot, a changed record) or a busy lock: the purge itself decides.
          if (
            (error instanceof AppError &&
              (error.code === 'INVALID_STATE' || error.code === 'VERSION_CONFLICT')) ||
            pgCode(error) === '55P03'
          )
            due.push(record);
          else throw error;
        }
      }
      return due;
    },
    /** The current proof for one record, for a restart that found its workflow already running. */
    async readRecordPurgeState(raw: KnowledgeRecordPurgeInput): Promise<RecordPurgeResult> {
      const current = await confirmRecord(knowledgeRecordPurgeInputSchema.parse(raw));
      return {
        state: proven(current) ? 'completed' : 'unconfirmed',
        work: current.work,
        filesRemoved: null,
        filesRemaining: current.filesRemaining,
        filesHeld: null,
      };
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
