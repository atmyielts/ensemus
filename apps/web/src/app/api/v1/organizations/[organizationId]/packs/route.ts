import { listPackCatalog } from '@ensemus/application/packs';
import { apiRoute, organizationParams } from '@/server/api';
import { catalogEntryDto } from '../pack-installations/dto';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  const entries = await listPackCatalog(database, context);
  return Response.json({ items: entries.map(catalogEntryDto), next: null });
});
