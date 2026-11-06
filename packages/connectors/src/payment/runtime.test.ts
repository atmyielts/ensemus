import { randomUUID } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createFakePaymentProcessor } from '@ensemus/saas/testing';
import type { ChargeRequest, ProcessorCallContext } from '@ensemus/saas/payment';
import { runCharge, runPaymentLookup } from './runtime';
const context: ProcessorCallContext = {
  withCredential: async (use) => use(Buffer.alloc(0)),
  request: async () => {
    throw new Error('TEST_NO_NETWORK');
  },
  signal: new AbortController().signal,
};
const request: ChargeRequest = {
  paymentId: randomUUID(),
  attemptNo: 1,
  idempotencyKey: randomUUID(),
  amountMicros: 9007199254740993n,
  currency: 'XTS',
  minorUnitExponent: 2,
  customerRef: 'test-customer',
};
afterEach(() => vi.useRealTimers());
describe('one payment contact under an explicit effect boundary', () => {
  it('a throw is indeterminate, never an implicit retry', async () => {
    const processor = createFakePaymentProcessor({
      lookup: 'none',
      onCharge: () => {
        throw new Error('TEST_PRIVATE_PROCESSOR_CANARY');
      },
    });
    expect(await runCharge(processor, context, request)).toEqual({
      outcome: 'indeterminate',
      code: 'PROCESSOR_ERROR',
    });
    expect(processor.requests).toHaveLength(1);
    expect(processor.charges).toHaveLength(1);
  });
  it('timeout after a charge returns uncertainty and native idempotency prevents another effect', async () => {
    vi.useFakeTimers();
    const processor = createFakePaymentProcessor({
      lookup: 'none',
      onCharge: () => new Promise(() => undefined),
    });
    const pending = runCharge(processor, context, request, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toEqual({ outcome: 'indeterminate', code: 'TIMEOUT_AFTER_SEND' });
    expect(processor.charges).toHaveLength(1);
  });
  it('explicit not-sent then success has two invocations and one charge', async () => {
    const processor = createFakePaymentProcessor({
      lookup: 'authoritative',
      onCharge: (_request, call) =>
        call === 1
          ? { outcome: 'not_sent', code: 'CONNECTION_REFUSED', retryable: true }
          : { outcome: 'succeeded', code: 'CHARGED', processorPaymentRef: 'test-ref' },
    });
    expect((await runCharge(processor, context, request)).outcome).toBe('not_sent');
    expect((await runCharge(processor, context, { ...request, attemptNo: 2 })).outcome).toBe(
      'succeeded',
    );
    expect(processor.requests).toHaveLength(2);
    expect(processor.charges).toHaveLength(1);
  });
  it('an already aborted call contacts nobody and a processor with no lookup is never asked', async () => {
    const abort = new AbortController();
    abort.abort();
    const onCharge = vi.fn();
    const onLookup = vi.fn();
    const processor = createFakePaymentProcessor({ lookup: 'none', onCharge, onLookup });
    expect(
      (await runCharge(processor, { ...context, signal: abort.signal }, request)).outcome,
    ).toBe('not_sent');
    expect(onCharge).not.toHaveBeenCalled();
    expect(await runPaymentLookup(processor, context, request.idempotencyKey)).toEqual({
      found: 'cannot_answer',
    });
    expect(onLookup).not.toHaveBeenCalled();
  });
});
