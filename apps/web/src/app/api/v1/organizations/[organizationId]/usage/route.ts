import { getUsageSummary } from '@ensemus/application/ai-budget';
import { z } from 'zod';
import { apiRoute, organizationParams, readQuery } from '@/server/api';

export const dynamic = 'force-dynamic';

const usageQuery = z.object({ period: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/) });

/** One month's measured usage. The service checks `usage.view`. BYOM figures are labelled estimates. */
export const GET = apiRoute(organizationParams, async ({ request, context, database }) => {
  const { period } = readQuery(request, usageQuery);
  return Response.json(await getUsageSummary(database, context, { period }));
});
