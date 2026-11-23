import { listMeetingDerivations } from '@ensemus/application';
import { requestDerivationSchema } from '@ensemus/contracts/meetings';
import { apiRoute, readJson } from '@/server/api';
import { meetingDerivationDto, meetingParams, requestDerivationOnce } from '@/server/meeting-api';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(meetingParams, async ({ database, context, params }) => {
  const items = await listMeetingDerivations(database, context, params.meetingId);
  return Response.json({ items: items.map(meetingDerivationDto) });
});

export const POST = apiRoute(meetingParams, async ({ database, context, params, request }) => {
  const body = await readJson(request, requestDerivationSchema);
  const run = await requestDerivationOnce(
    database,
    context,
    request.headers.get('idempotency-key') ?? '',
    params.meetingId,
    body,
  );
  return Response.json(meetingDerivationDto(run), { status: 202 });
});
