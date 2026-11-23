import { recordMeetingConsent } from '@ensemus/application';
import { recordConsentSchema } from '@ensemus/contracts/meetings';
import { apiRoute, readJson } from '@/server/api';
import { participantParams } from '@/server/meeting-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(participantParams, async ({ database, context, params, request }) => {
  const body = await readJson(request, recordConsentSchema);
  return Response.json(
    await recordMeetingConsent(database, context, {
      meetingId: params.meetingId,
      participantId: params.participantId,
      decision: body.decision,
      noticeRef: body.notice_ref,
    }),
  );
});
