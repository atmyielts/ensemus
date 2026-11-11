import { getAuthorization, idSchema } from '@ensemus/application';
import { z } from 'zod';
import { apiRoute } from '@/server/api';
import { oauthAuthorizationDto } from '@/server/oauth';

export const dynamic = 'force-dynamic';

const authorizationParams = z.object({ organizationId: idSchema, authorizationId: idSchema });

// Those who manage connections, or the person who started this attempt. The service decides, and anyone
// else hears that it does not exist.
export const GET = apiRoute(authorizationParams, async ({ context, database, params }) => {
  const row = await getAuthorization(database, context, {
    authorizationId: params.authorizationId,
  });
  return Response.json(oauthAuthorizationDto(row));
});
