import {
  PAYMENT_CODES,
  type ChargeRequest,
  type ChargeResult,
  type PaymentLookupResult,
  type PaymentProcessor,
  type ProcessorCallContext,
} from '@ensemus/saas/payment';
import { SEND_DEADLINE_MS } from '../runtime/actions';
const reference = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);
function chargeResult(value: ChargeResult): ChargeResult {
  if (!value || !PAYMENT_CODES.includes(value.code))
    return { outcome: 'indeterminate', code: 'PROCESSOR_ERROR' };
  if (
    value.outcome === 'succeeded' &&
    value.code === 'CHARGED' &&
    reference(value.processorPaymentRef)
  )
    return {
      outcome: 'succeeded',
      code: 'CHARGED',
      processorPaymentRef: value.processorPaymentRef,
    };
  if (
    value.outcome === 'declined' &&
    (value.processorPaymentRef === null || reference(value.processorPaymentRef))
  )
    return {
      outcome: 'declined',
      code: value.code,
      processorPaymentRef: value.processorPaymentRef,
    };
  if (value.outcome === 'not_sent' && typeof value.retryable === 'boolean')
    return { outcome: 'not_sent', code: value.code, retryable: value.retryable };
  if (value.outcome === 'indeterminate') return { outcome: 'indeterminate', code: value.code };
  return { outcome: 'indeterminate', code: 'PROCESSOR_ERROR' };
}

/** One invocation only. A throw or a deadline proves nothing about whether money moved. */
export async function runCharge(
  processor: PaymentProcessor,
  context: ProcessorCallContext,
  request: ChargeRequest,
  deadlineMs = SEND_DEADLINE_MS,
): Promise<ChargeResult> {
  if (processor.manifest.nativeIdempotency !== true)
    return { outcome: 'not_sent', code: 'PROCESSOR_ERROR', retryable: false };
  if (context.signal.aborted)
    return { outcome: 'not_sent', code: 'TIMEOUT_BEFORE_SEND', retryable: true };
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)
    return { outcome: 'not_sent', code: 'PROCESSOR_ERROR', retryable: false };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => undefined;
  const stopped = new Promise<ChargeResult>((resolve) => {
    abort = () => {
      controller.abort();
      resolve({ outcome: 'indeterminate', code: 'TIMEOUT_AFTER_SEND' });
    };
    context.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, deadlineMs);
  });
  try {
    const call = Promise.resolve()
      .then(() => processor.charge({ ...context, signal: controller.signal }, request))
      .then(chargeResult, () => ({
        outcome: 'indeterminate' as const,
        code: 'PROCESSOR_ERROR' as const,
      }));
    return await Promise.race([call, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    context.signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

/** A lookup is read-only. Lack of an answer stays unknown, regardless of provider error text. */
export async function runPaymentLookup(
  processor: PaymentProcessor,
  context: ProcessorCallContext,
  key: string,
  deadlineMs = SEND_DEADLINE_MS,
): Promise<PaymentLookupResult> {
  if (
    processor.manifest.lookup === 'none' ||
    context.signal.aborted ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1
  )
    return { found: 'cannot_answer' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => undefined;
  const stopped = new Promise<PaymentLookupResult>((resolve) => {
    abort = () => {
      controller.abort();
      resolve({ found: 'cannot_answer' });
    };
    context.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, deadlineMs);
  });
  try {
    const result = await Promise.race([
      processor.lookup({ ...context, signal: controller.signal }, key),
      stopped,
    ]);
    if (result.found === 'succeeded' && reference(result.processorPaymentRef))
      return { found: 'succeeded', processorPaymentRef: result.processorPaymentRef };
    if (
      result.found === 'declined' &&
      (result.processorPaymentRef === null || reference(result.processorPaymentRef))
    )
      return { found: 'declined', processorPaymentRef: result.processorPaymentRef };
    return result.found === 'not_found' ? { found: 'not_found' } : { found: 'cannot_answer' };
  } catch {
    return { found: 'cannot_answer' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    context.signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
