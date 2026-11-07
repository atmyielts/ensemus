import { authorizeOutcome, getOutcomeDraft } from '@ensemus/application/outcomes';
import { authorizeOutcomeSchema } from '@ensemus/contracts/experience';
import { apiRoute, readJson, readIfMatch, etag } from '@/server/api';
import { outcomeParams, outcomeDto } from '@/server/experience-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(outcomeParams, async ({ database, context, params, request }) => {
  const body = await readJson(request, authorizeOutcomeSchema);
  await authorizeOutcome(database, context, {
    draftId: params.outcomeDraftId,
    expectedVersion: readIfMatch(request),
    previewSha256: body.preview_sha256,
  });
  const d = await getOutcomeDraft(database, context, params.outcomeDraftId);
  return Response.json(outcomeDto(d), { status: 201, headers: { ETag: etag(d.version) } });
});
