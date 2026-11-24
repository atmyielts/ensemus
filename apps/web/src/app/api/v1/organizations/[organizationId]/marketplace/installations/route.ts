import { listInstallations } from '@ensemus/application';
import { apiRoute, organizationParams } from '@/server/api';
import { installationDto, requireMarketplace } from '@/server/marketplace-api';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  await requireMarketplace(context);
  return Response.json({
    items: (await listInstallations(database, context)).map(installationDto),
  });
});
