import { getMeeting } from '@ensemus/application';
import { apiRoute, etag } from '@/server/api';
import { meetingParams, meetingDto } from '@/server/meeting-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(meetingParams, async ({ database, context, params }) => {
  const row = await getMeeting(database, context, params.meetingId);
  return Response.json(meetingDto(row), { headers: { ETag: etag(row.version) } });
});
