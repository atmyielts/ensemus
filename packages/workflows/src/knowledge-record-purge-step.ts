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
