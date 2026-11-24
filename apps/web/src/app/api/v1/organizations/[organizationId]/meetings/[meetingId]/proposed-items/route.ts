import { listProposedItems } from '@ensemus/application';
import { apiRoute } from '@/server/api';
import { meetingParams, meetingProposalDto } from '@/server/meeting-api';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(meetingParams, async ({ database, context, params }) => {
  const rows = await listProposedItems(database, context, params.meetingId);
  return Response.json({ items: rows.map(meetingProposalDto) });
});
