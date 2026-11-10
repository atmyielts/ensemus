// Tells an outage from a bad event. An outage says nothing about the event, so it must not push the
// event towards going dead. Pure, so it can be tested without a server.
import type { DeliveryFailure } from '@ensemus/database/dispatcher';
import { TOMBSTONE_RECORDED } from '@ensemus/domain/tombstone-ledger';
import { LedgerUnavailable } from './tombstone-ledger';

/** Writing the tombstone ledger uses the object store and no Temporal call at all. */
export const needsOnlyTheStore = (event: { eventType: string }) =>
  event.eventType === TOMBSTONE_RECORDED;

// gRPC status codes that mean "try again later": CANCELLED, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED,
// ABORTED, UNAVAILABLE.
const OUTAGE_GRPC_CODES = new Set([1, 4, 8, 10, 14]);
// UNKNOWN and INTERNAL. A server in trouble returns these, and so does a bug this one event triggers
// every time, so they can be neither. They count, slowly, and end visibly if they never stop.
const AMBIGUOUS_GRPC_CODES = new Set([2, 13]);
const OUTAGE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

const MAX_CAUSES = 8;

/** Looks through the error and what caused it. A sign of an outage anywhere settles it. */
export function classifyDeliveryError(error: unknown): DeliveryFailure {
  // Only ledger entries need the object store, so its going down must not hold up Temporal calls.
  if (error instanceof LedgerUnavailable) return 'partial_outage';
  let found: DeliveryFailure = 'fault';
  let current = error;
  for (let depth = 0; depth < MAX_CAUSES && current && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'number' && OUTAGE_GRPC_CODES.has(code)) return 'outage';
    if (typeof code === 'string' && OUTAGE_NETWORK_CODES.has(code)) return 'outage';
    if (typeof code === 'number' && AMBIGUOUS_GRPC_CODES.has(code)) found = 'ambiguous';
    current = cause;
  }
  return found;
}
