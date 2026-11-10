import 'server-only';
import { createHash } from 'node:crypto';
import {
  scimListUsers,
  scimGetUser,
  scimDeprovisionUser,
  scimReactivateUser,
  type ScimUser,
} from '@ensemus/application/sso';
import { idSchema } from '@ensemus/application';
import {
  bearer,
  createScimLimiter,
  listQuery,
  patchActive,
  SCIM_ERROR,
  SCIM_LIST,
  SCIM_USER,
} from '@/lib/scim';
import { getRuntime } from './runtime';

const limiter = createScimLimiter(),
  MAX_BODY = 16 * 1024;
function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/scim+json', 'cache-control': 'no-store' },
  });
}
const failure = (status: number, detail: string) =>
  response({ schemas: [SCIM_ERROR], status: String(status), detail }, status);
const unauthorized = () => failure(401, 'A current provisioning token is required.');
const user = (row: ScimUser) => ({
  schemas: [SCIM_USER],
  id: row.id,
  userName: row.userName,
  externalId: row.externalId,
  active: row.active,
});
async function json(request: Request): Promise<unknown> {
  const media = request.headers.get('content-type')?.split(';')[0]?.trim();
  if (!['application/scim+json', 'application/json'].includes(media ?? ''))
    throw new Error('MEDIA');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('BODY');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new Error('SIZE');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function handleScim(
  request: Request,
  membershipId?: string,
  unsupported = false,
): Promise<Response> {
  // Admission precedes all database access, including invalid/missing/unknown bearer values.
  const peer = (request.headers.get('x-forwarded-for') ?? 'unknown')
    .split(',')[0]!
    .trim()
    .slice(0, 200);
  const key = createHash('sha256').update(peer).digest('hex');
  if (!limiter.admit(key)) return failure(429, 'Too many provisioning requests. Try again later.');
  const token = bearer(request.headers);
  if (!token) return unauthorized();
  const hash = createHash('sha256').update(token).digest('hex');
  try {
    const { app } = getRuntime();
    if (
      unsupported ||
      !['GET', 'PATCH', 'DELETE'].includes(request.method) ||
      (!membershipId && request.method !== 'GET')
    ) {
      if ((await scimListUsers(app, hash, { startIndex: 1, count: 0 })) === null)
        return unauthorized();
      return failure(501, 'This provisioning operation is not supported.');
    }
    if (membershipId && !idSchema.safeParse(membershipId).success) {
      if ((await scimListUsers(app, hash, { startIndex: 1, count: 0 })) === null)
        return unauthorized();
      return failure(404, 'User not found.');
    }
    if (request.method === 'GET') {
      if (membershipId) {
        const row = await scimGetUser(app, hash, membershipId);
        return row === null
          ? unauthorized()
          : row === 'not_found'
            ? failure(404, 'User not found.')
            : response(user(row));
      }
      const input = listQuery(new URL(request.url));
      if (!input) {
        if ((await scimListUsers(app, hash, { startIndex: 1, count: 0 })) === null)
          return unauthorized();
        return failure(501, 'Only userName equality filters and bounded pagination are supported.');
      }
      const result = await scimListUsers(app, hash, input);
      return result === null
        ? unauthorized()
        : response({
            schemas: [SCIM_LIST],
            totalResults: result.total,
            startIndex: input.startIndex,
            itemsPerPage: result.users.length,
            Resources: result.users.map(user),
          });
    }
    // Check the token before parsing an operation so malformed requests cannot enumerate token state.
    if ((await scimListUsers(app, hash, { startIndex: 1, count: 0 })) === null)
      return unauthorized();
    let active = false;
    if (request.method === 'PATCH') {
      let body: unknown;
      try {
        body = await json(request);
      } catch (error) {
        return failure(
          error instanceof Error && error.message === 'SIZE' ? 413 : 400,
          'The provisioning request is invalid.',
        );
      }
      const parsed = patchActive(body);
      if (parsed === null) return failure(501, 'Only replacement of active is supported.');
      active = parsed;
    }
    const result = active
      ? await scimReactivateUser(app, hash, { membershipId: membershipId! })
      : await scimDeprovisionUser(app, hash, { membershipId: membershipId! });
    if (result === 'unauthorized') return unauthorized();
    if (result === 'not_found') return failure(404, 'User not found.');
    if (result === 'last_owner') return failure(409, 'The company must keep an active owner.');
    if (result === 'refused')
      return failure(409, 'This user cannot be reactivated by this provider.');
    if (request.method === 'DELETE')
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    const row = await scimGetUser(app, hash, membershipId!);
    return row === null
      ? unauthorized()
      : row === 'not_found'
        ? failure(404, 'User not found.')
        : response(user(row));
  } catch {
    return failure(500, 'Provisioning is temporarily unavailable.');
  }
}
