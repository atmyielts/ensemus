import { idSchema, listCrossings } from '@ensemus/application';
import { z } from 'zod';
import { organizationParams, readQuery } from '@/server/api';
import { crossingDto, federationJson, federationRoute } from '@/server/federation-api';

const query = z.strictObject({
  grant_id: idSchema.optional(),
  cursor: z.string().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const GET = federationRoute(organizationParams, async ({ database, context, request }) => {
  const input = readQuery(request, query);
  const { items, nextCursor } = await listCrossings(database, context, {
    ...(input.grant_id ? { grantId: input.grant_id } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit: input.limit,
  });
  return federationJson({ items: items.map(crossingDto), next_cursor: nextCursor });
});
