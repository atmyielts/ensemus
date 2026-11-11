import { listAuthorizations } from '@ensemus/application';
import { startOAuthAuthorizationSchema } from '@ensemus/contracts/workspace-suites';
import { apiRoute, assertManagesConnections, organizationParams, readJson } from '@/server/api';
import { beginAuthorization, oauthAuthorizationDto } from '@/server/oauth';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  assertManagesConnections(context);
  const rows = await listAuthorizations(database, context);
  return Response.json({ items: rows.map(oauthAuthorizationDto) });
});

export const POST = apiRoute(organizationParams, async ({ request, context, database }) => {
  // Before the body is read, so someone refused never has a customer's client secret in this process.
  assertManagesConnections(context);
  const body = await readJson(request, startOAuthAuthorizationSchema);
  const started = await beginAuthorization(database, context, body);
  return Response.json(started, { status: 201 });
});
