import { getInboundItem } from '@ensemus/application';
import {
  federationItemParams,
  federationJson,
  federationRoute,
  inboundItemDto,
} from '@/server/federation-api';

export const GET = federationRoute(federationItemParams, async ({ database, context, params }) =>
  federationJson(inboundItemDto(await getInboundItem(database, context, params.federationItemId))),
);
