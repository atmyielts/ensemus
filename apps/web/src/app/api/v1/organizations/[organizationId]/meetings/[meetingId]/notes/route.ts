import { importNotesSchema } from '@ensemus/contracts/meetings';
import { apiRoute, readJson } from '@/server/api';
import { meetingParams, importNotesOnce } from '@/server/meeting-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(meetingParams, async ({ database, context, params, request }) => {
  const body = await readJson(request, importNotesSchema, 4 * 1024 * 1024);
  return Response.json(
    await importNotesOnce(
      database,
      context,
      params.meetingId,
      body.text,
      request.headers.get('idempotency-key') ?? '',
    ),
    { status: 201 },
  );
});
