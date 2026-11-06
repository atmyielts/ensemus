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

/** Counts every charge it is asked for, which is how "charged once" is proved. */
export function createFakePaymentProcessor(_script: FakeProcessorScript): PaymentProcessor & {
  readonly charges: readonly ChargeRequest[];
} {
  throw new Error('NOT_IMPLEMENTED');
}
