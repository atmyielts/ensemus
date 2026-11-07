import { getObjectType, raiseObjectTypeClassification } from '@ensemus/application/custom-objects';
import { createObjectTypeSchema } from '@ensemus/contracts/custom-objects';
import { apiRoute, readJson, readIfMatch, etag } from '@/server/api';
import { objectTypeParams, objectTypeDto } from '@/server/object-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(objectTypeParams, async ({ database, context, params }) => {
  const t = await getObjectType(database, context, params.typeId);
  return Response.json(objectTypeDto(t), { headers: { ETag: etag(t.version) } });
});
export const PATCH = apiRoute(objectTypeParams, async ({ database, context, params, request }) => {
  const expectedVersion = readIfMatch(request),
    body = await readJson(request, createObjectTypeSchema.pick({ classification: true }));
  const t = await raiseObjectTypeClassification(database, context, {
    typeId: params.typeId,
    expectedVersion,
    classification: body.classification,
  });
  return Response.json(objectTypeDto(t), { headers: { ETag: etag(t.version) } });
});
