// The plumbing every Google suite tool shares (ADR-038 D6): the scope check, one request with Google's
// statuses turned into codes, the rules for what a send may call `not_sent`, and output that fits its
// tool's limit. Google-only, and owned with ./tools.ts. Nothing here keeps or passes on provider text:
// an error body is read for Google's machine reasons and nothing else.
import { SUITE_CONNECTION_RULES, type ConnectionRule } from '@ensemus/domain/ai-tools';
import type { AiClassification } from '@ensemus/domain/ai';
import {
  NotSent,
  SyncUnavailable,
  type AttemptResult,
  type ConnectorContext,
  type ReconcileResult,
} from '../index';
import {
  ProviderHttpFailed,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderRoute,
} from '../knowledge';
import { SuiteReadRefused, type SuiteReadResult } from '../suites';
import type { GoogleToolDeps } from './tools';

/** One call, as a handler names it. The token, the signal and the limits are added here. */
export type GoogleCall = {
  route: Extract<ProviderRoute, 'google_api' | 'google_gmail' | 'google_docs' | 'google_sheets'>;
  method: ProviderRequest['method'];
  path: string;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as is, with its own content type. */
  raw?: { body: Buffer; contentType: string };
  maxResponseBytes?: number;
};

const TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_BYTES = 2_097_152;
/** The HTTP client refuses a larger body before it connects; refusing here first says why, and is certain. */
export const MAX_REQUEST_BYTES = 1_048_576;

/** Every scope the tool's Google binding names is in the connection's provider-confirmed grant. */
export function hasToolScopes(context: ConnectorContext, toolId: string): boolean {
  const rules = SUITE_CONNECTION_RULES as Readonly<Record<string, ConnectionRule>>;
  const binding = Object.hasOwn(rules, toolId) ? rules[toolId]?.bindings.google_workspace : null;
  return (
    !!binding &&
    Array.isArray(context.grantedScopes) &&
    binding.scopes.every((scope) => context.grantedScopes?.includes(scope))
  );
}

function bodyOf(call: GoogleCall): { body?: Buffer; headers: Record<string, string> } {
  if (call.raw) return { body: call.raw.body, headers: { 'content-type': call.raw.contentType } };
  if (call.json === undefined) return { headers: {} };
  return {
    body: Buffer.from(JSON.stringify(call.json), 'utf8'),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  };
}

function providerRequest(context: ConnectorContext, token: string, call: GoogleCall) {
  const { body, headers } = bodyOf(call);
  const request: ProviderRequest = {
    route: call.route,
    method: call.method,
    path: call.path,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...headers },
    timeoutMs: TIMEOUT_MS,
    maxResponseBytes: call.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES,
    signal: context.signal,
    ...(body ? { body } : {}),
  };
  return request;
}

/** Google's machine-readable reasons from an error body, lower case. Never its message. */
function errorReasons(body: Buffer): ReadonlySet<string> {
  const reasons = new Set<string>();
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { error?: unknown };
    const error = parsed.error as
      { errors?: unknown; details?: unknown; status?: unknown } | undefined;
    if (!error || typeof error !== 'object') return reasons;
    for (const list of [error.errors, error.details]) {
      if (!Array.isArray(list)) continue;
      for (const item of list.slice(0, 20)) {
        const reason = (item as { reason?: unknown } | null)?.reason;
        if (typeof reason === 'string' && reason.length <= 100) reasons.add(reason.toLowerCase());
      }
    }
  } catch {
    // An error body that is not Google's JSON says nothing more than its status.
  }
  return reasons;
}

/**
 * What a 403 means. Google answers a token without the scope, and a quota running out, with 403 as well as
 * a plain "no": the first says so in `WWW-Authenticate` and in its reasons, the second in its reasons.
 */
export function forbiddenKind(response: ProviderResponse): 'scope' | 'rate' | 'other' {
  if (/insufficient_scope/i.test(response.headers['www-authenticate'] ?? '')) return 'scope';
  const reasons = errorReasons(response.body);
  if (reasons.has('insufficientpermissions') || reasons.has('access_token_scope_insufficient'))
    return 'scope';
  for (const reason of reasons) {
    if (/ratelimitexceeded|rate_limit_exceeded|quotaexceeded|quota_exceeded/.test(reason))
      return 'rate';
  }
  return 'other';
}

export function parseJson(response: ProviderResponse): Record<string, unknown> {
  try {
    const body: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(response.body),
    );
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_JSON');
    return body as Record<string, unknown>;
  } catch {
    throw new SyncUnavailable('PROVIDER_RESPONSE_INVALID');
  }
}

// --- Reads.

/**
 * Runs a read's requests under the connection's token. `withToken` turns any error it does not know into
 * PROVIDER_UNAVAILABLE, so a refusal is carried round it and thrown as itself.
 */
export async function withReadToken<T>(
  deps: GoogleToolDeps,
  context: ConnectorContext,
  work: (token: string) => Promise<T>,
): Promise<T> {
  let refused: SuiteReadRefused | undefined;
  try {
    return await deps.withToken(context, async (token) => {
      try {
        return await work(token);
      } catch (error) {
        if (error instanceof SuiteReadRefused) refused = error;
        throw error;
      }
    });
  } catch (error) {
    throw refused ?? error;
  }
}

