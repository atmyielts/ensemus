import { AppError } from '@ensemus/application';
import { listSsoConnections, createSsoConnection } from '@ensemus/application/sso';
import { createSsoConnectionSchema } from '@ensemus/contracts/identity-admin';
import { parseSamlMetadata } from '@ensemus/auth/sso';
import { apiRoute, organizationParams, readJson } from '@/server/api';
import { getRuntime } from '@/server/runtime';
export const GET = apiRoute(organizationParams, async (scope) => {
  const rows = await listSsoConnections(scope.database, scope.context),
    runtime = getRuntime();
  return Response.json(
    {
      items: await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          provider_id: row.providerId,
          display_name: row.displayName,
          domain: row.domain,
          domain_state: row.domainState,
          state: row.state,
          auto_join: row.autoJoin,
          provider_ready: (await runtime.sso.status(row.providerId)).ready,
          version: row.version,
        })),
      ),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
});
export const POST = apiRoute(organizationParams, async (scope) => {
  const body = await readJson(scope.request, createSsoConnectionSchema),
    runtime = getRuntime();
  if (!parseSamlMetadata(body.idp_metadata_xml, runtime.config.publicUrl, 'validation'))
    throw new AppError('INVALID_INPUT');
  const row = await createSsoConnection(
    scope.database,
    scope.context,
    { sessionId: scope.sessionId },
    { displayName: body.display_name, domain: body.domain },
  );
  if (
    (await runtime.sso.storeProvider({
      providerId: row.providerId,
      domain: row.domain,
      idpMetadataXml: body.idp_metadata_xml,
    })) !== 'stored'
  )
    throw new AppError('INVALID_INPUT');
  return Response.json(
    {
      id: row.id,
      provider_id: row.providerId,
      display_name: row.displayName,
      domain: row.domain,
      domain_state: row.domainState,
      state: row.state,
      auto_join: row.autoJoin,
      provider_ready: false,
      version: row.version,
    },
    {
      status: 201,
      headers: {
        'cache-control': 'no-store',
        location: `/api/v1/organizations/${scope.context.organizationId}/sso-connections/${row.id}`,
      },
    },
  );
});
