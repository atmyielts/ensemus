// The door of POST /api/webhooks/{token} (ADR-027 D4), with nothing from the server or the runtime in it,
// so a test can drive every answer. A stranger can reach this with no session, so everything here runs
// before a query is spent, and every answer has no body: there is nothing to learn from one.
import {
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_REPLICA_LIMIT_PER_MINUTE,
  WEBHOOK_UNKNOWN_CALLER_LIMIT_PER_MINUTE,
  type WebhookIngressOutcome,
} from '@ensemus/domain/webhook';

const WINDOW_MS = 60_000;
/** How long a sender gets to finish a body. It holds a slot while it does. */
const READ_DEADLINE_MS = 10_000;
/** How long a sender should wait when the reason is not a window, such as a restore. */
const COME_BACK_SECONDS = 30;
/** Keeps the map's keys small, whatever a caller's proxy passed along. */
const MAX_ADDRESS_LENGTH = 64;
/**
 * Requests in progress at once on this replica. Each can hold a body of up to 1 MiB in memory while it
 * waits for one of the two connections its pool has, so the wait has to have an end. Not in the ADR's
 * table, and only ever makes a limit tighter: a sender hears 429 and retries.
 */
const IN_FLIGHT_LIMIT = 32;

export type WebhookLimits = { unknownPerAddress: number; replica: number; inFlight: number };

export type WebhookAdmission =
  | {
      ok: true;
      /** `unknown` says whether the token turned out to be one nobody issued. */
      release(unknown: boolean): void;
    }
  | { ok: false; retryAfterSeconds: number };

/**
 * Per replica and deliberately in memory, because what it protects is the database. A call is charged
 * before it runs and refunded if the token was real, so a burst cannot race past the check, and a real
 * sender's traffic never counts as unknown. Its own limits live on the endpoint's row.
 */
export function createWebhookLimiter(overrides: Partial<WebhookLimits> = {}) {
  const limits: WebhookLimits = {
    unknownPerAddress: WEBHOOK_UNKNOWN_CALLER_LIMIT_PER_MINUTE,
    replica: WEBHOOK_REPLICA_LIMIT_PER_MINUTE,
    inFlight: IN_FLIGHT_LIMIT,
    ...overrides,
  };
  let windowStartedAt: number | undefined;
  let spent = 0;
  let inFlight = 0;
  // Only an address that was let in gets an entry, so this can never outgrow the replica's limit.
  const addresses = new Map<string, number>();

  return {
    admit(address: string, nowMs: number): WebhookAdmission {
      if (windowStartedAt === undefined || nowMs - windowStartedAt >= WINDOW_MS) {
        windowStartedAt = nowMs;
        spent = 0;
        addresses.clear();
      }
      const startedAt = windowStartedAt;
      const refuse = () => ({
        ok: false as const,
        retryAfterSeconds: Math.max(1, Math.ceil((startedAt + WINDOW_MS - nowMs) / 1000)),
      });
      if (inFlight >= limits.inFlight) return { ok: false, retryAfterSeconds: 1 };
      const fromAddress = addresses.get(address) ?? 0;
      if (fromAddress >= limits.unknownPerAddress || spent >= limits.replica) return refuse();

      spent += 1;
      addresses.set(address, fromAddress + 1);
      inFlight += 1;
      let released = false;
      return {
        ok: true,
        release(unknown) {
          if (released) return;
          released = true;
          inFlight -= 1;
          if (unknown || windowStartedAt !== startedAt) return;
          spent -= 1;
          const left = (addresses.get(address) ?? 1) - 1;
          if (left > 0) addresses.set(address, left);
          else addresses.delete(address);
        },
      };
    },
    /** For a test: the whole of what this holds per caller. */
    trackedAddresses: () => addresses.size,
  };
}

export type BoundedBody =
  { kind: 'body'; bytes: Uint8Array } | { kind: 'too_large' } | { kind: 'too_slow' };

/** Reads a body up to a limit and a deadline, stopping as soon as either is passed. */
export async function readBoundedBody(
  request: Request,
  options: { maxBytes: number; deadlineMs: number },
): Promise<BoundedBody> {
  // A claim, so it can only refuse. What counts is what is actually counted below.
  const declared = request.headers.get('content-length');
  if (declared && /^[0-9]+$/.test(declared) && Number(declared) > options.maxBytes) {
    return { kind: 'too_large' };
  }
  if (!request.body) return { kind: 'body', bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'too_slow'>((done) => {
    timer = setTimeout(() => done('too_slow'), options.deadlineMs);
  });
  const stopReading = () => void reader.cancel().catch(() => undefined);
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'too_slow') {
        stopReading();
        return { kind: 'too_slow' };
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > options.maxBytes) {
        stopReading();
        return { kind: 'too_large' };
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: 'body', bytes };
  } finally {
    clearTimeout(timer);
  }
}

export type WebhookDoorDeps = {
  /** False until an operator has turned on the connector worker. Nothing else is looked at then. */
  enabled: () => boolean;
  limiter: ReturnType<typeof createWebhookLimiter>;
  ingest: (input: {
    token: string;
    body: Uint8Array;
    headers: Readonly<Record<string, string>>;
  }) => Promise<WebhookIngressOutcome | 'restoring'>;
  /** Told only that something failed. The caller hears a 503 and nothing about why. */
  onError: (error: unknown) => void;
  now?: () => number;
  readDeadlineMs?: number;
};

/**
 * One answer per status. The same Response for an unknown and a disabled token is what makes the two
 * impossible to tell apart here, and there is no X-Request-Id, because this route has no session to
 * trace and the same bytes should come back every time.
 */
function answer(status: number, retryAfterSeconds?: number) {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (retryAfterSeconds !== undefined) headers['Retry-After'] = String(retryAfterSeconds);
  return new Response(null, { status, headers });
}

const addressOf = (request: Request) =>
  // The deployed proxy replaces this header with who really connected, so a caller cannot choose it.
  (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown').slice(
    0,
    MAX_ADDRESS_LENGTH,
  );

/** The order is the rule: off, then limits, then bytes, and only then a database. */
export async function handleWebhookRequest(
  request: Request,
  token: string,
  deps: WebhookDoorDeps,
): Promise<Response> {
  if (!deps.enabled()) return answer(404);
  const admission = deps.limiter.admit(addressOf(request), (deps.now ?? Date.now)());
  if (!admission.ok) return answer(429, admission.retryAfterSeconds);

  let unknown = false;
  try {
    const body = await readBoundedBody(request, {
      maxBytes: WEBHOOK_MAX_BODY_BYTES,
      deadlineMs: deps.readDeadlineMs ?? READ_DEADLINE_MS,
    });
    if (body.kind === 'too_large') return answer(413);
    // Not one of the outcomes the sender needs to tell apart: it should simply try again.
    if (body.kind === 'too_slow') return answer(503, COME_BACK_SECONDS);

    const outcome = await deps.ingest({
      token,
      body: body.bytes,
      headers: Object.fromEntries(request.headers),
    });
    switch (outcome) {
      case 'accepted':
        return answer(202);
      case 'not_found':
        unknown = true;
        return answer(404);
      case 'too_large':
        return answer(413);
      case 'rate_limited':
        return answer(429, Math.ceil(WINDOW_MS / 1000));
      case 'restoring':
        return answer(503, COME_BACK_SECONDS);
    }
  } catch (error) {
    deps.onError(error);
    return answer(503, COME_BACK_SECONDS);
  } finally {
    admission.release(unknown);
  }
}
