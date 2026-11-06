import { z } from 'zod';
import { AppError, idSchema } from '@ensemus/application';
import { prepareSsoMetadata } from '@ensemus/application/sso';
import { parseSamlMetadata } from '@ensemus/auth/sso';
import { apiRoute, organizationParams, readJson, readIfMatch, etag } from '@/server/api';
import { getRuntime } from '@/server/runtime';
const params = organizationParams.extend({ id: idSchema }),
  bodySchema = z.strictObject({ idp_metadata_xml: z.string().min(1).max(200000) });
export const PUT = apiRoute(params, async (scope) => {
  const body = await readJson(scope.request, bodySchema),
    runtime = getRuntime();
  if (!parseSamlMetadata(body.idp_metadata_xml, runtime.config.publicUrl, 'validation'))
    throw new AppError('INVALID_INPUT');
  const row = await prepareSsoMetadata(
    scope.database,
    scope.context,
    { sessionId: scope.sessionId },
    { connectionId: scope.params.id, expectedVersion: readIfMatch(scope.request) },
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
      state: row.state,
      provider_ready: (await runtime.sso.status(row.providerId)).ready,
      version: row.version,
    },
    { headers: { etag: etag(row.version), 'cache-control': 'no-store' } },
  );
});
