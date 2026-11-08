import { describe, expect, it, vi } from 'vitest';
import {
  retryRecordPurge,
  recordPurgeRetryDelayMs,
  RECORD_PURGE_PASSES_PER_HISTORY,
  runRecordPurge,
} from './knowledge-record-purge-step';
const proof = { confirmed: true, removed: 2, remaining: 0, controlsRemaining: 0, unproven: 0 };
describe('bounded typed-record material purge', () => {
  it('preserves separate actual Work and file counts after the final proof', async () => {
    const order: string[] = [];
    const result = await runRecordPurge({
      materials: async () => {
        order.push('materials');
        return proof;
      },
      files: async () => {
        order.push('files');
        return { confirmed: true, removed: 3, remaining: 0, held: 0 };
      },
      confirm: async () => {
        order.push('confirm');
        return { work: proof, filesRemaining: 0 };
      },
    });
    expect(order).toEqual(['materials', 'files', 'confirm']);
    expect(result).toEqual({
      state: 'completed',
      work: proof,
      filesRemoved: 3,
      filesRemaining: 0,
      filesHeld: 0,
    });
  });
  it.each([
    { ...proof, confirmed: false },
    { ...proof, remaining: 1 },
    { ...proof, controlsRemaining: 1 },
    { ...proof, unproven: 1 },
  ])(
    'does not turn unknown or pending Work/control proof into empty file success',
    async (work) => {
      const files = vi.fn(),
        confirm = vi.fn();
      expect(await runRecordPurge({ materials: async () => work, files, confirm })).toEqual({
        state: 'unconfirmed',
        work,
        filesRemoved: null,
        filesRemaining: null,
        filesHeld: null,
      });
      expect(files).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    },
  );
  it.each([
    { work: { ...proof, remaining: 1 }, filesRemaining: null },
    { work: { ...proof, controlsRemaining: 1 }, filesRemaining: null },
    { work: { ...proof, unproven: 1 }, filesRemaining: null },
    { work: proof, filesRemaining: 1 },
  ])(
    'rechecks late Work/run/unknown/file debt instead of trusting the earlier zero',
    async (current) => {
      const result = await runRecordPurge({
        materials: async () => proof,
        files: async () => ({ confirmed: true, removed: 3, remaining: 0, held: 0 }),
        confirm: async () => current,
      });
      expect(result.state).toBe('unconfirmed');
      expect(result.work).toEqual(current.work);
      expect(result.filesRemaining).toBe(current.filesRemaining);
    },
  );
  it.each([
    { confirmed: false, removed: 3, remaining: 0, held: 0 },
    { confirmed: true, removed: 3, remaining: 0, held: 1 },
  ])('requires real physical and hold proof even when a count reads zero', async (files) => {
    expect(
      (
        await runRecordPurge({
          materials: async () => proof,
          files: async () => files,
          confirm: async () => ({ work: proof, filesRemaining: 0 }),
        })
      ).state,
    ).toBe('unconfirmed');
  });
  it('does not replay an unknown byte operation or return synthetic success', async () => {
    const files = vi.fn(async () => {
        throw new Error('TEST_UNKNOWN_OBJECT_RESULT');
      }),
      confirm = vi.fn();
    await expect(runRecordPurge({ materials: async () => proof, files, confirm })).rejects.toThrow(
      'TEST_UNKNOWN_OBJECT_RESULT',
    );
    expect(files).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('durable typed-record proof retries', () => {
  const unconfirmed = {
    state: 'unconfirmed' as const,
    work: { ...proof, confirmed: false },
    filesRemoved: null,
    filesRemaining: null,
    filesHeld: null,
  };
  const completed = {
    state: 'completed' as const,
    work: proof,
    filesRemoved: 0,
    filesRemaining: 0,
    filesHeld: 0,
  };
  it('rechecks failed, held and late-writer passes before accepting only a fresh completed proof', async () => {
    const pass = vi
      .fn()
      .mockRejectedValueOnce(new Error('TEST_LOST_ACTIVITY_RESPONSE'))
      .mockResolvedValueOnce(unconfirmed)
      .mockResolvedValueOnce({ ...unconfirmed, filesHeld: 1 })
      .mockResolvedValueOnce(completed);
    const delay = vi.fn(async (_milliseconds: number) => undefined);
    expect(await retryRecordPurge({ pass, delay })).toEqual({
      state: 'completed',
      result: completed,
    });
    expect(pass).toHaveBeenCalledTimes(4);
    expect(delay.mock.calls.map(([value]) => value)).toEqual([60_000, 120_000, 240_000]);
  });
  it('bounds each history and carries the backoff instead of resetting it after continue-as-new', async () => {
    const delay = vi.fn(async (_milliseconds: number) => undefined),
      pass = vi.fn(async () => unconfirmed);
    expect(await retryRecordPurge({ pass, delay }, 10)).toEqual({
      state: 'retry',
      retryAttempt: 10,
    });
    expect(pass).toHaveBeenCalledTimes(RECORD_PURGE_PASSES_PER_HISTORY);
    expect(delay).toHaveBeenCalledTimes(RECORD_PURGE_PASSES_PER_HISTORY);
    expect(delay.mock.calls.every(([value]) => value === 60 * 60_000)).toBe(true);
  });
  it('propagates cancellation/timer failure rather than spinning or manufacturing a final result', async () => {
    const failure = new Error('TEST_WORKFLOW_CANCELLED'),
      pass = vi.fn(async () => unconfirmed);
    await expect(
      retryRecordPurge({
        pass,
        delay: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(pass).toHaveBeenCalledTimes(1);
  });
  it('caps the durable interval at one hour', () => {
    expect(recordPurgeRetryDelayMs(1)).toBe(60_000);
    expect(recordPurgeRetryDelayMs(7)).toBe(60 * 60_000);
    expect(recordPurgeRetryDelayMs(100)).toBe(60 * 60_000);
  });
});
