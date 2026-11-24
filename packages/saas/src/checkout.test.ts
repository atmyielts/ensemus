import { randomUUID } from 'node:crypto';
import type { ClickCall, PaddleFact, PaymeCall } from '@ensemus/domain/checkout';
import { describe, expect, it } from 'vitest';
import {
  checkoutDisplay,
  checkoutProvidersFor,
  clickAmountToTiyin,
  clickFallbackReply,
  decideClick,
  decidePaddle,
  decidePaddleLookup,
  decidePayme,
  microsToMinor,
  minorToMicros,
  PAYME_TRANSACTION_TIMEOUT_MS,
  paymeFallbackReply,
  paymeStatementEntry,
  tiyinToClickAmount,
  type CheckoutSessionView,
} from './checkout';

// Generated test amounts in minor units. None is a price.
const AMOUNT = 123_456n;
const NOW = 1_800_000_000_000n;

function session(over: Partial<CheckoutSessionView> = {}): CheckoutSessionView {
  return {
    id: randomUUID(),
    processor: 'payme',
    state: 'open',
    amountMinor: AMOUNT,
    currency: 'UZS',
    providerTxnRef: null,
    clickPrepareId: null,
    providerTimeMs: null,
    createdMs: null,
    performedMs: null,
    cancelledMs: null,
    cancelReason: null,
    invoiceOpen: true,
    ...over,
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a parsed protocol reply, checked field by field
const reply = (text: string) => JSON.parse(text) as Record<string, any>;

describe('which provider a customer may choose', () => {
  it("offers Payme and Click for so'm, and Paddle for the owner's two card currencies", () => {
    const all = ['paddle', 'payme', 'click'] as const;
    expect(checkoutProvidersFor({ currency: 'UZS', minorUnitExponent: 2 }, all)).toEqual([
      'payme',
      'click',
    ]);
    expect(checkoutProvidersFor({ currency: 'USD', minorUnitExponent: 2 }, all)).toEqual([
      'paddle',
    ]);
    expect(checkoutProvidersFor({ currency: 'EUR', minorUnitExponent: 2 }, all)).toEqual([
      'paddle',
    ]);
  });
  it('offers nothing a server has not configured, nor a currency at another exponent', () => {
    expect(checkoutProvidersFor({ currency: 'UZS', minorUnitExponent: 2 }, ['paddle'])).toEqual([]);
    expect(
      checkoutProvidersFor({ currency: 'UZS', minorUnitExponent: 0 }, ['payme', 'click']),
    ).toEqual([]);
    expect(checkoutProvidersFor({ currency: 'GBP', minorUnitExponent: 2 }, ['paddle'])).toEqual([]);
  });
});

describe('amounts', () => {
  it('converts exact micros only', () => {
    expect(microsToMinor(1_234_560_000n, 2)).toBe(123_456n);
    expect(microsToMinor(1_234_561_000n, 2)).toBeNull();
    expect(microsToMinor(0n, 2)).toBeNull();
    expect(microsToMinor(-10_000n, 2)).toBeNull();
    expect(minorToMicros(123_456n, 2)).toBe(1_234_560_000n);
  });
  it("reads Click's so'm exactly and refuses anything looser", () => {
    expect(clickAmountToTiyin('1234.56')).toBe(123_456n);
    expect(clickAmountToTiyin('1234.5')).toBe(123_450n);
    expect(clickAmountToTiyin('1234')).toBe(123_400n);
    for (const bad of ['', '01', '1.234', '-1', '1e3', ' 1', '1,00'])
      expect(clickAmountToTiyin(bad)).toBeNull();
    expect(tiyinToClickAmount(123_405n)).toBe('1234.05');
  });
});

describe('Payme', () => {
  const order = session();
  const check = (amount = AMOUNT.toString(), orderRef: string | null = order.id): PaymeCall => ({
    provider: 'payme',
    rpcId: 7,
    method: 'CheckPerformTransaction',
    amount,
    orderRef,
  });
  const create = (id = 'a'.repeat(24), amount = AMOUNT.toString()): PaymeCall => ({
    provider: 'payme',
    rpcId: 8,
    method: 'CreateTransaction',
    paymeTxnId: id,
    timeMs: (NOW - 5n).toString(),
    amount,
    orderRef: order.id,
  });

  it('allows a payable order and refuses a wrong amount, an unknown order and an unpayable one', () => {
    expect(reply(decidePayme(check(), order, NOW).reply)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { allow: true },
    });
    expect(reply(decidePayme(check('1'), order, NOW).reply).error.code).toBe(-31001);
    const missing = reply(decidePayme(check(), null, NOW).reply).error;
    expect(missing.code).toBe(-31050);
    expect(missing.data).toBe('order_id');
    expect(missing.message).toHaveProperty('en');
    expect(reply(decidePayme(check(), { ...order, state: 'paid' }, NOW).reply).error.code).toBe(
      -31051,
    );
    expect(
      reply(decidePayme(check(), { ...order, invoiceOpen: false }, NOW).reply).error.code,
    ).toBe(-31051);
    expect(
      reply(decidePayme(check(), { ...order, processor: 'click' }, NOW).reply).error.code,
    ).toBe(-31050);
  });

  it('reserves an order for one transaction, answers a repeat the same, and refuses a second', () => {
    const first = decidePayme(create(), order, NOW);
    expect(first.change).toMatchObject({
      to: 'reserved',
      providerTxnRef: 'a'.repeat(24),
      action: 'payme.CreateTransaction',
    });
    expect(reply(first.reply).result).toEqual({
      create_time: Number(NOW),
      transaction: order.id,
      state: 1,
    });
    const reserved = {
      ...order,
      state: 'reserved' as const,
      providerTxnRef: 'a'.repeat(24),
      createdMs: NOW,
    };
    const repeat = decidePayme(create(), reserved, NOW + 1000n);
    expect(repeat.change).toBeNull();
    expect(reply(repeat.reply).result.create_time).toBe(Number(NOW));
    const second = decidePayme(create('b'.repeat(24)), reserved, NOW + 1000n);
    expect(second.change).toBeNull();
    expect(reply(second.reply).error.code).toBe(-31051);
  });

  it('performs once, and a repeat gets the same perform time', () => {
    const reserved = {
      ...order,
      state: 'reserved' as const,
      providerTxnRef: 'a'.repeat(24),
      createdMs: NOW,
    };
    const perform: PaymeCall = {
      provider: 'payme',
      rpcId: 9,
      method: 'PerformTransaction',
      paymeTxnId: 'a'.repeat(24),
    };
    const done = decidePayme(perform, reserved, NOW + 10n);
    expect(done.change).toMatchObject({ to: 'paid', action: 'payme.PerformTransaction' });
    expect(reply(done.reply).result).toEqual({
      transaction: order.id,
      perform_time: Number(NOW + 10n),
      state: 2,
    });
    const paid = { ...reserved, state: 'paid' as const, performedMs: NOW + 10n };
    const again = decidePayme(perform, paid, NOW + 99n);
    expect(again.change).toBeNull();
    expect(reply(again.reply).result.perform_time).toBe(Number(NOW + 10n));
    expect(
      reply(decidePayme({ ...perform, paymeTxnId: 'c'.repeat(24) }, null, NOW).reply).error.code,
    ).toBe(-31003);
  });

  it("cancels a reservation after Payme's timeout with reason 4, and refuses to perform it", () => {
    const reserved = {
      ...order,
      state: 'reserved' as const,
      providerTxnRef: 'a'.repeat(24),
      createdMs: NOW,
    };
    const late = NOW + BigInt(PAYME_TRANSACTION_TIMEOUT_MS) + 1n;
    const perform: PaymeCall = {
      provider: 'payme',
      rpcId: 9,
      method: 'PerformTransaction',
      paymeTxnId: 'a'.repeat(24),
    };
    const decision = decidePayme(perform, reserved, late);
    expect(reply(decision.reply).error.code).toBe(-31008);
    expect(decision.change).toMatchObject({ to: 'cancelled', reason: 4 });
  });

  it('cancels a reservation, records a refund of a paid one, and repeats either answer', () => {
    const reserved = {
      ...order,
      state: 'reserved' as const,
      providerTxnRef: 'a'.repeat(24),
      createdMs: NOW,
    };
    const cancel: PaymeCall = {
      provider: 'payme',
      rpcId: 1,
      method: 'CancelTransaction',
      paymeTxnId: 'a'.repeat(24),
      reason: 3,
    };
    const cancelled = decidePayme(cancel, reserved, NOW + 1n);
    expect(cancelled.change).toMatchObject({ to: 'cancelled', reason: 3 });
    expect(reply(cancelled.reply).result.state).toBe(-1);
    const refunded = decidePayme(
      { ...cancel, reason: 5 },
      { ...reserved, state: 'paid', performedMs: NOW },
      NOW + 2n,
    );
    expect(refunded.change).toMatchObject({ to: 'refunded', reason: 5 });
    expect(reply(refunded.reply).result.state).toBe(-2);
    const repeat = decidePayme(
      cancel,
      { ...reserved, state: 'cancelled', cancelledMs: NOW + 1n },
      NOW + 5n,
    );
    expect(repeat.change).toBeNull();
    expect(reply(repeat.reply).result).toEqual({
      transaction: order.id,
      cancel_time: Number(NOW + 1n),
      state: -1,
    });
    expect(reply(decidePayme({ ...cancel, reason: 99 }, reserved, NOW).reply).error.code).toBe(
      -32600,
    );
  });

  it('reports a transaction, lists it in a statement, and refuses what it does not offer', () => {
    const paid = {
      ...order,
      state: 'paid' as const,
      providerTxnRef: 'a'.repeat(24),
      providerTimeMs: NOW - 5n,
      createdMs: NOW,
      performedMs: NOW + 1n,
    };
    const checked = reply(
      decidePayme(
        { provider: 'payme', rpcId: 'x', method: 'CheckTransaction', paymeTxnId: 'a'.repeat(24) },
        paid,
        NOW,
      ).reply,
    );
    expect(checked).toEqual({
      jsonrpc: '2.0',
      id: 'x',
      result: {
        create_time: Number(NOW),
        perform_time: Number(NOW + 1n),
        cancel_time: 0,
        transaction: order.id,
        state: 2,
        reason: null,
      },
    });
    expect(reply(`{"t":[${paymeStatementEntry(paid)}]}`).t[0]).toMatchObject({
      id: 'a'.repeat(24),
      time: Number(NOW - 5n),
      amount: Number(AMOUNT),
      account: { order_id: order.id },
      state: 2,
    });
    expect(
      reply(decidePayme({ provider: 'payme', rpcId: 2, method: 'unsupported' }, null, NOW).reply)
        .error.code,
    ).toBe(-32601);
  });

  it('answers by itself only with codes that reveal nothing about any order', () => {
    expect(reply(paymeFallbackReply('unauthorized')).error.code).toBe(-32504);
    expect(reply(paymeFallbackReply('parse')).error.code).toBe(-32700);
    expect(reply(paymeFallbackReply('not_post')).error.code).toBe(-32300);
    expect(reply(paymeFallbackReply('unavailable', 4)).error.code).toBe(-32400);
  });
});

describe('Click', () => {
  const order = session({ processor: 'click', clickPrepareId: 41n });
  const call = (over: Partial<ClickCall> = {}): ClickCall => ({
    provider: 'click',
    action: 0,
    clickTransId: '9001',
    clickPaydocId: '7001',
    serviceId: '55',
    orderRef: order.id,
    merchantPrepareId: null,
    amount: '1234.56',
    error: 0,
    ...over,
  });

  it('prepares, completes and repeats a complete with the same answer', () => {
    const prepared = decideClick(call(), order, NOW);
    expect(prepared.change).toMatchObject({ to: 'reserved', providerTxnRef: '9001' });
    expect(reply(prepared.reply)).toEqual({
      click_trans_id: 9001,
      merchant_trans_id: order.id,
      merchant_prepare_id: 41,
      error: 0,
      error_note: 'Success',
    });
    const reserved = { ...order, state: 'reserved' as const, providerTxnRef: '9001' };
    const complete = call({ action: 1, merchantPrepareId: '41' });
    const done = decideClick(complete, reserved, NOW);
    expect(done.change).toMatchObject({ to: 'paid', action: 'click.complete' });
    expect(reply(done.reply).merchant_confirm_id).toBe(41);
    const again = decideClick(complete, { ...reserved, state: 'paid' }, NOW);
    expect(again.change).toBeNull();
    expect(reply(again.reply).error).toBe(0);
  });

  it('refuses a wrong amount, an unknown order, a wrong prepare id and an unknown action', () => {
    expect(reply(decideClick(call({ amount: '1234.57' }), order, NOW).reply).error).toBe(-2);
    expect(reply(decideClick(call(), null, NOW).reply).error).toBe(-5);
    const reserved = { ...order, state: 'reserved' as const, providerTxnRef: '9001' };
    expect(
      reply(decideClick(call({ action: 1, merchantPrepareId: '40' }), reserved, NOW).reply).error,
    ).toBe(-6);
    expect(reply(decideClick(call({ action: 2 }), order, NOW).reply).error).toBe(-3);
    expect(
      reply(decideClick(call({ clickTransId: '9002' }), { ...reserved, state: 'paid' }, NOW).reply)
        .error,
    ).toBe(-4);
  });

  it("cancels when Click reports the customer's payment failed", () => {
    const reserved = { ...order, state: 'reserved' as const, providerTxnRef: '9001' };
    const failed = decideClick(
      call({ action: 1, merchantPrepareId: '41', error: -5017 }),
      reserved,
      NOW,
    );
    expect(failed.change).toMatchObject({ to: 'cancelled' });
    expect(reply(failed.reply).error).toBe(-9);
    expect(reply(clickFallbackReply('unauthorized')).error).toBe(-1);
  });
});

describe('Paddle', () => {
  const order = session({ processor: 'paddle', currency: 'USD', providerTxnRef: 'txn_01abc' });
  const fact = (over: Partial<PaddleFact> = {}): PaddleFact => ({
    provider: 'paddle',
    eventId: 'evt_01',
    kind: 'paid',
    transactionId: 'txn_01abc',
    orderRef: order.id,
    currency: 'USD',
    grandTotalMinor: AMOUNT.toString(),
    taxMinor: '456',
    subtotalMinor: (AMOUNT - 456n).toString(),
    occurredAtSeconds: 1,
    ...over,
  });

  it("settles only the exact transaction, amount and currency, with Paddle's tax", () => {
    expect(decidePaddle(fact(), order, NOW)).toEqual({
      outcome: 'apply',
      change: { action: 'paddle.paid', to: 'paid', atMs: NOW, taxMinor: 456n },
    });
    expect(decidePaddle(fact({ grandTotalMinor: '1' }), order, NOW).outcome).toBe('mismatch');
    expect(decidePaddle(fact({ currency: 'EUR' }), order, NOW).outcome).toBe('mismatch');
    expect(decidePaddle(fact({ transactionId: 'txn_other' }), order, NOW).outcome).toBe('mismatch');
    expect(decidePaddle(fact({ orderRef: randomUUID() }), order, NOW).outcome).toBe('mismatch');
    expect(decidePaddle(fact(), { ...order, state: 'paid' }, NOW).outcome).toBe('nothing');
    expect(decidePaddle(fact(), { ...order, state: 'cancelled' }, NOW).outcome).toBe(
      'paid_after_close',
    );
  });

  it('closes on cancel, records a refund, and reconciles by lookup the same way', () => {
    expect(decidePaddle(fact({ kind: 'cancelled' }), order, NOW).outcome).toBe('apply');
    expect(
      decidePaddle(fact({ kind: 'refunded' }), { ...order, state: 'paid' }, NOW),
    ).toMatchObject({
      change: { to: 'refunded' },
    });
    expect(
      decidePaddleLookup(
        {
          status: 'paid',
          transactionId: 'txn_01abc',
          currency: 'USD',
          grandTotalMinor: AMOUNT.toString(),
          taxMinor: '0',
        },
        order,
        NOW,
      ),
    ).toMatchObject({ outcome: 'apply', change: { action: 'paddle.lookup_paid' } });
    expect(
      decidePaddleLookup({ status: 'open', transactionId: 'txn_01abc' }, order, NOW).outcome,
    ).toBe('nothing');
  });
});

it('tells the customer what is happening, honestly', () => {
  expect(checkoutDisplay('reserved')).toBe('processing');
  expect(checkoutDisplay('cancelled')).toBe('not_paid');
});
