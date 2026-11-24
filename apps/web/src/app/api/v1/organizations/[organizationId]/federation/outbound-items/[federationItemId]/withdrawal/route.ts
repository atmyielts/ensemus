import { withdrawItem } from '@ensemus/application';
import { readIfMatch } from '@/server/api';
import {
  federationItemParams,
  federationJson,
  federationRoute,
  outboundItemDto,
} from '@/server/federation-api';

export const POST = federationRoute(
  federationItemParams,
  async ({ database, context, params, request }) => {
    const item = await withdrawItem(database, context, {
      itemId: params.federationItemId,
      expectedVersion: readIfMatch(request),
    });
    return federationJson(outboundItemDto(item));
  },
);
