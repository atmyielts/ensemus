import { reassignMeetingOrganizer } from '@ensemus/application';
import { reassignOrganizerSchema } from '@ensemus/contracts/meetings';
import { apiRoute, readIfMatch, readJson } from '@/server/api';
import { meetingParams } from '@/server/meeting-api';

export const dynamic = 'force-dynamic';
export const POST = apiRoute(meetingParams, async ({ database, context, params, request }) => {
  const expectedVersion = readIfMatch(request);
  const body = await readJson(request, reassignOrganizerSchema);
  await reassignMeetingOrganizer(database, context, {
    meetingId: params.meetingId,
    expectedVersion,
    organizerMembershipId: body.organizer_membership_id,
  });
  return new Response(null, { status: 204 });
});
