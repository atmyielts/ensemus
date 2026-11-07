import { AppError, idSchema } from '@ensemus/application';
import { listSsoConnections, updateSsoConnection } from '@ensemus/application/sso';
import { updateSsoConnectionSchema } from '@ensemus/contracts/identity-admin';
import { apiRoute, organizationParams, readJson, readIfMatch, etag } from '@/server/api';
import { getRuntime } from '@/server/runtime';
const params = organizationParams.extend({ ssoConnectionId: idSchema });
export const GET = apiRoute(params, async (scope) => {
  const rows = await listSsoConnections(scope.database, scope.context),
    row = rows.find((item) => item.id === scope.params.ssoConnectionId);
  if (!row) throw new AppError('NOT_FOUND');
  return Response.json(
    {
      id: row.id,
      provider_id: row.providerId,
      display_name: row.displayName,
      domain: row.domain,
      domain_state: row.domainState,
      state: row.state,
      auto_join: row.autoJoin,
      provider_ready: (await getRuntime().sso.status(row.providerId)).ready,
      version: row.version,
    },
    { headers: { etag: etag(row.version), 'cache-control': 'no-store' } },
  );
});
export const PATCH = apiRoute(params, async (scope) => {
  const body = await readJson(scope.request, updateSsoConnectionSchema),
    row = await updateSsoConnection(
      scope.database,
      scope.context,
      { sessionId: scope.sessionId },
      {
        connectionId: scope.params.ssoConnectionId,
        expectedVersion: readIfMatch(scope.request),
        ...(body.display_name === undefined ? {} : { displayName: body.display_name }),
        ...(body.state === undefined ? {} : { state: body.state }),
        ...(body.auto_join === undefined ? {} : { autoJoin: body.auto_join }),
      },
      { providerReady: async (providerId) => (await getRuntime().sso.status(providerId)).ready },
    );
  return Response.json(
    {
      id: row.id,
      provider_id: row.providerId,
      display_name: row.displayName,
      domain: row.domain,
      domain_state: row.domainState,
      state: row.state,
      auto_join: row.autoJoin,
      provider_ready: (await getRuntime().sso.status(row.providerId)).ready,
      version: row.version,
    },
    { headers: { etag: etag(row.version), 'cache-control': 'no-store' } },
  );
});
