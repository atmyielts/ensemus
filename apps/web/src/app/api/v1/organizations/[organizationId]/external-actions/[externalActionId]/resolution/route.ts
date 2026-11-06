import { getExternalActionDetail, resolveUnknownExternalAction } from '@ensemus/application';
import { resolveExternalActionSchema } from '@ensemus/contracts/external-actions';
import {
  apiRoute,
  etag,
  externalActionDto,
  externalActionParams,
  readIfMatch,
  readJson,
} from '@/server/api';

export const dynamic = 'force-dynamic';

// This route records what a person found and nothing else. No path from here sends anything.
export const POST = apiRoute(
  externalActionParams,
  async ({ request, context, database, params }) => {
    const expectedVersion = readIfMatch(request);
    const body = await readJson(request, resolveExternalActionSchema);
    await resolveUnknownExternalAction(database, context, {
      externalActionId: params.externalActionId,
      expectedVersion,
      resolution: body.resolution,
      reason: body.reason,
    });
    const detail = await getExternalActionDetail(database, context, params.externalActionId);
    return Response.json(externalActionDto(detail), { headers: { ETag: etag(detail.version) } });
  },
);
