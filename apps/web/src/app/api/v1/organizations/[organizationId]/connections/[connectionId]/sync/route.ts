import { requestConnectorSync } from '@ensemus/application';
import {
  apiRoute,
  assertConnectorsEnabled,
  assertManagesConnections,
  connectionParams,
} from '@/server/api';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(connectionParams, async ({ context, database, params }) => {
  assertManagesConnections(context);
  assertConnectorsEnabled();
  await requestConnectorSync(database, context, { connectionId: params.connectionId });
  return new Response(null, { status: 202 });
});
