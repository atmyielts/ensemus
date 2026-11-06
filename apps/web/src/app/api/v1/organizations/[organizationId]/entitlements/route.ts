import { getEntitlementsView } from '@ensemus/commercial';
import { apiRoute, organizationParams } from '@/server/api';

export const dynamic = 'force-dynamic';

/** This tenant's mode, features and capacities. The service checks `usage.view`. */
export const GET = apiRoute(organizationParams, async ({ context, database }) =>
  Response.json(await getEntitlementsView(database, context)),
);
