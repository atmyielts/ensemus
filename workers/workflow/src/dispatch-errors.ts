// Tells an outage from a bad event. An outage says nothing about the event, so it must not push the
// event towards going dead. Pure, so it can be tested without a server.

// gRPC status codes that mean "try again later": CANCELLED, UNKNOWN, DEADLINE_EXCEEDED,
// RESOURCE_EXHAUSTED, ABORTED, INTERNAL, UNAVAILABLE.
const TRANSIENT_GRPC_CODES = new Set([1, 2, 4, 8, 10, 13, 14]);
const TRANSIENT_NETWORK_CODES = new Set([
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

export function isTransientDeliveryError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSES && current && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'number' && TRANSIENT_GRPC_CODES.has(code)) return true;
    if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return true;
    current = cause;
  }
  return false;
}
