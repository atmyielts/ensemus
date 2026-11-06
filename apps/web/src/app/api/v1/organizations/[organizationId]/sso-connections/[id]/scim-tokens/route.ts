import { z } from 'zod';
import { AppError, idSchema } from '@ensemus/application';
import { listSsoConnections, listScimTokens, issueScimToken } from '@ensemus/application/sso';
import { apiRoute, organizationParams, readJson } from '@/server/api';
const params = organizationParams.extend({ id: idSchema });
export const GET = apiRoute(params, async (scope) => {
  if (
    !(await listSsoConnections(scope.database, scope.context)).some(
      (row) => row.id === scope.params.id,
    )
  )
    throw new AppError('NOT_FOUND');
  const tokens = (await listScimTokens(scope.database, scope.context)).filter(
    (token) => token.connectionId === scope.params.id,
  );
  return Response.json(
    {
      items: tokens.map((token) => ({
        id: token.id,
        state: token.state,
        created_at: token.createdAt.toISOString(),
        last_used_at: token.lastUsedAt?.toISOString() ?? null,
      })),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
});
export const POST = apiRoute(params, async (scope) => {
  await readJson(scope.request, z.strictObject({}));
  const result = await issueScimToken(
    scope.database,
    scope.context,
    { sessionId: scope.sessionId },
    { connectionId: scope.params.id },
  );
  return Response.json(
    { token_id: result.tokenId, token: result.token },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  );
});
