import { revokeMyConnection } from '@ensemus/application/suite-settings';
import { apiRoute, connectionParams } from '@/server/api';

export const dynamic = 'force-dynamic';

// The owner, or an admin with connection.manage. revokeMyConnection decides which, and anyone else hears
// that it does not exist. No If-Match: revoking is final, and a second revoke is refused as not active.
export const DELETE = apiRoute(connectionParams, async ({ context, database, params }) => {
  await revokeMyConnection(database, context, { connectionId: params.connectionId });
  return new Response(null, { status: 204 });
});
