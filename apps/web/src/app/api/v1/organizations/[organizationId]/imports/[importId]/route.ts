import { getOrganizationImport } from '@ensemus/application';
import { apiRoute } from '@/server/api';
import { importParams, organizationImportDto } from '@/server/sovereign-dto';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(importParams, async ({ context, database, params }) => {
  const found = await getOrganizationImport(database, context, params.importId);
  return Response.json(organizationImportDto(found));
});
