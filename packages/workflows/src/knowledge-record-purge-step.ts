import type { DelegatedWorkPurgeCounts } from '@ensemus/application/knowledge/ports';
type Files = { removed: number; remaining: number; held: number; confirmed: boolean };
export type RecordPurgeResult = {
  state: 'completed' | 'unconfirmed';
  work: DelegatedWorkPurgeCounts;
  filesRemoved: number | null;
  filesRemaining: number | null;
  filesHeld: number | null;
};
const complete = (work: DelegatedWorkPurgeCounts) =>
  work.confirmed && work.remaining === 0 && work.controlsRemaining === 0 && work.unproven === 0;

export const RECORD_PURGE_PASSES_PER_HISTORY = 20;
export const recordPurgeRetryDelayMs = (attempt: number) =>
  Math.min(60 * 60_000, 60_000 * 2 ** Math.min(10, Math.max(0, attempt - 1)));

/** A hold, unknown writer or unavailable dependency remains visible debt. Timers retry fresh proof,
 * while a new history bounds replay size. No exception text or private result crosses that boundary. */
export async function retryRecordPurge(ports: {
  pass(): Promise<RecordPurgeResult>;
  delay(milliseconds: number): Promise<void>;
}, retryAttempt = 0): Promise<
  | { state: 'completed'; result: RecordPurgeResult }
  | { state: 'retry'; retryAttempt: number }
> {
  let attempt = retryAttempt;
  for (let pass = 0; pass < RECORD_PURGE_PASSES_PER_HISTORY; pass++) {
    try {
      const result = await ports.pass();
      if (result.state === 'completed') return { state: 'completed', result };
    } catch {
      // Actual Activities persist their own fences/receipts. A lost response cannot certify zero.
    }
    attempt = Math.min(10, attempt + 1);
    await ports.delay(recordPurgeRetryDelayMs(attempt));
  }
  return { state: 'retry', retryAttempt: attempt };
}

/** One bounded durable pass. A later invocation reuses PostgreSQL progress, never a guessed cursor
 * or prior workflow result. The last keyless transaction rechecks Work, hold and actual file proof. */
export async function runRecordPurge(ports: {
  materials(): Promise<DelegatedWorkPurgeCounts>;
  files(): Promise<Files>;
  confirm(): Promise<{ work: DelegatedWorkPurgeCounts; filesRemaining: number | null }>;
}): Promise<RecordPurgeResult> {
  const work = await ports.materials();
  if (!complete(work))
    return {
      state: 'unconfirmed',
      work,
      filesRemoved: null,
      filesRemaining: null,
      filesHeld: null,
    };
  const files = await ports.files();
  const current = await ports.confirm();
  return {
    state:
      complete(current.work) && files.confirmed && files.held === 0 && current.filesRemaining === 0
        ? 'completed'
        : 'unconfirmed',
    work: current.work,
    filesRemoved: files.removed,
    filesRemaining: current.filesRemaining,
    filesHeld: files.held,
  };
}
