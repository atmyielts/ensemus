import { rejectProposedItem } from '@ensemus/application';
import { decideProposedItemSchema } from '@ensemus/contracts/meetings';
import { apiRoute, readIfMatch, readJson } from '@/server/api';
import { meetingItemParams } from '@/server/meeting-api';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(meetingItemParams, async ({ database, context, params, request }) => {
  const expectedVersion = readIfMatch(request);
  const body = await readJson(request, decideProposedItemSchema);
  return Response.json(
    await rejectProposedItem(database, context, {
      itemId: params.itemId,
      expectedVersion,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    }),
  );
});
