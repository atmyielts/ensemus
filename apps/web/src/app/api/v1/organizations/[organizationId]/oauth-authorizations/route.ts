import { listAuthorizations } from '@ensemus/application';
import { startOAuthAuthorizationSchema } from '@ensemus/contracts/workspace-suites';
import { apiRoute, assertManagesConnections, organizationParams, readJson } from '@/server/api';
import { beginAuthorization, oauthAuthorizationDto, oauthBrowserCookie } from '@/server/oauth';

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
  const { started, browserBinding } = await beginAuthorization(database, context, body);
  // The callback is bound to the browser that started the consent, as well as to the member. A client
  // calling this with JSON must open `authorize_url` in the browser that received this response, with
  // this cookie, or the callback answers OAUTH_STATE_INVALID.
  return Response.json(started, {
    status: 201,
    headers: { 'Set-Cookie': oauthBrowserCookie(browserBinding), 'Cache-Control': 'no-store' },
  });
});
