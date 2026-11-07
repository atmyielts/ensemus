import { getOrganizationExport } from '@ensemus/application';
import { apiRoute } from '@/server/api';
import { exportParams, organizationExportDto } from '@/server/sovereign-dto';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(exportParams, async ({ context, database, params }) => {
  const found = await getOrganizationExport(database, context, params.exportId);
  return Response.json(organizationExportDto(found));
});
