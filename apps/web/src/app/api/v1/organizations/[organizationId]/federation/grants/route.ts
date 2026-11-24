import { listGrants } from '@ensemus/application';
import { proposeGrantSchema } from '@ensemus/contracts/federation';
import { organizationParams, readJson } from '@/server/api';
import {
  federationJson,
  federationRoute,
  grantDto,
  proposeGrantOnce,
} from '@/server/federation-api';

export const GET = federationRoute(organizationParams, async ({ database, context }) =>
  federationJson({ items: (await listGrants(database, context)).map(grantDto) }),
);

export const POST = federationRoute(organizationParams, async ({ database, context, request }) => {
  const body = await readJson(request, proposeGrantSchema);
  const result = await proposeGrantOnce(
    database,
    context,
    request.headers.get('Idempotency-Key') ?? '',
    {
      purpose: body.purpose,
      maxClassification: body.max_classification,
      expiresInDays: body.expires_in_days,
      invitationExpiresInDays: body.invitation_expires_in_days,
      note: body.note ?? null,
    },
  );
  return federationJson({ grant: grantDto(result.grant), token: result.token }, 201);
});
