import { unlinkObjectRecords } from '@ensemus/application/custom-objects';
import { apiRoute } from '@/server/api';
import { objectRelationParams } from '@/server/object-api';
export const dynamic = 'force-dynamic';
export const DELETE = apiRoute(objectRelationParams, async ({ database, context, params }) => {
  await unlinkObjectRecords(database, context, {
    relationId: params.relationId,
    fromRecordId: params.recordId,
  });
  return new Response(null, { status: 204 });
});
