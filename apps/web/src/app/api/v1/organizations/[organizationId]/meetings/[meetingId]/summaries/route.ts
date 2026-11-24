import { listMeetingSummaries } from '@ensemus/application';
import { apiRoute } from '@/server/api';
import { meetingParams, meetingSummaryTextDto } from '@/server/meeting-api';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(meetingParams, async ({ database, context, params }) => {
  const rows = await listMeetingSummaries(database, context, params.meetingId);
  return Response.json({ items: rows.map(meetingSummaryTextDto) });
});
