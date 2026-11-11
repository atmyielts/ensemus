// Hosted checkout rules (ADR-032 D4a, owner decision 2026-11-11): Payme and Click for customers paying in
// so'm, Paddle as merchant of record for cards abroad. Pure: what each provider's call means for our one
// checkout row, and the exact protocol answer. No price, fee, rate or time limit of ours is here. The only
// number below that is not a currency rule is Payme's own 12-hour transaction timeout, from its protocol.
import type {
  CheckoutProvider,
  CheckoutState,
  ClickCall,
  JsonRpcId,
  PaddleFact,
  PaymeCall,
} from '@ensemus/domain/checkout';
import type { Micros } from './money';

export type { CheckoutProvider, CheckoutState };

/**
 * Which currencies each provider is used for, and their minor unit. UZS is in tiyin for Payme and in so'm
 * with two decimals for Click, and both are hundredths. Paddle is limited to the two currencies the owner
 * named; any other needs a reviewed change, since Paddle's minor unit differs by currency.
 */
export const CHECKOUT_CURRENCIES: Readonly<
  Record<CheckoutProvider, Readonly<Record<string, number>>>
> = {
  paddle: { USD: 2, EUR: 2 },
  payme: { UZS: 2 },
  click: { UZS: 2 },
};

/** Payme's protocol: a created transaction not performed within 12 hours is cancelled with reason 4. */
export const PAYME_TRANSACTION_TIMEOUT_MS = 43_200_000;
export const PAYME_CANCEL_REASONS = [1, 2, 3, 4, 5, 10] as const;
const PAYME_TIMEOUT_REASON = 4;

/**
 * The providers a customer may choose for an invoice: those configured on this server that take its
 * currency at its exponent. The currency decides it, because Payme and Click take so'm only and Paddle
 * takes no so'm; the billing country is shown to the customer and goes to Paddle for tax.
 */
export function checkoutProvidersFor(
  invoice: { currency: string; minorUnitExponent: number },
  configured: readonly CheckoutProvider[],
): CheckoutProvider[] {
  return (['payme', 'click', 'paddle'] as const).filter(
    (provider) =>
      configured.includes(provider) &&
      CHECKOUT_CURRENCIES[provider][invoice.currency] === invoice.minorUnitExponent,
  );
}

const MICROS_PER_UNIT = 1_000_000n;

/** Micros to the provider's minor unit. Null for anything that is not an exact, positive whole amount. */
export function microsToMinor(amount: Micros, minorUnitExponent: number): bigint | null {
  if (
    typeof amount !== 'bigint' ||
    !Number.isInteger(minorUnitExponent) ||
    minorUnitExponent < 0 ||
    minorUnitExponent > 6 ||
    amount <= 0n
  )
    return null;
  const unit = MICROS_PER_UNIT / 10n ** BigInt(minorUnitExponent);
  if (amount % unit !== 0n) return null;
  const minor = amount / unit;
  return minor <= 9_007_199_254_740_991n ? minor : null;
}

export function minorToMicros(minor: bigint, minorUnitExponent: number): Micros {
  if (!Number.isInteger(minorUnitExponent) || minorUnitExponent < 0 || minorUnitExponent > 6)
    throw new RangeError('INVALID_MINOR_UNIT');
  return minor * (MICROS_PER_UNIT / 10n ** BigInt(minorUnitExponent));
}

const DIGITS = /^(0|[1-9][0-9]{0,17})$/;
/** A whole number sent as digits. Null for anything else, including a sign, a space or a leading zero. */
export function parseMinor(value: unknown): bigint | null {
  return typeof value === 'string' && DIGITS.test(value) ? BigInt(value) : null;
}

/**
 * Click sends so'm with up to two decimals ("1000", "1000.5", "1000.50"). Tiyin, or null for anything
 * else. The signature covers the exact text, so this is only ever used after it has been checked.
 */
