import { acceptInvitationSchema } from '@ensemus/contracts/federation';
import { organizationParams, readJson } from '@/server/api';
import {
  acceptGrantOnce,
  federationJson,
  federationRoute,
  grantDto,
} from '@/server/federation-api';

export const POST = federationRoute(organizationParams, async ({ database, context, request }) => {
  const body = await readJson(request, acceptInvitationSchema);
  return federationJson(
    grantDto(
      await acceptGrantOnce(database, context, request.headers.get('Idempotency-Key') ?? '', {
        token: body.token,
        termsHash: body.terms_hash,
      }),
    ),
    201,
  );
});
