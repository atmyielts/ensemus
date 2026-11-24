import { getGrant } from '@ensemus/application';
import { federationJson, federationRoute, grantDto, grantParams } from '@/server/federation-api';

export const GET = federationRoute(grantParams, async ({ database, context, params }) =>
  federationJson(grantDto(await getGrant(database, context, params.grantId))),
);
