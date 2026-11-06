import { addWebhookEndpoint, apiRoute, connectionParams } from '@/server/api';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(connectionParams, async ({ context, database, params }) => {
  const created = await addWebhookEndpoint(database, context, params.connectionId);
  // Holds the only copy of the token and of the secret, so nothing may keep this response.
  return Response.json(created, { status: 201, headers: { 'Cache-Control': 'no-store' } });
});
