import { getLicenseStatus } from '@ensemus/application';
import { apiRoute, organizationParams } from '@/server/api';
import { licenseStatusDto } from '@/server/sovereign-dto';
import { getSovereignRuntime } from '@/server/sovereign-runtime';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  const { trustRoot, runningRelease } = getSovereignRuntime();
  const status = await getLicenseStatus(database, context, { trustRoot, runningRelease });
  return Response.json(licenseStatusDto(status));
});