export function clickAmountToTiyin(value: string): bigint | null {
  const match = /^(0|[1-9][0-9]{0,15})(?:\.([0-9]{1,2}))?$/.exec(value);
  if (!match) return null;
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}
/** Tiyin as Click's payment page takes it: so'm with two decimals. */
export const tiyinToClickAmount = (tiyin: bigint) =>
  `${tiyin / 100n}.${(tiyin % 100n).toString().padStart(2, '0')}`;

/** What the rules read of one checkout row. Times are the provider protocol's milliseconds. */
export type CheckoutSessionView = {
  id: string;
  processor: CheckoutProvider;
  state: CheckoutState;
  amountMinor: bigint;
  currency: string;
  /** Payme transaction id, Click click_trans_id, Paddle transaction id. */
  providerTxnRef: string | null;
  /** Click's integer reference for Prepare and Complete, fixed when the row is made. */
  clickPrepareId: bigint | null;
  providerTimeMs: bigint | null;
  createdMs: bigint | null;
  performedMs: bigint | null;
  cancelledMs: bigint | null;
  cancelReason: number | null;
  /** Whether the invoice can still be paid. A voided invoice is refused before any money moves. */
  invoiceOpen: boolean;
};

/**
 * What a call does to the row, if anything. `action` names the call in the SQL allowlist, which checks
 * the same move again under the attestation the connector worker obtained for this exact call.
 */
export type CheckoutChange =
  | {
      action: string;
      to: 'reserved';
      providerTxnRef: string;
      providerTimeMs: bigint | null;
      atMs: bigint;
    }
  | { action: string; to: 'paid'; atMs: bigint; taxMinor?: bigint }
  | { action: string; to: 'cancelled'; atMs: bigint; reason: number | null }
  | { action: string; to: 'refunded'; atMs: bigint; reason: number | null };

// --- Payme Merchant API (JSON-RPC 2.0 over HTTPS, Basic auth).

export const PAYME_ERRORS = {
  /** Bad credentials. Answered for any unauthenticated call, whatever it asked. */
  insufficientPrivilege: -32504,
  notPost: -32300,
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  system: -32400,
  invalidAmount: -31001,
  transactionNotFound: -31003,
  cannotCancel: -31007,
  cannotPerform: -31008,
  /** Our account range starts here: -31050 to -31099. */
  orderNotFound: -31050,
  orderNotPayable: -31051,
} as const;

const PAYME_MESSAGES: Record<number, { ru: string; uz: string; en: string }> = {
  [-32504]: {
    ru: 'Недостаточно привилегий для выполнения метода',
    uz: 'Usulni bajarish uchun huquq yetarli emas',
    en: 'Insufficient privileges to perform this method',
  },
  [-32300]: {
    ru: 'Метод запроса не POST',
    uz: "So'rov usuli POST emas",
    en: 'Request method is not POST',
  },
  [-32700]: { ru: 'Ошибка разбора JSON', uz: 'JSON tahlil xatosi', en: 'JSON parse error' },
  [-32600]: {
    ru: 'Неверный запрос JSON-RPC',
    uz: "Noto'g'ri JSON-RPC so'rovi",
    en: 'Invalid JSON-RPC request',
  },
  [-32601]: { ru: 'Метод не найден', uz: 'Usul topilmadi', en: 'Method not found' },
  [-32400]: { ru: 'Системная ошибка', uz: 'Tizim xatosi', en: 'System error' },
  [-31001]: { ru: 'Неверная сумма', uz: "Noto'g'ri summa", en: 'Incorrect amount' },
  [-31003]: {
    ru: 'Транзакция не найдена',
    uz: 'Tranzaksiya topilmadi',
    en: 'Transaction not found',
  },
  [-31007]: {
    ru: 'Невозможно отменить транзакцию',
    uz: 'Tranzaksiyani bekor qilib bo‘lmaydi',
    en: 'Unable to cancel the transaction',
  },
  [-31008]: {
    ru: 'Невозможно выполнить операцию',
    uz: 'Amalni bajarib bo‘lmaydi',
    en: 'Unable to perform the operation',
  },
  [-31050]: { ru: 'Заказ не найден', uz: 'Buyurtma topilmadi', en: 'Order not found' },
  [-31051]: {
    ru: 'Заказ нельзя оплатить',
    uz: "Buyurtmani to'lab bo'lmaydi",
    en: 'The order cannot be paid',
  },
};

