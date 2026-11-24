import { endGrant } from '@ensemus/application';
import { endGrantSchema } from '@ensemus/contracts/federation';
import { readJson } from '@/server/api';
import { federationJson, federationRoute, grantDto, grantParams } from '@/server/federation-api';

export const POST = federationRoute(grantParams, async ({ database, context, params, request }) => {
  const body = await readJson(request, endGrantSchema);
  return federationJson(
    grantDto(
      await endGrant(database, context, {
        grantId: params.grantId,
        reason: body.reason,
        expectedVersion: body.expected_version,
      }),
    ),
  );
});
