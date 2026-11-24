import { describe, expect, it, vi } from 'vitest';
import { createBackgroundReconciliation } from './background-reconciliation';

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('dispatcher startup reconciliation', () => {
  it('allows event delivery while repair is pending, with only one repair in flight', async () => {
    const repair = pending<boolean>();
    const run = vi.fn(() => repair.promise);
    const job = createBackgroundReconciliation({ run, retryMs: 60_000, onError: vi.fn() });
    const deliverEvent = vi.fn();

    job.poll();
    await Promise.resolve();
    deliverEvent();
    job.poll();
    job.poll();
    expect(deliverEvent).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();

    repair.resolve(true);
    await job.stop();
  });

  it('retries an incomplete attempt after a delay and stops repairing after success', async () => {
    let time = 0;
    const first = pending<boolean>();
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(true);
    const onError = vi.fn();
    const job = createBackgroundReconciliation({
      run,
      retryMs: 60_000,
      onError,
      now: () => time,
    });
    job.poll();
    await Promise.resolve();
    time = 120_000;
    first.resolve(false);
    // Flush the completion and cleanup callbacks without stopping the recurring job.
    await new Promise<void>((done) => setImmediate(done));
    time = 179_999;
    job.poll();
    expect(run).toHaveBeenCalledOnce();
    time = 180_000;
    job.poll();
    await new Promise<void>((done) => setImmediate(done));
    expect(run).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    time = 300_000;
    job.poll();
    expect(run).toHaveBeenCalledTimes(2);
    await job.stop();
  });

  it('reports failures without rejecting delivery and waits before retrying', async () => {
    let time = 0;
    const failure = new Error('TEMPORAL_UNAVAILABLE');
    const run = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(true);
    const onError = vi.fn();
    const retry = createBackgroundReconciliation({
      run,
      retryMs: 60_000,
      onError,
      now: () => time,
    });
    retry.poll();
    await new Promise<void>((done) => setImmediate(done));
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    time = 59_999;
    retry.poll();
    expect(run).toHaveBeenCalledOnce();
    time = 60_000;
    retry.poll();
    await retry.stop();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('waits for in-flight repair at shutdown and never starts another attempt', async () => {
    const repair = pending<boolean>();
    const run = vi.fn(() => repair.promise);
    const job = createBackgroundReconciliation({ run, retryMs: 0, onError: vi.fn() });
    job.poll();
    let drained = false;
    const stopped = job.stop().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    job.poll();
    expect(run).toHaveBeenCalledOnce();
    repair.resolve(false);
    await stopped;
    expect(drained).toBe(true);
    job.poll();
    expect(run).toHaveBeenCalledOnce();
  });
});