/** The field our Payme account carries. Set in the merchant cabinet to match (see the runbook). */
export const PAYME_ACCOUNT_FIELD = 'order_id';

/** Echoed exactly as sent, when it is a short string or a safe integer, and null otherwise. */
export function boundedRpcId(value: unknown): JsonRpcId {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^[\x20-\x7e]{0,64}$/.test(value)) return value;
  return null;
}

export function paymeErrorReply(rpcId: JsonRpcId, code: number, data?: string): string {
  const message = PAYME_MESSAGES[code] ?? PAYME_MESSAGES[PAYME_ERRORS.system]!;
  return JSON.stringify({
    jsonrpc: '2.0',
    id: boundedRpcId(rpcId),
    error: { code, message, ...(data ? { data } : {}) },
  });
}

/** A result's numbers are protocol integers, written as JSON numbers from their exact digits. */
function paymeResultReply(
  rpcId: JsonRpcId,
  result: Record<string, bigint | number | string | boolean | null>,
) {
  const fields = Object.entries(result).map(
    ([key, value]) =>
      `${JSON.stringify(key)}:${typeof value === 'bigint' ? value.toString() : JSON.stringify(value)}`,
  );
  return `{"jsonrpc":"2.0","id":${JSON.stringify(boundedRpcId(rpcId))},"result":{${fields.join(',')}}}`;
}

/** Payme's states for one transaction, from ours. An order never reserved has no Payme transaction. */
export function paymeState(session: CheckoutSessionView): 1 | 2 | -1 | -2 | null {
  if (session.processor !== 'payme' || !session.providerTxnRef) return null;
  switch (session.state) {
    case 'reserved':
      return 1;
    case 'paid':
      return 2;
    case 'cancelled':
      return -1;
    case 'refunded':
      return -2;
    default:
      return null;
  }
}

export type PaymeDecision = { reply: string; change: CheckoutChange | null };

const err = (call: PaymeCall, code: number, data?: string): PaymeDecision => ({
  reply: paymeErrorReply(call.rpcId, code, data),
  change: null,
});

function paymeOrderCheck(
  call: PaymeCall & { amount: string },
  session: CheckoutSessionView | null,
): PaymeDecision | null {
  if (!session || session.processor !== 'payme')
    return err(call, PAYME_ERRORS.orderNotFound, PAYME_ACCOUNT_FIELD);
  const amount = parseMinor(call.amount);
  if (amount === null || amount !== session.amountMinor)
    return err(call, PAYME_ERRORS.invalidAmount);
  return null;
}

/**
 * One Payme call against the one row it names. `session` is the row found by the order (for a check or a
 * create) or by Payme's transaction id (for the rest), or null when nothing matches. Payme repeats calls,
 * and a repeat gets the same answer, so every branch is idempotent by the transaction id.
 */
