import { listOrganizationExports, requestOrganizationExport } from '@ensemus/application';
import { requestExportSchema } from '@ensemus/contracts/sovereign';
import { apiRoute, organizationParams, readJson } from '@/server/api';
import { organizationExportDto } from '@/server/sovereign-dto';
import { getSovereignRuntime } from '@/server/sovereign-runtime';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  const exports = await listOrganizationExports(database, context);
  return Response.json({ items: exports.map(organizationExportDto) });
});

// This only commits the request. The worker makes the archive, so nothing heavy runs in the web tier.
export const POST = apiRoute(organizationParams, async ({ request, context, database }) => {
  const body = await readJson(request, requestExportSchema);
  const requested = await requestOrganizationExport(database, context, {
    recipientPublicKey: body.recipient_public_key,
    sourceRelease: getSovereignRuntime().sourceRelease,
  });
  return Response.json(organizationExportDto(requested), { status: 202 });
});
