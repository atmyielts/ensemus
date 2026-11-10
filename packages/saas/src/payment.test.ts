import { describe, expect, it } from 'vitest';
import {
  checkBeforeCharge,
  decideAfterCharge,
  decideAfterLookup,
  MAX_PAYMENT_ATTEMPTS,
  nextCollectionStep,
  type PaymentCheckFacts,
} from './payment';
const facts: PaymentCheckFacts = {
  status: 'ready',
  invoiceStatus: 'open',
  invoiceTotalMicros: 9007199254740993n,
  amountMicros: 9007199254740993n,
  lifecycle: 'active',
  processorConfigured: true,
  customerRef: 'test-customer',
};
describe('payment decisions never retry an uncertain charge', () => {
  it('refuses a closed invoice, amount mismatch, absent processor or customer', () => {
    for (const changed of [
      { invoiceStatus: 'paid' },
      { amountMicros: facts.amountMicros + 1n },
      { processorConfigured: false },
      { customerRef: null },
      { lifecycle: 'deleted' },
    ])
      expect(checkBeforeCharge({ ...facts, ...changed }).ok).toBe(false);
    expect(checkBeforeCharge(facts)).toEqual({ ok: true });
  });
  it.each(['read_only', 'suspended', 'offboarding'])(
    'keeps payment available in %s standing',
    (lifecycle) => expect(checkBeforeCharge({ ...facts, lifecycle })).toEqual({ ok: true }),
  );
  it('success and decline are final while uncertainty always reconciles', () => {
    expect(
      decideAfterCharge({ outcome: 'succeeded', code: 'CHARGED', processorPaymentRef: 'test' }, 1),
    ).toEqual({ status: 'succeeded', code: 'CHARGED' });
    expect(
      decideAfterCharge({ outcome: 'declined', code: 'DECLINED', processorPaymentRef: null }, 1),
    ).toEqual({ status: 'failed', code: 'DECLINED' });
    expect(decideAfterCharge({ outcome: 'indeterminate', code: 'TIMEOUT_AFTER_SEND' }, 1)).toEqual({
      status: 'reconciling',
      code: 'TIMEOUT_AFTER_SEND',
    });
  });
  it('only an explicit retryable not-sent response permits another attempt', () => {
    const result = {
      outcome: 'not_sent' as const,
      code: 'CONNECTION_REFUSED' as const,
      retryable: true,
    };
    expect(decideAfterCharge(result, 1)).toMatchObject({
      status: 'ready',
      code: 'CONNECTION_REFUSED',
    });
    expect(decideAfterCharge(result, MAX_PAYMENT_ATTEMPTS)).toEqual({
      status: 'failed',
      code: 'ATTEMPTS_EXHAUSTED',
    });
    expect(decideAfterCharge({ ...result, retryable: false }, 1)).toEqual({
      status: 'failed',
      code: 'CONNECTION_REFUSED',
    });
  });
  it.each(['none', 'best_effort'] as const)(
    'missing result under %s lookup remains unknown',
    (lookup) =>
      expect(decideAfterLookup({ found: 'not_found' }, lookup)).toEqual({
        status: 'unknown',
        code: 'NOT_FOUND_BY_LOOKUP',
      }),
  );
  it('an authoritative absence can retry, and positive evidence settles', () => {
    expect(decideAfterLookup({ found: 'not_found' }, 'authoritative')).toEqual({
      status: 'ready',
      code: 'NOT_FOUND_BY_LOOKUP',
    });
    expect(decideAfterLookup({ found: 'cannot_answer' }, 'authoritative')).toEqual({
      status: 'unknown',
      code: 'CANNOT_ANSWER',
    });
    expect(
      decideAfterLookup({ found: 'succeeded', processorPaymentRef: 'test' }, 'best_effort'),
    ).toEqual({ status: 'succeeded', code: 'FOUND_BY_LOOKUP' });
    expect(
      decideAfterLookup({ found: 'declined', processorPaymentRef: null }, 'authoritative'),
    ).toEqual({ status: 'failed', code: 'REFUSED_BY_LOOKUP' });
  });
});
describe('collections use only the published order and dates', () => {
  const dueAt = new Date('2034-01-31T16:32:14.123Z');
  it('no policy and exhausted policy perform no action', () => {
    expect(nextCollectionStep([], dueAt, 0, dueAt)).toEqual({ kind: 'done' });
    expect(nextCollectionStep([{ afterDays: 0, action: 'notify' }], dueAt, 1, dueAt)).toEqual({
      kind: 'done',
    });
  });
  it('waits until the exact published UTC date, then advances once', () => {
    const steps = [
      { afterDays: 1, action: 'notify' as const },
      { afterDays: 3, action: 'read_only' as const },
    ];
    expect(nextCollectionStep(steps, dueAt, 0, dueAt)).toEqual({
      kind: 'wait',
      until: new Date('2034-02-01T16:32:14.123Z'),
    });
    expect(nextCollectionStep(steps, dueAt, 0, new Date('2034-02-01T16:32:14.123Z'))).toEqual({
      kind: 'act',
      stepNo: 1,
      action: 'notify',
      next: new Date('2034-02-03T16:32:14.123Z'),
    });
    expect(nextCollectionStep(steps, dueAt, 1, new Date('2034-02-03T16:32:14.123Z'))).toEqual({
      kind: 'act',
      stepNo: 2,
      action: 'read_only',
      next: null,
    });
  });
});
