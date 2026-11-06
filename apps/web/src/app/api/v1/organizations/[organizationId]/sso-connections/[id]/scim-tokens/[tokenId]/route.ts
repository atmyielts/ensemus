import { AppError, idSchema } from '@ensemus/application';
import { listScimTokens, revokeScimToken } from '@ensemus/application/sso';
import { apiRoute, organizationParams } from '@/server/api';
const params = organizationParams.extend({ id: idSchema, tokenId: idSchema });
export const DELETE = apiRoute(params, async (scope) => {
  if (
    !(await listScimTokens(scope.database, scope.context)).some(
      (row) => row.id === scope.params.tokenId && row.connectionId === scope.params.id,
    )
  )
    throw new AppError('NOT_FOUND');
  await revokeScimToken(
    scope.database,
    scope.context,
    { sessionId: scope.sessionId },
    { tokenId: scope.params.tokenId },
  );
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
});