export function decidePayme(
  call: PaymeCall,
  session: CheckoutSessionView | null,
  nowMs: bigint,
): PaymeDecision {
  switch (call.method) {
    case 'invalid':
      return err(call, PAYME_ERRORS.invalidRequest);
    case 'unsupported':
      return err(call, PAYME_ERRORS.methodNotFound);
    case 'GetStatement':
      // Answered from a cross-organization listing the caller builds; never from one row.
      return err(call, PAYME_ERRORS.system);
    case 'CheckPerformTransaction': {
      const refused = paymeOrderCheck(call, session);
      if (refused) return refused;
      if (session!.state !== 'open' || !session!.invoiceOpen)
        return err(call, PAYME_ERRORS.orderNotPayable, PAYME_ACCOUNT_FIELD);
      return { reply: paymeResultReply(call.rpcId, { allow: true }), change: null };
    }
    case 'CreateTransaction': {
      if (session && session.processor === 'payme' && session.providerTxnRef === call.paymeTxnId) {
        if (session.state !== 'reserved') return err(call, PAYME_ERRORS.cannotPerform);
        if (timedOut(session, nowMs))
          return paymeTimeout(call, session, nowMs, 'payme.CreateTransaction');
        return {
          reply: paymeResultReply(call.rpcId, {
            create_time: session.createdMs!,
            transaction: session.id,
            state: 1,
          }),
          change: null,
        };
      }
      const refused = paymeOrderCheck(call, session);
      if (refused) return refused;
      // Another Payme transaction holds this order, or it can no longer be paid.
      if (session!.state !== 'open' || !session!.invoiceOpen)
        return err(call, PAYME_ERRORS.orderNotPayable, PAYME_ACCOUNT_FIELD);
      const time = parseMinor(call.timeMs);
      if (time === null) return err(call, PAYME_ERRORS.invalidRequest);
      return {
        reply: paymeResultReply(call.rpcId, {
          create_time: nowMs,
          transaction: session!.id,
          state: 1,
        }),
        change: {
          action: 'payme.CreateTransaction',
          to: 'reserved',
          providerTxnRef: call.paymeTxnId,
          providerTimeMs: time,
          atMs: nowMs,
        },
      };
    }
    case 'PerformTransaction': {
      if (!session || session.processor !== 'payme' || session.providerTxnRef !== call.paymeTxnId)
        return err(call, PAYME_ERRORS.transactionNotFound);
      if (session.state === 'paid')
        return {
          reply: paymeResultReply(call.rpcId, {
            transaction: session.id,
            perform_time: session.performedMs!,
            state: 2,
          }),
          change: null,
        };
      if (session.state !== 'reserved') return err(call, PAYME_ERRORS.cannotPerform);
      if (timedOut(session, nowMs))
        return paymeTimeout(call, session, nowMs, 'payme.PerformTransaction');
      if (!session.invoiceOpen) return err(call, PAYME_ERRORS.cannotPerform);
      return {
        reply: paymeResultReply(call.rpcId, {
          transaction: session.id,
          perform_time: nowMs,
          state: 2,
        }),
        change: { action: 'payme.PerformTransaction', to: 'paid', atMs: nowMs },
      };
    }
    case 'CancelTransaction': {
      if (!session || session.processor !== 'payme' || session.providerTxnRef !== call.paymeTxnId)
        return err(call, PAYME_ERRORS.transactionNotFound);
      if (!(PAYME_CANCEL_REASONS as readonly number[]).includes(call.reason))
        return err(call, PAYME_ERRORS.invalidRequest);
      if (session.state === 'cancelled' || session.state === 'refunded')
        return {
          reply: paymeResultReply(call.rpcId, {
            transaction: session.id,
            cancel_time: session.cancelledMs!,
            state: session.state === 'cancelled' ? -1 : -2,
          }),
          change: null,
        };
      // A refund of a performed payment is Payme's to make from its own cabinet. It is recorded and shown
      // to a person here, and takes no access away by itself (ADR-032 D4).
      const to =
        session.state === 'paid' ? 'refunded' : session.state === 'reserved' ? 'cancelled' : null;
      if (!to) return err(call, PAYME_ERRORS.cannotCancel);
      return {
        reply: paymeResultReply(call.rpcId, {
          transaction: session.id,
          cancel_time: nowMs,
          state: to === 'cancelled' ? -1 : -2,
        }),
        change: { action: 'payme.CancelTransaction', to, atMs: nowMs, reason: call.reason },
      };
    }
    case 'CheckTransaction': {
      if (!session || session.processor !== 'payme' || session.providerTxnRef !== call.paymeTxnId)
        return err(call, PAYME_ERRORS.transactionNotFound);
      const state = paymeState(session);
      if (state === null) return err(call, PAYME_ERRORS.transactionNotFound);
      return {
        reply: paymeResultReply(call.rpcId, paymeTransactionFields(session, state)),
        change: null,
      };
    }
  }
}

const timedOut = (session: CheckoutSessionView, nowMs: bigint) =>
  session.createdMs !== null && nowMs - session.createdMs > BigInt(PAYME_TRANSACTION_TIMEOUT_MS);

