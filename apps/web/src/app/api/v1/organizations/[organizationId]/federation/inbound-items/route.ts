import { listInboundItems } from '@ensemus/application';
import { federationDispositionSchema } from '@ensemus/contracts/federation';
import { z } from 'zod';
import { organizationParams, readQuery } from '@/server/api';
import { federationJson, federationRoute, inboundItemDto } from '@/server/federation-api';

const query = z.strictObject({ disposition: federationDispositionSchema.optional() });

export const GET = federationRoute(organizationParams, async ({ database, context, request }) => {
  const { disposition } = readQuery(request, query);
  const items = await listInboundItems(database, context, disposition ? { disposition } : {});
  return federationJson({ items: items.map(inboundItemDto) });
});
