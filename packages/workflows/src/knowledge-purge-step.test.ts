import { describe, expect, it } from 'vitest';
import { restartKnowledgePurge, runKnowledgePurge } from './knowledge-purge-step';
describe('knowledge purge sequencing', () => {
  it('reads an already-running canonical workflow without replacing it, while propagating other failures', async () => {
    const duplicate = new Error('Generated duplicate');
    let reads = 0;
    expect(
      await restartKnowledgePurge({
        start: async () => {
          throw duplicate;
        },
        existing: async () => {
          reads++;
          return { state: 'running' };
        },
        alreadyRunning: (error) => error === duplicate,
      }),
    ).toEqual({ state: 'running' });
    expect(reads).toBe(1);
    const failed = new Error('Generated failed start');
    await expect(
      restartKnowledgePurge({
        start: async () => {
          throw failed;
        },
        existing: async () => {
          throw new Error('MUST_NOT_CALL');
        },
        alreadyRunning: () => false,
      }),
    ).rejects.toBe(failed);
  });
  it('never cleans projections or certifies completion without the transcript worker', async () => {
    const calls: string[] = [];
    const result = await runKnowledgePurge({
      transcripts: async () => {
        calls.push('fence');
        throw new Error('ABSENT');
      },
      purge: async () => {
        throw new Error('MUST_NOT_CALL');
      },
      unconfirmed: async () => ({ state: 'failed', chunks: 0 }),
      delay: async () => {},
    });
    expect(result.state).toBe('failed');
    expect(calls).toEqual(['fence', 'fence', 'fence']);
  });
  it('re-fences before retrying a failed projection cleanup', async () => {
    const calls: string[] = [];
    let attempt = 0;
    const result = await runKnowledgePurge({
      transcripts: async () => {
        calls.push('fence');
      },
      purge: async () => {
        calls.push('purge');
        return { state: ++attempt === 1 ? 'failed' : 'completed', chunks: 7 };
      },
      unconfirmed: async () => ({ state: 'failed', chunks: 0 }),
      delay: async () => {
        calls.push('backoff');
      },
    });
    expect(result).toEqual({ state: 'completed', chunks: 7 });
    expect(calls).toEqual(['fence', 'purge', 'backoff', 'fence', 'purge']);
  });
});
