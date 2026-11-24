import { listOutboundItems, publishItem } from '@ensemus/application';
import { publishItemSchema } from '@ensemus/contracts/federation';
import { readJson } from '@/server/api';
import {
  federationJson,
  federationRoute,
  grantParams,
  outboundItemDto,
} from '@/server/federation-api';
import { getStore } from '@/server/runtime';

export const GET = federationRoute(grantParams, async ({ database, context, params }) =>
  federationJson({
    items: (await listOutboundItems(database, context, params)).map(outboundItemDto),
  }),
);

export const POST = federationRoute(grantParams, async ({ database, context, params, request }) => {
  const item = await readJson(request, publishItemSchema);
  const published = await publishItem(database, getStore(), context, {
    grantId: params.grantId,
    item,
    requestKey: request.headers.get('Idempotency-Key') ?? '',
  });
  return federationJson(outboundItemDto(published), 201);
});
