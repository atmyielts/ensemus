import { proposeEmailActionSchema } from '@ensemus/contracts/external-actions';
import {
  apiRoute,
  etag,
  idempotencyKeyReused,
  proposeEmail,
  readJson,
  workUnitParams,
} from '@/server/api';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(workUnitParams, async ({ request, context, database, params }) => {
  const body = await readJson(request, proposeEmailActionSchema);
  const outcome = await proposeEmail(
    database,
    context,
    params.workUnitId,
    body,
    request.headers.get('idempotency-key') ?? '',
  );
  if (outcome.kind === 'conflict') throw idempotencyKeyReused();
  return Response.json(outcome.body, {
    status: outcome.status,
    // A new action is always at its first version.
    headers: { ETag: etag(1) },
  });
});
