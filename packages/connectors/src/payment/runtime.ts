import {
  PAYMENT_CODES,
  paymentExecutionIdentity,
  type ChargeRequest,
  type ChargeResult,
  type PaymentLookupResult,
  type PaymentProcessor,
  type ProcessorCallContext,
  type PaymentExecutionIdentity,
} from '@ensemus/saas/payment';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@ensemus/domain/approval';
import { SEND_DEADLINE_MS } from '../runtime/actions';
import { isPaymentTransportReceipt } from './gateway';

const identityProofs = new WeakSet<object>();
export type VerifiedPaymentExecutionIdentity = Readonly<{
  identity: PaymentExecutionIdentity;
  sha256: string;
  accountNamespaceSha256: string;
  readReceiptSha256: string;
  authoritySha256: string;
  restoreGeneration: string;
  verifiedAtEpochMs: number;
  apiOrigin: string;
}>;
export const isVerifiedPaymentExecutionIdentity = (
  value: unknown,
): value is VerifiedPaymentExecutionIdentity =>
  typeof value === 'object' && value !== null && identityProofs.has(value);

/** Real dispatch uses this in addition to the adapter's parser. A declared answer without the matching
 * bounded gateway exchange is not an external receipt. Request admission may have committed before an
 * error, so lack of a receipt is unknown even when a native adapter guesses `not_sent`. */
function trackedPaymentCall(
  context: ProcessorCallContext,
  authoritySha256: string,
  phase: 'customer' | 'charge' | 'lookup',
) {
  let requests = 0;
  let receipts = 0;
  const wrapped: ProcessorCallContext = {
    signal: context.signal,
    withCredential: context.withCredential.bind(context),
    async request(this: ProcessorCallContext, input) {
      requests += 1;
      if (requests !== 1) throw new Error('PAYMENT_SINGLE_TRANSPORT_REQUIRED');
      const response = await context.request.call({ ...context, signal: this.signal }, input);
      const receipt = response.transportReceipt;
      if (
        !isPaymentTransportReceipt(receipt) ||
        receipt.phase !== phase ||
        receipt.authoritySha256 !== authoritySha256 ||
        receipt.status !== response.status ||
        receipt.responseSha256 !== createHash('sha256').update(response.body).digest('hex')
      )
        throw new Error('PAYMENT_TRANSPORT_UNCONFIRMED');
      receipts += 1;
      return response;
    },
  };
  return { context: wrapped, confirmed: () => requests === 1 && receipts === 1 };
}

