import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  auditRefusal,
  auditTenantRefusal,
  HTTP_STATUS,
  idSchema,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import type { components } from '@ensemus/contracts/openapi';
import {
  resolveTenantContext,
  TenantAccessDenied,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { z } from 'zod';
import { getRestoreGate, getRuntime } from './runtime';

// The shared wrapper for /api/v1 (API-10). Every route gets the same order of checks: who is this,
// did the browser send this from our own origin, is the input well formed, and are they in this
// tenant. Services then check permission themselves.
//
// Authentication is the browser session for now. API tokens arrive later, and they will be accepted
// here, with their own scopes and without the origin check, which only matters for cookies.

type ApiErrorBody = components['schemas']['Error'];
type WorkUnitDto = components['schemas']['WorkUnit'];

const MAX_JSON_BYTES = 256 * 1024;
const MAX_REPORTED_FIELDS = 20;
const MAX_POSTGRES_INT = 2_147_483_647;

export const apiLog = createLogger('web-api');

/** A refusal made by the API layer. Messages are fixed text, and never echo input. */
class ApiFailure extends Error {
  override name = 'ApiFailure';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const unauthenticated = () => new ApiFailure(401, 'UNAUTHENTICATED', 'Sign in to continue.');
const originRefused = () =>
  new ApiFailure(403, 'ORIGIN_NOT_ALLOWED', 'This request did not come from an allowed origin.');
const tooLarge = () => new ApiFailure(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
const wrongMediaType = () =>
  new ApiFailure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.');
const versionRequired = () =>
  new ApiFailure(
    428,
    'PRECONDITION_REQUIRED',
    'Send the version you last read in the If-Match header.',
  );

/** The caller reused an Idempotency-Key for a different request. */
export const idempotencyKeyReused = () =>
  new ApiFailure(
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was already used with a different request.',
  );

function invalidInput(issues: readonly { path: readonly PropertyKey[] }[] = []) {
  // Field names come from our own schemas. Values are never included.
  const fields = [...new Set(issues.map((issue) => issue.path.map(String).join('.')))]
    .filter(Boolean)
    .slice(0, MAX_REPORTED_FIELDS);
  return new ApiFailure(
    HTTP_STATUS.INVALID_INPUT,
    'INVALID_INPUT',
    new AppError('INVALID_INPUT').message,
    fields.length > 0 ? { fields } : undefined,
  );
}

function errorResponse(
  status: number,
  requestId: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  const body: ApiErrorBody = {
    code,
    message,
    request_id: requestId,
    // A restore ends without the caller doing anything, and the request did nothing. Every other
    // refusal needs the caller to change something first, and after an unknown failure we cannot
    // promise that repeating the request is safe.
    retryable: code === 'RESTORE_PENDING',
    ...(details ? { details } : {}),
  };
  return Response.json(body, { status });
}

function toErrorResponse(error: unknown, requestId: string) {
  if (error instanceof ApiFailure) {
    return errorResponse(error.status, requestId, error.code, error.message, error.details);
  }
  if (error instanceof AppError) {
    return errorResponse(HTTP_STATUS[error.code], requestId, error.code, error.message);
  }
  if (error instanceof TenantAccessDenied) {
    // The same answer as any other missing thing, so organization IDs cannot be probed.
    const missing = new AppError('NOT_FOUND');
    return errorResponse(HTTP_STATUS.NOT_FOUND, requestId, missing.code, missing.message);
  }
  apiLog.error('api.failed', { requestId, errorCode: errorCode(error) });
  return errorResponse(500, requestId, 'INTERNAL_ERROR', 'Something went wrong on our side.');
}

/**
 * Cookies are SameSite=Lax, which already stops cross-site POSTs, but a write should not rest on
 * one browser default. Browsers always send Origin on writes, so a missing one is refused too.
 */
function assertOwnOrigin(request: Request, publicUrl: string) {
  if (request.headers.get('origin') !== new URL(publicUrl).origin) throw originRefused();
}

export type ApiScope<P> = {
  request: Request;
  requestId: string;
  userId: string;
  /** From the verified cookie, for recent-MFA checks. Never from the request. */
  sessionId: string;
  context: TenantContext;
  database: AppDatabase;
  params: P;
};

const READ_METHODS = new Set(['GET', 'HEAD']);

/** Writes the audit record of a refusal. Failing to write it never changes what the caller hears. */
async function recordRefusal(
  error: unknown,
  who: { database: AppDatabase; userId?: string; organizationId?: string; context?: TenantContext },
) {
  try {
    if (error instanceof TenantAccessDenied && who.userId && who.organizationId) {
      await auditTenantRefusal(who.database, {
        userId: who.userId,
        organizationId: who.organizationId,
        surface: 'api',
      });
    } else if (isAuditedRefusal(error) && who.context) {
      await auditRefusal(who.database, who.context, {
        code: refusalCode(error),
        surface: 'api',
      });
    }
  } catch (failure) {
    apiLog.error('audit.refusal_failed', { errorCode: errorCode(failure) });
  }
}

/** Wraps a Route Handler. Anything it throws becomes a safe error in the documented shape. */
export function apiRoute<S extends z.ZodType<{ organizationId: string }>>(
  paramsSchema: S,
  handler: (scope: ApiScope<z.output<S>>) => Promise<Response>,
) {
  return async (request: Request, route: { params: Promise<Record<string, string>> }) => {
    const requestId = randomUUID();
    let response: Response;
    let who: Parameters<typeof recordRefusal>[1] | undefined;
    try {
      const { app, auth, config } = getRuntime();
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) throw unauthenticated();
      if (!READ_METHODS.has(request.method)) assertOwnOrigin(request, config.publicUrl);

      const params = paramsSchema.safeParse(await route.params);
      if (!params.success) throw invalidInput(params.error.issues);
      who = { database: app, userId: session.user.id, organizationId: params.data.organizationId };
      const context = await resolveTenantContext(app, session.user.id, params.data.organizationId);
      who = { ...who, context };
      // After the membership check, so nobody outside the tenant can learn it is being restored.
      await getRestoreGate().assertServing(context);
      response = await handler({
        request,
        requestId,
        userId: session.user.id,
        sessionId: session.session.id,
        context,
        database: app,
        params: params.data,
      });
    } catch (error) {
      if (who) await recordRefusal(error, who);
      response = toErrorResponse(error, requestId);
    }
    response.headers.set('X-Request-Id', requestId);
    // Tenant data never belongs in a shared cache.
    if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'no-store');
    return response;
  };
}

async function readLimited(request: Request): Promise<Uint8Array> {
  // The declared length is only a quick refusal. It can be absent or wrong, so the bytes are counted.
  if (Number(request.headers.get('content-length') ?? 0) > MAX_JSON_BYTES) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw invalidInput();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
}

/** Reads a JSON body: right type, bounded size, valid UTF-8 and JSON, and matching the schema. */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw wrongMediaType();
  const bytes = await readLimited(request);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalidInput();
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error.issues);
  return parsed.data;
}

