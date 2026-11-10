import { requestOrganizationImport } from '@ensemus/application';
import { apiRoute, organizationParams } from '@/server/api';
import { organizationImportDto } from '@/server/sovereign-dto';

export const dynamic = 'force-dynamic';

// No bytes and no key come through here. This records that the organization is to take an archive, and an
// operator runs the import itself on their own machine (ADR-030 D8).
export const POST = apiRoute(organizationParams, async ({ context, database }) => {
  const requested = await requestOrganizationImport(database, context);
  return Response.json(organizationImportDto(requested), { status: 201 });
});
