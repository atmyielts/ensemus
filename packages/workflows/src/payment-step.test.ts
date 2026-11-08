import { describe, expect, it, vi } from 'vitest';
import { runPayment, type PaymentStepPorts } from './payment-step';

function ports(): PaymentStepPorts {
  return {
    charge: vi.fn().mockResolvedValue({ step: 'succeeded' }),
    inspect: vi.fn().mockResolvedValue('settled'),
    reconcile: vi.fn().mockResolvedValue('unknown'),
    concludeWithoutAnswer: vi.fn().mockResolvedValue('unknown'),
    failUnsent: vi.fn().mockResolvedValue(undefined),
    outcome: vi.fn().mockResolvedValue('failed'),
    sleep: vi.fn().mockResolvedValue(undefined),
    neverPickedUp: () => false,
  };
}
describe('payment recovery ordering', () => {
  it('ends immediately on an unknown outcome', async () => {
    const p = ports();
    vi.mocked(p.charge).mockResolvedValue({ step: 'unknown' });
    expect(await runPayment(p)).toBe('unknown');
    expect(p.inspect).not.toHaveBeenCalled();
    expect(p.reconcile).not.toHaveBeenCalled();
    expect(p.sleep).not.toHaveBeenCalled();
  });
  it('reconciles a lost answer without issuing another charge', async () => {
    const p = ports();
    vi.mocked(p.charge).mockRejectedValue(new Error('worker lost'));
    vi.mocked(p.inspect).mockResolvedValue('attempt_open');
    expect(await runPayment(p)).toBe('unknown');
    expect(p.charge).toHaveBeenCalledTimes(1);
    expect(p.reconcile).toHaveBeenCalledTimes(1);
  });
  it('uses a durable database conclusion when no connector comes back', async () => {
    const p = ports();
    vi.mocked(p.charge).mockResolvedValue({ step: 'reconcile' });
    vi.mocked(p.reconcile).mockRejectedValue(new Error('queue unavailable'));
    expect(await runPayment(p)).toBe('unknown');
    expect(p.concludeWithoutAnswer).toHaveBeenCalledTimes(1);
    expect(p.charge).toHaveBeenCalledTimes(1);
  });
  it('only retries after a recorded not-sent response', async () => {
    const p = ports();
    vi.mocked(p.charge)
      .mockResolvedValueOnce({ step: 'retry', afterMs: 42 })
      .mockResolvedValueOnce({ step: 'succeeded' });
    expect(await runPayment(p)).toBe('succeeded');
    expect(p.sleep).toHaveBeenCalledWith(42);
    expect(p.charge).toHaveBeenCalledTimes(2);
  });
  it('permits a new invocation after authoritative absence', async () => {
    const p = ports();
    vi.mocked(p.charge)
      .mockResolvedValueOnce({ step: 'reconcile' })
      .mockResolvedValueOnce({ step: 'succeeded' });
    vi.mocked(p.reconcile).mockResolvedValue('retry');
    expect(await runPayment(p)).toBe('succeeded');
    expect(p.charge).toHaveBeenCalledTimes(2);
    expect(p.sleep).toHaveBeenCalledTimes(1);
  });
  it('reads a settled receipt after the worker lost its answer', async () => {
    const p = ports();
    vi.mocked(p.charge).mockRejectedValue(new Error('worker lost'));
    vi.mocked(p.outcome).mockResolvedValue('succeeded');
    expect(await runPayment(p)).toBe('succeeded');
    expect(p.charge).toHaveBeenCalledTimes(1);
    expect(p.reconcile).not.toHaveBeenCalled();
  });
  it('fails an unclaimed activity that never reached a worker', async () => {
    const p = ports();
    p.neverPickedUp = () => true;
    vi.mocked(p.charge).mockRejectedValue(new Error('queue timeout'));
    vi.mocked(p.inspect).mockResolvedValueOnce('nothing_sent').mockResolvedValueOnce('settled');
    expect(await runPayment(p)).toBe('failed');
    expect(p.failUnsent).toHaveBeenCalledWith('PROCESSOR_NOT_CONFIGURED');
    expect(p.charge).toHaveBeenCalledTimes(1);
  });
  it('reconciles a late committed claim instead of returning a false failure', async () => {
    const p = ports();
    p.neverPickedUp = () => true;
    vi.mocked(p.charge).mockRejectedValue(new Error('queue timeout'));
    vi.mocked(p.inspect)
      .mockResolvedValueOnce('nothing_sent')
      .mockResolvedValueOnce('attempt_open');
    vi.mocked(p.reconcile).mockResolvedValue('succeeded');
    expect(await runPayment(p)).toBe('succeeded');
    expect(p.outcome).not.toHaveBeenCalled();
    expect(p.charge).toHaveBeenCalledTimes(1);
  });
  it('bounds worker faults that leave no attempt', async () => {
    const p = ports();
    vi.mocked(p.charge).mockRejectedValue(new Error('worker lost'));
    vi.mocked(p.inspect)
      .mockResolvedValue('nothing_sent')
      .mockResolvedValueOnce('nothing_sent')
      .mockResolvedValueOnce('nothing_sent')
      .mockResolvedValueOnce('nothing_sent')
      .mockResolvedValueOnce('nothing_sent')
      .mockResolvedValueOnce('nothing_sent')
      .mockResolvedValueOnce('settled');
    expect(await runPayment(p)).toBe('failed');
    expect(p.charge).toHaveBeenCalledTimes(5);
    expect(p.failUnsent).toHaveBeenCalledWith('ATTEMPTS_EXHAUSTED');
  });
});
