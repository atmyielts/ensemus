import { listAdvisories } from '@ensemus/application';
import { apiRoute, organizationParams } from '@/server/api';
import { advisoryDto } from '@/server/sovereign-dto';
import { getSovereignRuntime } from '@/server/sovereign-runtime';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  const { trustRoot, runningRelease } = getSovereignRuntime();
  const advisories = await listAdvisories(database, context, { trustRoot, runningRelease });
  return Response.json({ items: advisories.map(advisoryDto) });
});
