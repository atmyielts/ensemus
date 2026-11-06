import { AppError, idSchema } from '@ensemus/application';
import { listScimTokens, revokeScimToken } from '@ensemus/application/sso';
import { apiRoute, organizationParams } from '@/server/api';
const params = organizationParams.extend({ ssoConnectionId: idSchema, scimTokenId: idSchema });
export const DELETE = apiRoute(params, async (scope) => {
  if (
    !(await listScimTokens(scope.database, scope.context)).some(
      (row) => row.id === scope.params.scimTokenId && row.connectionId === scope.params.ssoConnectionId,
    )
  )
    throw new AppError('NOT_FOUND');
  await revokeScimToken(
    scope.database,
    scope.context,
    { sessionId: scope.sessionId },
    { tokenId: scope.params.scimTokenId },
  );
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
});
