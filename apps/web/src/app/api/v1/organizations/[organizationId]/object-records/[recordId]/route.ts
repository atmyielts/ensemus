import {
  getObjectRecord,
  updateObjectRecord,
  deleteObjectRecord,
} from '@ensemus/application/custom-objects';
import { updateObjectRecordSchema } from '@ensemus/contracts/custom-objects';
import { apiRoute, readJson, readIfMatch, etag } from '@/server/api';
import { objectRecordParams, objectRecordDto } from '@/server/object-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(objectRecordParams, async ({ database, context, params }) => {
  const r = await getObjectRecord(database, context, params.recordId);
  return Response.json(objectRecordDto(r), { headers: { ETag: etag(r.version) } });
});
export const PATCH = apiRoute(
  objectRecordParams,
  async ({ database, context, params, request }) => {
    const expectedVersion = readIfMatch(request),
      b = await readJson(request, updateObjectRecordSchema),
      r = await updateObjectRecord(database, context, {
        recordId: params.recordId,
        expectedVersion,
        ...(b.display_name === undefined ? {} : { displayName: b.display_name }),
        ...(b.attributes === undefined ? {} : { attributes: b.attributes }),
        ...(b.classification ? { classification: b.classification } : {}),
      });
    return Response.json(objectRecordDto(r), { headers: { ETag: etag(r.version) } });
  },
);
export const DELETE = apiRoute(
  objectRecordParams,
  async ({ database, context, params, request }) => {
    await deleteObjectRecord(database, context, {
      recordId: params.recordId,
      expectedVersion: readIfMatch(request),
    });
    return new Response(null, { status: 204 });
  },
);
