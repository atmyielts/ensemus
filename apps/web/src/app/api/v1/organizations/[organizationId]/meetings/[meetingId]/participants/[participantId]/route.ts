import { removeMeetingParticipant } from '@ensemus/application';
import { apiRoute, readIfMatch } from '@/server/api';
import { participantParams } from '@/server/meeting-api';
export const dynamic = 'force-dynamic';
export const DELETE = apiRoute(
  participantParams,
  async ({ database, context, params, request }) => {
    await removeMeetingParticipant(database, context, {
      meetingId: params.meetingId,
      participantId: params.participantId,
      expectedVersion: readIfMatch(request),
    });
    return new Response(null, { status: 204 });
  },
);