/** A read's answer to a status: a final refusal, something worth trying again, or the JSON. */
export function readAnswer(response: ProviderResponse): Record<string, unknown> {
  const status = response.status;
  if (status >= 200 && status < 300) return parseJson(response);
  if (status >= 300 && status < 400) throw new SyncUnavailable('PROVIDER_REDIRECT');
  if (status === 401) throw new SyncUnavailable('CREDENTIAL_REJECTED');
  if (status === 403) {
    const kind = forbiddenKind(response);
    if (kind === 'scope') throw new SuiteReadRefused('SCOPE_NOT_GRANTED');
    if (kind === 'rate') throw new SyncUnavailable('RATE_LIMITED');
    throw new SuiteReadRefused('PROVIDER_REFUSED');
  }
  if (status === 404 || status === 410) throw new SuiteReadRefused('PROVIDER_NOT_FOUND');
  if (status === 429) throw new SyncUnavailable('RATE_LIMITED');
  if (status >= 400 && status < 500) throw new SuiteReadRefused('PROVIDER_REFUSED');
  throw new SyncUnavailable('PROVIDER_UNAVAILABLE');
}

/** One read request. Null for a status the caller lists in `skip`, such as a message gone since a list. */
export async function readJson(
  deps: GoogleToolDeps,
  context: ConnectorContext,
  token: string,
  call: GoogleCall,
  skip: readonly number[] = [],
): Promise<Record<string, unknown> | null> {
  let response: ProviderResponse;
  try {
    response = await deps.http.request(providerRequest(context, token, call));
  } catch (error) {
    if (error instanceof ProviderHttpFailed && error.code === 'PROVIDER_RESPONSE_TOO_LARGE')
      throw new SuiteReadRefused('TOOL_OUTPUT_TOO_LARGE');
    throw new SyncUnavailable(context.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE');
  }
  if (skip.includes(response.status)) return null;
  return readAnswer(response);
}

/**
 * JSON that fits `max` bytes. `render(null)` is the whole answer; `render(n)` keeps less as `n` falls
 * (fewer items, or shorter text) and must mark itself truncated. The largest `n` that fits wins, so the
 * output is cut at a whole item or a clean text boundary and never refused for size when anything fits.
 */
export function fitJson(
  render: (limit: number | null) => unknown,
  max: number,
  upper: number,
): Buffer {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
  const whole = encode(render(null));
  if (whole.length <= max) return whole;
  let low = 0;
  let high = Math.max(0, upper);
  let best: Buffer | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = encode(render(middle));
    if (candidate.length <= max) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (!best) throw new SuiteReadRefused('TOOL_OUTPUT_TOO_LARGE');
  return best;
}

export const TRUNCATION_MARKER = '\n[truncated]';

/**
 * At most `limit` characters of `text`, cut between whole characters and, where one is near, at the end of
 * a line or word, with a marker saying so.
 */
export function cutText(text: string, limit: number | null): { text: string; cut: boolean } {
  if (limit === null || text.length <= limit) return { text, cut: false };
  let end = Math.max(0, limit);
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  const window = text.slice(Math.max(0, end - 200), end);
  const breakAt = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
  if (breakAt > 0) end = end - window.length + breakAt;
  return { text: text.slice(0, end) + TRUNCATION_MARKER, cut: true };
}

export function jsonOutput(
  bytes: Buffer,
  classification: AiClassification,
  resourceExternalIds: readonly string[],
): SuiteReadResult {
  return { bytes, mediaType: 'application/json', classification, resourceExternalIds };
}

/** Text for a model: no control characters but line ends and tabs, and no lone surrogates. */
export function cleanText(value: unknown, max = 100_000): string {
  if (typeof value !== 'string') return '';
  return (
    value
      .slice(0, max)
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
  );
}

/** One line of text from a header or name: no line ends at all. */
export function cleanLine(value: unknown, max = 1_000): string {
  return cleanText(value, max)
    .replace(/[\n\t]+/g, ' ')
    .trim();
}

// --- Changes.

const certain = (code: AttemptResult['code'], retryable: boolean, status?: number) =>
  ({
    outcome: 'not_sent',
    code,
    retryable,
    ...(status === undefined ? {} : { providerStatus: status }),
  }) as const satisfies AttemptResult;

/**
 * What a status means for a change, when the handler has no rule of its own for it. Google checks the
 * token and the quota before it does anything, so 401, a scope or quota 403 and 429 are certain nothing
 * happened. Any other 4xx is Google refusing the request as written, which changes nothing. A redirect
 * or 5xx came after the request was written, and only a reconcile can say what it did.
 */
export function attemptAnswer(response: ProviderResponse, externalId?: string): AttemptResult {
  const status = response.status;
  if (status >= 200 && status < 300)
    return {
      outcome: 'accepted',
      code: 'ACCEPTED_BY_PROVIDER',
      providerStatus: status,
      ...(externalId ? { externalId } : {}),
    };
  if (status === 401) return certain('AUTH_FAILED', true, status);
  if (status === 403) {
    const kind = forbiddenKind(response);
    if (kind === 'scope') return certain('AUTH_FAILED', false, status);
    if (kind === 'rate') return certain('RELAY_BUSY', true, status);
  }
  if (status === 429) return certain('RELAY_BUSY', true, status);
  if (status >= 400 && status < 500)
    return { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER', providerStatus: status };
  return { outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT', providerStatus: status };
}

/** A failure before the change's request left. Each of these is certain nothing reached the API. */
function beforeWrite(error: unknown, signal: AbortSignal): NotSent {
  if (error instanceof NotSent) return error;
  const code = error instanceof SyncUnavailable ? error.code : '';
  if (code === 'CREDENTIAL_REJECTED') return new NotSent('AUTH_FAILED', false);
  if (code.startsWith('CREDENTIAL_')) return new NotSent('CREDENTIAL_UNAVAILABLE', false);
  if (code === 'RATE_LIMITED') return new NotSent('RELAY_BUSY', true);
  if (signal.aborted || code === 'PROVIDER_TIMEOUT')
    return new NotSent('TIMEOUT_BEFORE_COMMIT', true);
  return new NotSent('CONNECT_FAILED', true);
}

export type SendSteps = {
  /**
   * A read-only request: before the write, the message a reply answers; after it, a check of what the
   * write did. One that fails before the write is NotSent, and after it leaves the attempt unknown.
   */
  lookup: (call: GoogleCall) => Promise<ProviderResponse>;
  /** The one request that changes something. Its outcome is the attempt's, unless the handler says more. */
  write: (call: GoogleCall) => Promise<ProviderResponse | AttemptResult>;
};

/**
 * Runs one change under the connection's token. Anything that fails before `write` sends is NotSent,
 * because nothing reached the API. Once `write` has sent, a failure is the attempt's to report, and an
 * error thrown from here reads as `indeterminate`. `write` answers a transport failure itself: a refused
 * connection or TLS handshake is certain, anything later is not.
 */
export async function runChange(
  deps: GoogleToolDeps,
  context: ConnectorContext,
  steps: (io: SendSteps) => Promise<AttemptResult>,
): Promise<AttemptResult> {
  let written = false;
  let refused: NotSent | undefined;
  const io = (token: string): SendSteps => ({
    async lookup(call) {
      try {
        return await deps.http.request(providerRequest(context, token, call));
      } catch {
        // After the write, a lookup that fails leaves the attempt as unknown as it was.
        if (written) throw new Error('LOOKUP_FAILED');
        throw beforeWrite(new SyncUnavailable('PROVIDER_UNAVAILABLE'), context.signal);
      }
    },
    async write(call) {
      if (written) throw new Error('SECOND_WRITE');
      const request = providerRequest(context, token, call);
      if ((request.body?.length ?? 0) > MAX_REQUEST_BYTES)
        throw new NotSent('PAYLOAD_CHANGED', false);
      if (context.signal.aborted) throw new NotSent('TIMEOUT_BEFORE_COMMIT', true);
      written = true;
      try {
        return await deps.http.request(request);
      } catch (error) {
        const code = error instanceof ProviderHttpFailed ? error.code : null;
        if (code === 'PROVIDER_CONNECT_FAILED' || code === 'PROVIDER_TLS_FAILED')
          return certain('CONNECT_FAILED', true);
        if (code === 'PROVIDER_ROUTE_UNAVAILABLE') return certain('CONNECTOR_UNAVAILABLE', false);
        return {
          outcome: 'indeterminate',
          code:
            code === 'PROVIDER_TIMEOUT' || context.signal.aborted
              ? 'TIMEOUT_AFTER_COMMIT'
              : 'CONNECTION_LOST_AFTER_COMMIT',
        };
      }
    },
  });
  try {
    return await deps.withToken(context, async (token) => {
      try {
        return await steps(io(token));
      } catch (error) {
        if (error instanceof NotSent && !written) refused = error;
        throw error;
      }
    });
  } catch (error) {
    if (refused) throw refused;
    if (!written) throw beforeWrite(error, context.signal);
    throw error;
  }
}

/** Runs a reconcile's lookups under the token. Anything thrown becomes `cannot_answer` in the runtime. */
export async function lookupFor(
  deps: GoogleToolDeps,
  context: ConnectorContext,
  work: (get: (call: GoogleCall) => Promise<ProviderResponse>) => Promise<ReconcileResult>,
): Promise<ReconcileResult> {
  return deps.withToken(context, (token) =>
    work((call) => deps.http.request(providerRequest(context, token, call))),
  );
}

/** The parsed body of a successful lookup, or null for anything else. */
export function okJson(response: ProviderResponse): Record<string, unknown> | null {
  if (response.status < 200 || response.status >= 300) return null;
  try {
    return parseJson(response);
  } catch {
    return null;
  }
}

/** A provider's ID from a response, or undefined when it is not one we would keep. */
export function externalIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._~:@!$=+-]{1,512}$/.test(value)
    ? value
    : undefined;
}
