import { acceptProposedWorkSchema } from '@ensemus/contracts/meetings';
import { apiRoute, readIfMatch, readJson } from '@/server/api';
import { acceptProposedWorkOnce, meetingItemParams } from '@/server/meeting-api';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(meetingItemParams, async ({ database, context, params, request }) => {
  const expectedVersion = readIfMatch(request);
  const body = await readJson(request, acceptProposedWorkSchema);
  const result = await acceptProposedWorkOnce(
    database,
    context,
    request.headers.get('idempotency-key') ?? '',
    params.itemId,
    expectedVersion,
    body,
  );
  return Response.json(result, { status: 201 });
});
