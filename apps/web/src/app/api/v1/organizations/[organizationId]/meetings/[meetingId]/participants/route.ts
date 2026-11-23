import { addMeetingParticipant } from '@ensemus/application';
import { addParticipantSchema } from '@ensemus/contracts/meetings';
import { apiRoute, readJson, readIfMatch } from '@/server/api';
import { meetingParams, meetingParticipantDto } from '@/server/meeting-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(meetingParams, async ({ database, context, params, request }) => {
  const expectedVersion = readIfMatch(request),
    body = await readJson(request, addParticipantSchema);
  const row = await addMeetingParticipant(database, context, {
    meetingId: params.meetingId,
    expectedVersion,
    participant:
      body.kind === 'member'
        ? { kind: 'member', membershipId: body.membership_id }
        : { kind: 'external', label: body.label },
  });
  return Response.json(meetingParticipantDto(row), { status: 201 });
});