export async function runBoundCustomerRegistration(
  processor: PaymentProcessor,
  context: ProcessorCallContext,
  input: Parameters<PaymentProcessor['createCustomer']>[1],
  authoritySha256: string,
): Promise<string | null> {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    context.signal,
    controller.signal,
    AbortSignal.timeout(SEND_DEADLINE_MS),
  ]);
  if (signal.aborted) return null;
  const tracked = trackedPaymentCall({ ...context, signal }, authoritySha256, 'customer');
  let abort: () => void = () => undefined;
  try {
    const stopped = new Promise<null>((resolve) => {
      abort = () => resolve(null);
      signal.addEventListener('abort', abort, { once: true });
    });
    const work = Promise.resolve()
      .then(() => processor.createCustomer(tracked.context, input))
      .then(
        (answer) =>
          tracked.confirmed() && reference(answer.customerRef) ? answer.customerRef : null,
        () => null,
      );
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

export async function runBoundCharge(
  processor: PaymentProcessor,
  context: ProcessorCallContext,
  input: ChargeRequest,
  authoritySha256: string,
): Promise<ChargeResult> {
  const tracked = trackedPaymentCall(context, authoritySha256, 'charge');
  const answer = await runCharge(processor, tracked.context, input);
  return tracked.confirmed() ? answer : { outcome: 'indeterminate', code: 'PROCESSOR_ERROR' };
}

export async function runBoundPaymentLookup(
  processor: PaymentProcessor,
  context: ProcessorCallContext,
  key: string,
  authoritySha256: string,
): Promise<PaymentLookupResult> {
  const tracked = trackedPaymentCall(context, authoritySha256, 'lookup');
  const answer = await runPaymentLookup(processor, tracked.context, key);
  return tracked.confirmed() ? answer : { found: 'cannot_answer' };
}

/** The native verifier must actually use its credential and read-only gateway; a declaration is insufficient. */
export async function identifyPaymentExecution(
  processor: PaymentProcessor,
  context: ProcessorCallContext,
  authoritySha256: string,
): Promise<VerifiedPaymentExecutionIdentity | null> {
  if (
    !processor.identifyExecution ||
    context.signal.aborted ||
    !/^[0-9a-f]{64}$/.test(authoritySha256)
  )
    return null;
  let leased = 0;
  let inFlight = 0;
  let observedAt = 0;
  const observedOrigins = new Set<string>();
  const observedGenerations = new Set<string>();
  const reads: string[] = [];
  const controller = new AbortController();
  const signal = AbortSignal.any([
    context.signal,
    controller.signal,
    AbortSignal.timeout(SEND_DEADLINE_MS),
  ]);
  try {
    const identityWork = processor.identifyExecution({
      signal,
      withCredential: (use) =>
        context.withCredential(async (secret) => {
          if (!secret.length || signal.aborted) throw new Error('PAYMENT_IDENTITY_UNAVAILABLE');
          leased += 1;
          try {
            return await use(secret);
          } finally {
            leased -= 1;
          }
        }),
      async request(input) {
        if (
          leased !== 1 ||
          signal.aborted ||
          input.method !== 'GET' ||
          input.body !== undefined ||
          reads.length >= 4
        )
          throw new Error('PAYMENT_IDENTITY_UNAVAILABLE');
        inFlight += 1;
        let response: Awaited<ReturnType<ProcessorCallContext['request']>>;
        try {
          response = await context.request.call(
            { ...context, signal },
            { ...input, maxResponseBytes: 262144 },
          );
        } finally {
          inFlight -= 1;
        }
        if (
          signal.aborted ||
          response.status < 200 ||
          response.status >= 300 ||
          !(response.body instanceof Uint8Array) ||
          response.body.byteLength > 262144
        )
          throw new Error('PAYMENT_IDENTITY_UNAVAILABLE');
        const transport = response.transportReceipt;
        if (
          !isPaymentTransportReceipt(transport) ||
          transport.phase !== 'identity' ||
          transport.authoritySha256 !== authoritySha256 ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transport.restoreGeneration) ||
          transport.status !== response.status ||
          transport.responseSha256 !== createHash('sha256').update(response.body).digest('hex')
        )
          throw new Error('PAYMENT_IDENTITY_UNAVAILABLE');
        observedAt = Date.now();
        observedOrigins.add(transport.origin);
        observedGenerations.add(transport.restoreGeneration);
        reads.push(
          createHash('sha256')
            .update(
              canonicalJson({
                pathSha256: createHash('sha256').update(input.path).digest('hex'),
                status: response.status,
                responseSha256: createHash('sha256').update(response.body).digest('hex'),
              }),
            )
            .digest('hex'),
        );
        return response;
      },
    });
    const stopped = new Promise<null>((resolve) =>
      signal.addEventListener('abort', () => resolve(null), { once: true }),
    );
    const raw = await Promise.race([identityWork, stopped]);
    if (signal.aborted || !reads.length || leased !== 0 || inFlight !== 0) return null;
    const parsed = paymentExecutionIdentity(raw, processor.manifest);
    if (
      !parsed ||
      observedOrigins.size !== 1 ||
      observedGenerations.size !== 1 ||
      [...observedOrigins].some((origin) => !parsed.identity.apiOrigins.includes(origin))
    )
      return null;
    const proof = Object.freeze({
      identity: Object.freeze({
        ...parsed.identity,
        apiOrigins: Object.freeze([...parsed.identity.apiOrigins]),
      }),
      sha256: parsed.sha256,
      accountNamespaceSha256: parsed.accountNamespaceSha256,
      readReceiptSha256: createHash('sha256').update(canonicalJson(reads)).digest('hex'),
      authoritySha256,
      restoreGeneration: [...observedGenerations][0]!,
      verifiedAtEpochMs: observedAt,
      apiOrigin: [...observedOrigins][0]!,
    });
    identityProofs.add(proof);
    return proof;
  } catch {
    return null;
  } finally {
    controller.abort();
  }
}
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
