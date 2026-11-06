import { listConnections } from '@ensemus/application';
import { createConnectionSchema } from '@ensemus/contracts/external-actions';
import {
  addConnection,
  apiRoute,
  assertManagesConnections,
  connectionDto,
  etag,
  idempotencyKeyReused,
  organizationParams,
  readJson,
} from '@/server/api';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  assertManagesConnections(context);
  const rows = await listConnections(database, context);
  return Response.json({ items: rows.map(connectionDto) });
});

export const POST = apiRoute(organizationParams, async ({ request, context, database }) => {
  // Before the body is read, so someone refused never has their credential in this process for long.
  assertManagesConnections(context);
  const body = await readJson(request, createConnectionSchema);
  const outcome = await addConnection(
    database,
    context,
    body,
    request.headers.get('idempotency-key') ?? '',
  );
  if (outcome.kind === 'conflict') throw idempotencyKeyReused();
  const { version } = outcome.body as { version: number };
  return Response.json(outcome.body, {
    status: outcome.status,
    headers: { ETag: etag(version) },
  });
});
