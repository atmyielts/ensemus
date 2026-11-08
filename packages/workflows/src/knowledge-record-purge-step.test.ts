import { describe, expect, it, vi } from 'vitest';
import { runRecordPurge } from './knowledge-record-purge-step';
const proof = { confirmed: true,removed: 2,remaining: 0,controlsRemaining: 0,unproven: 0 };
describe('bounded typed-record material purge', () => {
  it('preserves separate actual Work and file counts after the final proof', async () => {
    const order: string[] = [];
    const result = await runRecordPurge({ materials: async () => { order.push('materials');return proof; },
      files: async () => { order.push('files');return { confirmed: true,removed: 3,remaining: 0,held: 0 }; },
      confirm: async () => { order.push('confirm');return { work: proof,filesRemaining: 0 }; } });
    expect(order).toEqual(['materials','files','confirm']);
    expect(result).toEqual({ state: 'completed',work: proof,filesRemoved: 3,filesRemaining: 0,filesHeld: 0 });
  });
  it.each([{ ...proof,confirmed: false },{ ...proof,remaining: 1 },{ ...proof,controlsRemaining: 1 },{ ...proof,unproven: 1 }])(
    'does not turn unknown or pending Work/control proof into empty file success', async work => {
      const files = vi.fn(),confirm = vi.fn();
      expect(await runRecordPurge({ materials: async () => work,files,confirm })).toEqual({
        state: 'unconfirmed',work,filesRemoved: null,filesRemaining: null,filesHeld: null });
      expect(files).not.toHaveBeenCalled();expect(confirm).not.toHaveBeenCalled();
    });
  it.each([{ work: { ...proof,remaining: 1 },filesRemaining: null },{ work: { ...proof,controlsRemaining: 1 },filesRemaining: null },
    { work: { ...proof,unproven: 1 },filesRemaining: null },{ work: proof,filesRemaining: 1 }])(
    'rechecks late Work/run/unknown/file debt instead of trusting the earlier zero', async current => {
      const result = await runRecordPurge({ materials: async () => proof,
        files: async () => ({ confirmed: true,removed: 3,remaining: 0,held: 0 }),confirm: async () => current });
      expect(result.state).toBe('unconfirmed');expect(result.work).toEqual(current.work);
      expect(result.filesRemaining).toBe(current.filesRemaining);
    });
  it.each([{ confirmed: false,removed: 3,remaining: 0,held: 0 },{ confirmed: true,removed: 3,remaining: 0,held: 1 }])(
    'requires real physical and hold proof even when a count reads zero', async files => {
      expect((await runRecordPurge({ materials: async () => proof,files: async () => files,
        confirm: async () => ({ work: proof,filesRemaining: 0 }) })).state).toBe('unconfirmed');
    });
  it('does not replay an unknown byte operation or return synthetic success', async () => {
    const files = vi.fn(async () => { throw new Error('TEST_UNKNOWN_OBJECT_RESULT'); }),confirm = vi.fn();
    await expect(runRecordPurge({ materials: async () => proof,files,confirm })).rejects.toThrow('TEST_UNKNOWN_OBJECT_RESULT');
    expect(files).toHaveBeenCalledTimes(1);expect(confirm).not.toHaveBeenCalled();
  });
});
