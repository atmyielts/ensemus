import { confirmGrant } from '@ensemus/application';
import { confirmGrantSchema } from '@ensemus/contracts/federation';
import { readJson } from '@/server/api';
import { federationJson, federationRoute, grantDto, grantParams } from '@/server/federation-api';

export const POST = federationRoute(grantParams, async ({ database, context, params, request }) => {
  const body = await readJson(request, confirmGrantSchema);
  return federationJson(
    grantDto(
      await confirmGrant(database, context, {
        grantId: params.grantId,
        termsHash: body.terms_hash,
        expectedVersion: body.expected_version,
      }),
    ),
  );
});
