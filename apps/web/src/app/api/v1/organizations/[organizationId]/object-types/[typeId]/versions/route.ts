import { addObjectTypeVersion } from '@ensemus/application/custom-objects';
import { addObjectTypeVersionSchema } from '@ensemus/contracts/custom-objects';
import { apiRoute, readIfMatch, readJson } from '@/server/api';
import { objectTypeParams } from '@/server/object-api';
import { objectFieldsInput } from '@/lib/object-input';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(objectTypeParams, async ({ database, context, params, request }) => {
  const expectedVersion = readIfMatch(request),
    body = await readJson(request, addObjectTypeVersionSchema);
  const result = await addObjectTypeVersion(database, context, {
    typeId: params.typeId,
    expectedVersion,
    fields: objectFieldsInput(body.fields),
    relations: body.relations,
  });
  return Response.json(
    { migration_id: result.migrationId, plan: result.plan },
    { status: result.migrationId ? 202 : 200 },
  );
});