function paymeTimeout(
  call: PaymeCall,
  session: CheckoutSessionView,
  nowMs: bigint,
  action: string,
): PaymeDecision {
  void session;
  return {
    reply: paymeErrorReply(call.rpcId, PAYME_ERRORS.cannotPerform),
    change: { action, to: 'cancelled', atMs: nowMs, reason: PAYME_TIMEOUT_REASON },
  };
}

function paymeTransactionFields(session: CheckoutSessionView, state: number) {
  return {
    create_time: session.createdMs ?? 0n,
    perform_time: session.performedMs ?? 0n,
    cancel_time: session.cancelledMs ?? 0n,
    transaction: session.id,
    state,
    reason: session.cancelReason,
  };
}

/** One row of a GetStatement answer, from a row the cross-organization listing returned. */
export function paymeStatementEntry(session: CheckoutSessionView): string | null {
  const state = paymeState(session);
  if (state === null || session.providerTimeMs === null) return null;
  const fields = paymeTransactionFields(session, state);
  return (
    `{"id":${JSON.stringify(session.providerTxnRef)},"time":${session.providerTimeMs},` +
    `"amount":${session.amountMinor},"account":{${JSON.stringify(PAYME_ACCOUNT_FIELD)}:${JSON.stringify(session.id)}},` +
    `"create_time":${fields.create_time},"perform_time":${fields.perform_time},` +
    `"cancel_time":${fields.cancel_time},"transaction":${JSON.stringify(session.id)},` +
    `"state":${state},"reason":${JSON.stringify(session.cancelReason)},"receivers":null}`
  );
}

export function paymeStatementReply(rpcId: JsonRpcId, entries: readonly string[]): string {
  return `{"jsonrpc":"2.0","id":${JSON.stringify(boundedRpcId(rpcId))},"result":{"transactions":[${entries.join(',')}]}}`;
}

// --- Click SHOP API (Prepare action 0, Complete action 1, form-encoded, answered with JSON).

export const CLICK_ERRORS = {
  success: 0,
  signFailed: -1,
  incorrectAmount: -2,
  actionNotFound: -3,
  alreadyPaid: -4,
  orderNotFound: -5,
  transactionNotFound: -6,
  updateFailed: -7,
  badRequest: -8,
  cancelled: -9,
} as const;

const CLICK_NOTES: Record<number, string> = {
  0: 'Success',
  [-1]: 'SIGN CHECK FAILED!',
  [-2]: 'Incorrect parameter amount',
  [-3]: 'Action not found',
  [-4]: 'Already paid',
  [-5]: 'User does not exist',
  [-6]: 'Transaction does not exist',
  [-7]: 'Failed to update user',
  [-8]: 'Error in request from click',
  [-9]: 'Transaction cancelled',
};

const DIGIT_TEXT = /^[0-9]{1,20}$/;
/** Click's integer fields are written back as JSON numbers from the digits it sent, never re-parsed. */
export function clickReply(input: {
  clickTransId: string | null;
  orderRef: string | null;
  prepareId?: bigint | null;
  confirmId?: bigint | null;
  error: number;
}): string {
  const parts = [
    `"click_trans_id":${input.clickTransId && DIGIT_TEXT.test(input.clickTransId) ? input.clickTransId : 'null'}`,
    `"merchant_trans_id":${JSON.stringify(input.orderRef ?? null)}`,
  ];
  if (input.prepareId !== undefined)
    parts.push(`"merchant_prepare_id":${input.prepareId === null ? 'null' : input.prepareId}`);
  if (input.confirmId !== undefined)
    parts.push(`"merchant_confirm_id":${input.confirmId === null ? 'null' : input.confirmId}`);
  parts.push(
    `"error":${input.error}`,
    `"error_note":${JSON.stringify(CLICK_NOTES[input.error] ?? '')}`,
  );
  return `{${parts.join(',')}}`;
}

export type ClickDecision = { reply: string; change: CheckoutChange | null };

