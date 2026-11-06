// Owned by the payments slice. See docs/06-delivery/m8-slices.md.
import type {
  ChargeRequest,
  ChargeResult,
  PaymentEventFact,
  PaymentLookupResult,
  PaymentProcessor,
} from '../payment';

/** What the double does next, so a test can say exactly how a processor misbehaves. */
export type FakeProcessorScript = {
  lookup: 'none' | 'best_effort' | 'authoritative';
  onCharge: (request: ChargeRequest, callNo: number) => ChargeResult | Promise<ChargeResult>;
  onLookup?: (idempotencyKey: string) => PaymentLookupResult | Promise<PaymentLookupResult>;
  interpret?: (providerEventId: string, body: Uint8Array) => PaymentEventFact | null;
};

/** Records invocations separately from possible charges, so native deduplication cannot hide a duplicate call. */
export function createFakePaymentProcessor(script: FakeProcessorScript): PaymentProcessor & {
  readonly charges: readonly ChargeRequest[];
  readonly requests: readonly ChargeRequest[];
} {
  const recorded: { request: ChargeRequest; charged: boolean }[] = [];
  const requests: ChargeRequest[] = [];
  const fingerprints = new Map<string, string>();
  const results = new Map<string, Promise<ChargeResult>>();
  let calls = 0;
  return {
    manifest: {
      processor: 'test_scripted',
      version: '1.0.0',
      lookup: script.lookup,
      nativeIdempotency: true,
      webhookScheme: 'ensemus_hmac_sha256_v1',
    },
    get charges() {
      return structuredClone(recorded.filter((row) => row.charged).map((row) => row.request));
    },
    get requests() {
      return structuredClone(requests);
    },
    async createCustomer(_context, input) {
      return { customerRef: `test-customer:${input.idempotencyKey}` };
    },
    charge(_context, request) {
      requests.push(structuredClone(request));
      const hash = JSON.stringify([
        request.paymentId,
        request.amountMicros.toString(),
        request.currency,
        request.minorUnitExponent,
        request.customerRef,
      ]);
      const old = fingerprints.get(request.idempotencyKey);
      if (old && old !== hash) return Promise.reject(new Error('TEST_IDEMPOTENCY_MISMATCH'));
      fingerprints.set(request.idempotencyKey, hash);
      const existing = results.get(request.idempotencyKey);
      if (existing) return existing;
      calls += 1;
      const number = calls;
      const row = { request: structuredClone(request), charged: true };
      recorded.push(row);
      const result = Promise.resolve()
        .then(() => script.onCharge(structuredClone(request), number))
        .then((answer) => {
          if (answer.outcome === 'not_sent' || answer.outcome === 'declined') row.charged = false;
          if (answer.outcome === 'not_sent') results.delete(request.idempotencyKey);
          return answer;
        });
      results.set(request.idempotencyKey, result);
      return result;
    },
    async lookup(_context, key) {
      return script.onLookup ? script.onLookup(key) : { found: 'cannot_answer' };
    },
    interpretWebhook(eventId, body) {
      return script.interpret ? script.interpret(eventId, body) : null;
    },
  };
}
