import { listListings } from '@ensemus/application';
import { apiRoute, organizationParams } from '@/server/api';
import { listingDto } from '@/server/marketplace-api';
import { getSkillFeatureGate } from '@/server/skill-runtime';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database, request }) => {
  const cursor = new URL(request.url).searchParams.get('cursor');
  const page = await listListings(
    database,
    context,
    getSkillFeatureGate(),
    cursor === null ? {} : { after: cursor },
  );
  return Response.json({ items: page.items.map(listingDto), next_cursor: page.nextCursor });
});