/** One Click call against the row its `merchant_trans_id` names, or null when nothing matches. */
export function decideClick(
  call: ClickCall,
  session: CheckoutSessionView | null,
  nowMs: bigint,
): ClickDecision {
  const answer = (
    error: number,
    extra: { prepareId?: bigint | null; confirmId?: bigint | null } = {},
  ) => clickReply({ clickTransId: call.clickTransId, orderRef: call.orderRef, error, ...extra });
  const refuse = (error: number): ClickDecision => ({ reply: answer(error), change: null });
  if (call.action !== 0 && call.action !== 1) return refuse(CLICK_ERRORS.actionNotFound);
  if (!session || session.processor !== 'click' || session.clickPrepareId === null)
    return refuse(CLICK_ERRORS.orderNotFound);
  const amount = clickAmountToTiyin(call.amount);
  if (amount === null || amount !== session.amountMinor)
    return refuse(CLICK_ERRORS.incorrectAmount);
  const sameTxn = session.providerTxnRef === call.clickTransId;
  if (call.action === 0) {
    if (session.state === 'paid') return refuse(CLICK_ERRORS.alreadyPaid);
    if (session.state === 'reserved' && sameTxn)
      return {
        reply: answer(CLICK_ERRORS.success, { prepareId: session.clickPrepareId }),
        change: null,
      };
    if (session.state !== 'open' || !session.invoiceOpen || call.error !== 0)
      return refuse(CLICK_ERRORS.cancelled);
    return {
      reply: answer(CLICK_ERRORS.success, { prepareId: session.clickPrepareId }),
      change: {
        action: 'click.prepare',
        to: 'reserved',
        providerTxnRef: call.clickTransId,
        providerTimeMs: null,
        atMs: nowMs,
      },
    };
  }
  if (
    !sameTxn ||
    call.merchantPrepareId === null ||
    call.merchantPrepareId !== session.clickPrepareId.toString()
  )
    return refuse(
      session.state === 'paid' ? CLICK_ERRORS.alreadyPaid : CLICK_ERRORS.transactionNotFound,
    );
  // A repeat of the Complete that paid it gets the same success, so Click never reverses a payment we
  // already counted because an answer was lost on the way back.
  if (session.state === 'paid')
    return {
      reply: answer(CLICK_ERRORS.success, { confirmId: session.clickPrepareId }),
      change: null,
    };
  if (session.state !== 'reserved') return refuse(CLICK_ERRORS.cancelled);
  if (call.error < 0)
    return {
      reply: answer(CLICK_ERRORS.cancelled),
      change: { action: 'click.complete', to: 'cancelled', atMs: nowMs, reason: null },
    };
  if (!session.invoiceOpen) return refuse(CLICK_ERRORS.cancelled);
  return {
    reply: answer(CLICK_ERRORS.success, { confirmId: session.clickPrepareId }),
    change: { action: 'click.complete', to: 'paid', atMs: nowMs },
  };
}

// --- Paddle Billing (signed notifications; merchant of record, so its tax figures are the invoice's).

export type PaddleDecision =
  | { outcome: 'apply'; change: CheckoutChange }
  | { outcome: 'nothing' }
  /** Money or a reference that does not match our row. Kept for a person, and settles nothing. */
  | { outcome: 'mismatch' }
  /** Money taken for a checkout we had already closed. A person has to return it. */
  | { outcome: 'paid_after_close' };

export function decidePaddle(
  fact: PaddleFact,
  session: CheckoutSessionView | null,
  nowMs: bigint,
): PaddleDecision {
  if (!session || session.processor !== 'paddle' || session.providerTxnRef !== fact.transactionId)
    return { outcome: 'mismatch' };
  if (fact.orderRef !== null && fact.orderRef !== session.id) return { outcome: 'mismatch' };
  switch (fact.kind) {
    case 'paid': {
      const total = parseMinor(fact.grandTotalMinor);
      const tax = parseMinor(fact.taxMinor);
      if (
        fact.currency !== session.currency ||
        total === null ||
        tax === null ||
        total !== session.amountMinor
      )
        return { outcome: 'mismatch' };
      if (session.state === 'paid' || session.state === 'refunded') return { outcome: 'nothing' };
      if (session.state === 'cancelled') return { outcome: 'paid_after_close' };
      if (session.state !== 'open') return { outcome: 'mismatch' };
      return {
        outcome: 'apply',
        change: { action: 'paddle.paid', to: 'paid', atMs: nowMs, taxMinor: tax },
      };
    }
    case 'cancelled':
      return session.state === 'open'
        ? {
            outcome: 'apply',
            change: { action: 'paddle.cancelled', to: 'cancelled', atMs: nowMs, reason: null },
          }
        : { outcome: 'nothing' };
    case 'refunded':
      return session.state === 'paid'
        ? {
            outcome: 'apply',
            change: { action: 'paddle.refunded', to: 'refunded', atMs: nowMs, reason: null },
          }
        : { outcome: 'nothing' };
    case 'disputed':
      // Recorded and shown to a person by the caller. The row keeps what the money did.
      return { outcome: 'nothing' };
  }
}

