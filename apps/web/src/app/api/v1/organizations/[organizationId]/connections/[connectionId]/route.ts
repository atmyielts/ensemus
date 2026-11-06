import { getConnection, revokeConnection } from '@ensemus/application';
import {
  apiRoute,
  assertManagesConnections,
  connectionDto,
  connectionParams,
  etag,
  readIfMatch,
} from '@/server/api';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(connectionParams, async ({ context, database, params }) => {
  assertManagesConnections(context);
  const row = await getConnection(database, context, params.connectionId);
  return Response.json(connectionDto(row), { headers: { ETag: etag(row.version) } });
});

export const DELETE = apiRoute(connectionParams, async ({ request, context, database, params }) => {
  assertManagesConnections(context);
  const expectedVersion = readIfMatch(request);
  await revokeConnection(database, context, {
    connectionId: params.connectionId,
    expectedVersion,
  });
  return new Response(null, { status: 204 });
});
