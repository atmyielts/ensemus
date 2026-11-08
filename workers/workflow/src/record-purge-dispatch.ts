import type { RecordPurgeTarget } from '@ensemus/database/dispatcher';
import {
  knowledgeRecordPurgeInputSchema,
  knowledgeRecordPurgeWorkflowIdFor,
  type KnowledgeRecordPurgeInput,
} from '@ensemus/workflows/knowledge-schemas';

export const RECORD_PURGE_RECONCILE_INTERVAL_MS = 60 * 60_000;
export const RECORD_PURGE_RECONCILE_PAGE_MS = 60_000;

/** Stable identity covers duplicate delivery and a response lost after Temporal accepted the start.
 * PostgreSQL proof remains the authority; a previously completed execution may be checked again. */
export async function startCanonicalRecordPurge(
  target: RecordPurgeTarget,
  ports: {
    start(input: KnowledgeRecordPurgeInput, workflowId: string): Promise<unknown>;
    alreadyRunning(error: unknown): boolean;
  },
): Promise<void> {
  const input = knowledgeRecordPurgeInputSchema.parse({ ...target, limit: 25 });
  try {
    await ports.start(input, knowledgeRecordPurgeWorkflowIdFor(input));
  } catch (error) {
    if (!ports.alreadyRunning(error)) throw error;
  }
}

/** One bounded metadata page per dispatcher turn. A failing/held record cannot starve the rest.
 * Failed starts remain recoverable next cycle; no cursor is ever a deletion/empty-inventory proof. */
export async function reconcileRecordPurges(
  ports: {
    list(
      after: RecordPurgeTarget | null,
    ): Promise<{ targets: RecordPurgeTarget[]; next: RecordPurgeTarget | null }>;
    start(target: RecordPurgeTarget): Promise<void>;
    shouldStop(): boolean;
  },
  after: RecordPurgeTarget | null,
): Promise<{ next: RecordPurgeTarget | null; attempted: number; failed: number }> {
  const page = await ports.list(after);
  let attempted = 0;
  let failed = 0;
  for (const target of page.targets) {
    if (ports.shouldStop()) return { next: after, attempted, failed };
    attempted++;
    try {
      await ports.start(target);
    } catch {
      failed++;
    }
  }
  return { next: page.next, attempted, failed };
}
