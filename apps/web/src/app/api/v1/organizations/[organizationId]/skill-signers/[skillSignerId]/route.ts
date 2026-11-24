import { revokeTrustedSigner, idSchema } from '@ensemus/application';
import { apiRoute, organizationParams, readIfMatch } from '@/server/api';
export const dynamic = 'force-dynamic';
const paramsSchema = organizationParams.extend({ skillSignerId: idSchema });
export const DELETE = apiRoute(paramsSchema, async ({ request, context, database, params }) => {
  await revokeTrustedSigner(database, context, {
    signerId: params.skillSignerId,
    expectedVersion: readIfMatch(request),
  });
  return new Response(null, { status: 204 });
});
