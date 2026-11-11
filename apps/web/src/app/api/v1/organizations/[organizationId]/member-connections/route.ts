import { apiRoute, assertManagesConnections, organizationParams } from '@/server/api';
import { memberConnectionDtos } from '@/server/personal-connections';

export const dynamic = 'force-dynamic';

// Whose each is and its state, for those who manage connections. Nothing about what it reaches.
export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  assertManagesConnections(context);
  return Response.json({ items: await memberConnectionDtos(database, context) });
});
