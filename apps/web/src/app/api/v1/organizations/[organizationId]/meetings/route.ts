import { createMeeting, getMeeting, listMeetings } from '@ensemus/application';
import { createMeetingSchema } from '@ensemus/contracts/meetings';
import { z } from 'zod';
import { apiRoute, organizationParams, readJson, readQuery, etag } from '@/server/api';
import { meetingDto, meetingSummaryDto } from '@/server/meeting-api';
import { studioOnce } from '@/server/studio-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(organizationParams, async ({ database, context, request }) => {
  const q = readQuery(request, z.strictObject({ cursor: z.string().min(1).max(512).optional() })),
    page = await listMeetings(database, context, q.cursor ? { after: q.cursor } : {});
  return Response.json({ items: page.items.map(meetingSummaryDto), next_cursor: page.nextCursor });
});
export const POST = apiRoute(organizationParams, async ({ database, context, request }) => {
  const body = await readJson(request, createMeetingSchema),
    id = await studioOnce(
      database,
      context,
      request.headers.get('idempotency-key') ?? '',
      'meeting.create',
      body,
      (db) =>
        createMeeting(db, context, {
          title: body.title,
          occurredAt: new Date(body.occurred_at),
          ...(body.classification === undefined ? {} : { classification: body.classification }),
        }),
    );
  const row = await getMeeting(database, context, id);
  return Response.json(meetingDto(row), { status: 201, headers: { ETag: etag(row.version) } });
});
