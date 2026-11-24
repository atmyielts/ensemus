// A member's own connections (ADR-038 D5). Its own route rather than the organization's start with an
// owner: that one refuses anyone without connection.manage before it reads a body, so an admin's client
// secret never reaches a process for someone refused, and a member's body has no client or settings at
// all. Both end in the same startAuthorization and the same callback.
import { apiRoute, organizationParams, readJson } from '@/server/api';
import { oauthBrowserCookie } from '@/server/oauth';
import {
  beginMyConnection,
  myConnectionDtos,
  startMyConnectionSchema,
} from '@/server/personal-connections';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) =>
  Response.json({ items: await myConnectionDtos(database, context) }),
);

export const POST = apiRoute(organizationParams, async ({ request, context, database }) => {
  const body = await readJson(request, startMyConnectionSchema);
  const { started, browserBinding } = await beginMyConnection(database, context, body);
  // Bound to the browser that started it, as an admin's consent is (ADR-038 D1).
  return Response.json(started, {
    status: 201,
    headers: { 'Set-Cookie': oauthBrowserCookie(browserBinding), 'Cache-Control': 'no-store' },
  });
});
