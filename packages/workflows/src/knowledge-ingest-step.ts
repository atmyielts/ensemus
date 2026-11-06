import type { ParseStep } from './knowledge-ingest-activities';
import type { EmbedStepResult } from './knowledge-embed-activities';
import type { FetchOutcome } from './knowledge-connector-activities';
import type { KnowledgeIngestResult, KnowledgeSweepResult } from './knowledge-schemas';

/** Pure orchestration shared by the workflows and fault tests. No content or provider call lives here. */
export async function runKnowledgeIngest(ports: {
  parse(): Promise<ParseStep>;
  embed(): Promise<EmbedStepResult>;
  modelWorkerAbsent(error: unknown): boolean;
}): Promise<KnowledgeIngestResult> {
  const parsed = await ports.parse();
  if (parsed.outcome !== 'searchable' && parsed.outcome !== 'already_done')
    return { ...parsed, embedding: 'skipped' };
  try {
    return { ...parsed, embedding: (await ports.embed()).state };
  } catch (error) {
    return {
      ...parsed,
      embedding: ports.modelWorkerAbsent(error) ? 'model_worker_absent' : 'failed',
    };
  }
}

/** A broken resource or unavailable optional connector cannot starve the other resources in a sweep. */
export async function runKnowledgeSweep(ports: {
  close(): Promise<{ closed: number }>;
  list(): Promise<readonly { externalResourceId: string }[]>;
  fetch(externalResourceId: string): Promise<FetchOutcome>;
  mcp(): Promise<readonly { connectionId: string }[]>;
  refresh(connectionId: string): Promise<unknown>;
  pending?(): Promise<readonly { documentId: string }[]>;
  parse?(documentId: string): Promise<ParseStep>;
  documents?(): Promise<readonly { documentId: string }[]>;
  embed?(documentId: string): Promise<EmbedStepResult>;
  modelWorkerAbsent?(error: unknown): boolean;
  purges?(): Promise<readonly { sourceId: string }[]>;
  retryPurge?(sourceId: string): Promise<{ state: 'pending' | 'running' | 'completed' | 'failed' }>;
}): Promise<KnowledgeSweepResult> {
  let closed = 0;
  let failed = 0;
  let fetched = 0;
  try {
    closed = (await ports.close()).closed;
  } catch {
    failed += 1;
  }
  let resources: readonly { externalResourceId: string }[] = [];
  try {
    resources = (await ports.list()).slice(0, 50);
  } catch {
    failed += 1;
  }
  for (const resource of resources) {
    try {
      const result = await ports.fetch(resource.externalResourceId);
      if (result.outcome === 'staged') fetched += 1;
      if (result.outcome === 'failed') failed += 1;
    } catch {
      failed += 1;
    }
  }
  let mcp: readonly { connectionId: string }[] = [];
  try {
    mcp = (await ports.mcp()).slice(0, 50);
  } catch {
    failed += 1;
  }
  for (const server of mcp) {
    try {
      await ports.refresh(server.connectionId);
    } catch {
      failed += 1;
    }
  }
  if (ports.pending && ports.parse)
    try {
      for (const document of (await ports.pending()).slice(0, 50)) {
        try {
          if ((await ports.parse(document.documentId)).outcome === 'failed') failed++;
        } catch {
          failed++;
        }
      }
    } catch {
      failed++;
    }
  if (ports.documents && ports.embed) {
    try {
      const documents = await ports.documents();
      for (const document of documents.slice(0, 50)) {
        try {
          if ((await ports.embed(document.documentId)).state === 'failed') failed++;
        } catch (error) {
          failed++;
          if (ports.modelWorkerAbsent?.(error)) break;
        }
      }
    } catch {
      failed++;
    }
  }
  const purges: NonNullable<KnowledgeSweepResult['purges']>[number][] = [];
  if (ports.purges && ports.retryPurge)
    try {
      for (const job of (await ports.purges()).slice(0, 5)) {
        try {
          const result = await ports.retryPurge(job.sourceId);
          purges.push({ sourceId: job.sourceId, state: result.state });
          if (result.state === 'failed') failed++;
        } catch {
          purges.push({ sourceId: job.sourceId, state: 'failed' });
          failed++;
        }
      }
    } catch {
      failed++;
    }
  return { fetched, closed, failed, ...(ports.purges ? { purges } : {}) };
}
