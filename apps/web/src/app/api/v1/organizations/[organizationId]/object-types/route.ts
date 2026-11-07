import {
  createObjectType,
  getObjectType,
  listObjectTypes,
} from '@ensemus/application/custom-objects';
import { createObjectTypeSchema } from '@ensemus/contracts/custom-objects';
import { apiRoute, organizationParams, readJson, etag } from '@/server/api';
import { createObjectOnce, objectTypeDto } from '@/server/object-api';
import { objectFieldsInput } from '@/lib/object-input';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(organizationParams, async ({ database, context }) =>
  Response.json({ items: (await listObjectTypes(database, context)).map(objectTypeDto) }),
);
export const POST = apiRoute(organizationParams, async ({ database, context, request }) => {
  const body = await readJson(request, createObjectTypeSchema),
    input = {
      slug: body.slug,
      displayName: body.display_name,
      classification: body.classification,
      fields: objectFieldsInput(body.fields),
      relations: body.relations,
    };
  const saved = await createObjectOnce(
      database,
      context,
      request.headers.get('idempotency-key') ?? '',
      'object-type',
      input,
      (db) => createObjectType(db, context, input),
    ),
    type = await getObjectType(database, context, saved);
  return Response.json(objectTypeDto(type), { status: 201, headers: { ETag: etag(type.version) } });
});