/** Reads query values against a schema. Anything malformed is refused the same way as a body. */
export function readQuery<S extends z.ZodType>(request: Request, schema: S): z.output<S> {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw invalidInput(parsed.error.issues);
  return parsed.data;
}

/**
 * Reads the version from If-Match, as `"3"` or `3`. Weak tags, `*` and lists are refused: this check
 * only means something against one exact version.
 */
export function readIfMatch(request: Request): number {
  const header = request.headers.get('if-match');
  if (header === null) throw versionRequired();
  const version = Number(/^("?)([1-9]\d{0,9})\1$/.exec(header.trim())?.[2]);
  if (!Number.isInteger(version) || version > MAX_POSTGRES_INT) throw invalidInput();
  return version;
}

/** The version as an entity tag, which a client can send straight back in If-Match. */
export const etag = (version: number) => `"${version}"`;

const uuid = idSchema;
export const organizationParams = z.object({ organizationId: uuid });
export const workUnitParams = z.object({ organizationId: uuid, workUnitId: uuid });
export const approvalParams = z.object({ organizationId: uuid, approvalId: uuid });

/** The public shape of a Work Unit. Listed fields only: internal columns never leave this way. */
export function workUnitDto(row: {
  id: string;
  organizationId: string;
  title: string;
  objective: string | null;
  status: string;
  version: number;
  dueAt: Date | null;
}): WorkUnitDto {
  return {
    id: row.id,
    organization_id: row.organizationId,
    title: row.title,
    ...(row.objective !== null ? { objective: row.objective } : {}),
    status: row.status as WorkUnitDto['status'],
    version: row.version,
    due_at: row.dueAt?.toISOString() ?? null,
  };
}
