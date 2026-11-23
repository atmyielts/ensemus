import { getMeetingSettings, updateMeetingSettings } from '@ensemus/application';
import { updateMeetingSettingsSchema } from '@ensemus/contracts/meetings';
import { apiRoute, organizationParams, readJson, readIfMatch, etag } from '@/server/api';
export const dynamic = 'force-dynamic';
const dto = (row: Awaited<ReturnType<typeof getMeetingSettings>>) => ({
  enabled: row.enabled,
  notice_ref: row.noticeRef,
  version: row.version,
});
export const GET = apiRoute(organizationParams, async ({ database, context }) => {
  const row = await getMeetingSettings(database, context);
  return Response.json(dto(row), { headers: { ETag: etag(row.version) } });
});
export const PATCH = apiRoute(organizationParams, async ({ database, context, request }) => {
  const expectedVersion = readIfMatch(request),
    body = await readJson(request, updateMeetingSettingsSchema);
  const row = await updateMeetingSettings(database, context, {
    expectedVersion,
    enabled: body.enabled,
    noticeRef: body.notice_ref,
  });
  return Response.json(dto(row), { headers: { ETag: etag(row.version) } });
});
