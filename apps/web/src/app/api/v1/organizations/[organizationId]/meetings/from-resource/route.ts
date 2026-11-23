import { createMeetingFromResource, getMeeting } from '@ensemus/application';
import { createMeetingFromResourceSchema } from '@ensemus/contracts/meetings';
import { apiRoute, organizationParams, readJson, etag } from '@/server/api';
import { meetingDto } from '@/server/meeting-api';
import { studioOnce } from '@/server/studio-api';

export const POST = apiRoute(organizationParams, async ({ database, context, request }) => {
  const body = await readJson(request, createMeetingFromResourceSchema);
  const id = await studioOnce(
    database,
    context,
    request.headers.get('idempotency-key') ?? '',
    'meeting.create_from_source',
    body,
    (db) =>
      createMeetingFromResource(db, context, {
        resourceId: body.resource_id,
        title: body.title,
        occurredAt: new Date(body.occurred_at),
        ...(body.classification === undefined ? {} : { classification: body.classification }),
      }),
  );
  const meeting = await getMeeting(database, context, id);
  return Response.json(meetingDto(meeting), {
    status: 201,
    headers: { ETag: etag(meeting.version) },
  });
});
