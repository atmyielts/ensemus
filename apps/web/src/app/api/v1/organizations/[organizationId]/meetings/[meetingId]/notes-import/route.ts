import { requestNotesImportSchema } from '@ensemus/contracts/meetings';
import { apiRoute, readJson } from '@/server/api';
import { meetingParams, requestNotesImportOnce } from '@/server/meeting-api';

export const POST = apiRoute(meetingParams, async ({ database, context, request, params }) => {
  const { meetingId } = params;
  const body = await readJson(request, requestNotesImportSchema);
  const row = await requestNotesImportOnce(
    database,
    context,
    request.headers.get('idempotency-key') ?? '',
    meetingId,
    body,
  );
  return Response.json(
    {
      id: row.id,
      meeting_id: row.meetingId,
      status: row.status,
      status_code: row.statusCode,
      created_at: row.createdAt.toISOString(),
      finished_at: row.finishedAt?.toISOString() ?? null,
    },
    { status: 202 },
  );
});
