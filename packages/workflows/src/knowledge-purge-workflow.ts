// Owned by the purge slice (KNOW-05). See docs/06-delivery/m5-slices.md and ADR-029 D3. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import { proxyActivities, sleep } from '@temporalio/workflow';
import type { KnowledgePurgeInput, KnowledgePurgeResult } from './knowledge-schemas';
import type {
  KnowledgePurgeActivities,
  KnowledgeTranscriptActivities,
} from './knowledge-purge-activities';
import { runKnowledgePurge } from './knowledge-purge-step';

/**
 * Every projection-cleanup attempt first durably fences M4 and verifies transcript absence. A missing
 * agent worker leaves a failed job and blocked serving; it cannot certify that no prompt remains.
 */
export async function knowledgePurgeWorkflow(
  input: KnowledgePurgeInput,
): Promise<KnowledgePurgeResult> {
  const transcripts = proxyActivities<KnowledgeTranscriptActivities>({
    taskQueue: 'ensemus-agent',
    startToCloseTimeout: '5 minutes',
    scheduleToStartTimeout: '30 seconds',
    retry: { maximumAttempts: 1 },
  });
  const local = proxyActivities<KnowledgePurgeActivities>({
    taskQueue: 'ensemus-knowledge',
    startToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 1 },
  });
  return runKnowledgePurge({
    transcripts: () => transcripts.purgeRunTranscripts(input),
    purge: () => local.purgeSource(input),
    unconfirmed: (reason) => local.markPurgeFailed({ ...input, reason }),
    delay: (attempt) => sleep((attempt + 1) * 1000),
  });
}
