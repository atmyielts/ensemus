import { installSignedDocument } from '@ensemus/application';
import { installSignedDocumentSchema } from '@ensemus/contracts/sovereign';
import { apiRoute, organizationParams, readJson } from '@/server/api';
import { installedDocumentDto } from '@/server/sovereign-dto';
import { getSovereignRuntime } from '@/server/sovereign-runtime';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(organizationParams, async ({ request, context, database }) => {
  const body = await readJson(request, installSignedDocumentSchema);
  const { trustRoot } = getSovereignRuntime();
  const installed = await installSignedDocument(database, context, body, { trustRoot });
  return Response.json(installedDocumentDto(installed), { status: installed.created ? 201 : 200 });
});
