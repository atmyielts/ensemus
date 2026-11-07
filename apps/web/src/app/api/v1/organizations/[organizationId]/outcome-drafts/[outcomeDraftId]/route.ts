import { getOutcomeDraft, reviseOutcomeDraft, discardOutcome } from '@ensemus/application/outcomes';
import { outcomePreviewSchema } from '@ensemus/contracts/experience';
import { apiRoute, readJson, etag, readIfMatch } from '@/server/api';
import { outcomeDto, outcomeParams } from '@/server/experience-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(outcomeParams, async ({ database, context, params }) => {
  const d = await getOutcomeDraft(database, context, params.outcomeDraftId);
  return Response.json(outcomeDto(d), { headers: { ETag: etag(d.version) } });
});
export const PATCH = apiRoute(outcomeParams, async ({ database, context, params, request }) => {
  const d = await reviseOutcomeDraft(database, context, {
    draftId: params.outcomeDraftId,
    expectedVersion: readIfMatch(request),
    preview: await readJson(request, outcomePreviewSchema),
  });
  return Response.json(outcomeDto(d), { headers: { ETag: etag(d.version) } });
});
export const DELETE = apiRoute(outcomeParams, async ({ database, context, params, request }) => {
  await discardOutcome(database, context, {
    draftId: params.outcomeDraftId,
    expectedVersion: readIfMatch(request),
  });
  return new Response(null, { status: 204 });
});