/** What Paddle's transaction lookup says, the authoritative reconcile for a webhook that never came. */
export type PaddleLookup =
  | {
      status: 'paid';
      transactionId: string;
      currency: string;
      grandTotalMinor: string;
      taxMinor: string;
    }
  | { status: 'cancelled'; transactionId: string }
  | { status: 'open'; transactionId: string };

export function decidePaddleLookup(
  lookup: PaddleLookup,
  session: CheckoutSessionView,
  nowMs: bigint,
): PaddleDecision {
  if (session.processor !== 'paddle' || session.providerTxnRef !== lookup.transactionId)
    return { outcome: 'mismatch' };
  if (lookup.status === 'open') return { outcome: 'nothing' };
  if (lookup.status === 'cancelled')
    return session.state === 'open'
      ? {
          outcome: 'apply',
          change: { action: 'paddle.lookup_cancelled', to: 'cancelled', atMs: nowMs, reason: null },
        }
      : { outcome: 'nothing' };
  const total = parseMinor(lookup.grandTotalMinor);
  const tax = parseMinor(lookup.taxMinor);
  if (
    lookup.currency !== session.currency ||
    total === null ||
    tax === null ||
    total !== session.amountMinor
  )
    return { outcome: 'mismatch' };
  if (session.state === 'cancelled') return { outcome: 'paid_after_close' };
  if (session.state !== 'open') return { outcome: 'nothing' };
  return {
    outcome: 'apply',
    change: { action: 'paddle.lookup_paid', to: 'paid', atMs: nowMs, taxMinor: tax },
  };
}

// --- What the web tier answers by itself, before or without the worker. None of these reveals a row.

/** Payme: not POST, not JSON, refused credentials, or no answer in time. */
export function paymeFallbackReply(
  kind: 'not_post' | 'parse' | 'unauthorized' | 'unavailable',
  rpcId: JsonRpcId = null,
): string {
  const code =
    kind === 'not_post'
      ? PAYME_ERRORS.notPost
      : kind === 'parse'
        ? PAYME_ERRORS.parse
        : kind === 'unauthorized'
          ? PAYME_ERRORS.insufficientPrivilege
          : PAYME_ERRORS.system;
  return paymeErrorReply(rpcId, code);
}

/** Click: a refused signature, a request that could not be read, or no answer in time. */
export function clickFallbackReply(kind: 'unauthorized' | 'bad_request' | 'unavailable'): string {
  return clickReply({
    clickTransId: null,
    orderRef: null,
    error:
      kind === 'unauthorized'
        ? CLICK_ERRORS.signFailed
        : kind === 'bad_request'
          ? CLICK_ERRORS.badRequest
          : CLICK_ERRORS.updateFailed,
  });
}

/** What the customer's status page says. Honest about a payment in progress, and never about internals. */
export type CheckoutDisplay =
  'preparing' | 'waiting' | 'processing' | 'paid' | 'not_paid' | 'refunded';
export function checkoutDisplay(state: CheckoutState): CheckoutDisplay {
  switch (state) {
    case 'opening':
      return 'preparing';
    case 'open':
      return 'waiting';
    case 'reserved':
      return 'processing';
    case 'paid':
      return 'paid';
    case 'cancelled':
      return 'not_paid';
    case 'refunded':
      return 'refunded';
  }
}
