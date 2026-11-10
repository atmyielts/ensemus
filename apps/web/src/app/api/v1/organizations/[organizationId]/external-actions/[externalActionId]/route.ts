import { getExternalActionDetail } from '@ensemus/application';
import { apiRoute, etag, externalActionDto, externalActionParams } from '@/server/api';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(externalActionParams, async ({ context, database, params }) => {
  const detail = await getExternalActionDetail(database, context, params.externalActionId);
  return Response.json(externalActionDto(detail), { headers: { ETag: etag(detail.version) } });
});
