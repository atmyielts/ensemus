import type { KnowledgePurgeResult } from './knowledge-schemas';

/** A running canonical execution keeps authority; a sweep never resets or terminates it. */
export async function restartKnowledgePurge<T>(ports: {
  start(): Promise<T>;
  existing(): Promise<T>;
  alreadyRunning(error: unknown): boolean;
}): Promise<T> {
  try {
    return await ports.start();
  } catch (error) {
    if (ports.alreadyRunning(error)) return ports.existing();
    throw error;
  }
}

/** Each retry proves M4's writer fence again, including a retry after an object-store outage. */
export async function runKnowledgePurge(ports: {
  transcripts(): Promise<unknown>;
  purge(): Promise<KnowledgePurgeResult>;
  unconfirmed(
    reason: 'TRANSCRIPT_PURGE_UNCONFIRMED' | 'PURGE_FAILED',
  ): Promise<KnowledgePurgeResult>;
  delay(attempt: number): Promise<void>;
}): Promise<KnowledgePurgeResult> {
  let last: KnowledgePurgeResult | null = null;
  let failure: 'TRANSCRIPT_PURGE_UNCONFIRMED' | 'PURGE_FAILED' | null =
    'TRANSCRIPT_PURGE_UNCONFIRMED';
  for (let attempt = 0; attempt < 3; attempt++) {
    let proven = false;
    try {
      await ports.transcripts();
      proven = true;
    } catch {
      failure = 'TRANSCRIPT_PURGE_UNCONFIRMED';
    }
    if (proven)
      try {
        last = await ports.purge();
        failure = null;
        if (last.state === 'completed') return last;
      } catch {
        failure = 'PURGE_FAILED';
      }
    if (attempt < 2) await ports.delay(attempt);
  }
  return failure ? ports.unconfirmed(failure) : last!;
}
