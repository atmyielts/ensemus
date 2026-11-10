import { AppError, idSchema } from '@ensemus/application';
import {
  createObjectRecord,
  getObjectRecord,
  listObjectRecords,
} from '@ensemus/application/custom-objects';
import { createObjectRecordSchema } from '@ensemus/contracts/custom-objects';
import { z } from 'zod';
import { apiRoute, readJson, etag } from '@/server/api';
import { createObjectOnce, objectTypeParams, objectRecordDto } from '@/server/object-api';
export const dynamic = 'force-dynamic';
const query = z.strictObject({
  after: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  field: z.string().max(63).optional(),
  equals: z.string().max(50000).optional(),
});
export const GET = apiRoute(objectTypeParams, async ({ database, context, params, request }) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success || Boolean(parsed.data.field) !== (parsed.data.equals !== undefined))
    throw new AppError('INVALID_INPUT');
  const q = parsed.data,
    result = await listObjectRecords(database, context, {
      typeId: params.typeId,
      ...(q.after ? { after: q.after } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
      ...(q.field && q.equals !== undefined
        ? { filter: { fieldKey: q.field, equals: q.equals } }
        : {}),
    });
  return Response.json({ items: result.items.map(objectRecordDto), next: result.next });
});
export const POST = apiRoute(objectTypeParams, async ({ database, context, params, request }) => {
  const b = await readJson(request, createObjectRecordSchema),
    input = {
      typeId: params.typeId,
      displayName: b.display_name,
      attributes: b.attributes,
      ...(b.classification ? { classification: b.classification } : {}),
    },
    saved = await createObjectOnce(
      database,
      context,
      request.headers.get('idempotency-key') ?? '',
      'object-record',
      input,
      (db) => createObjectRecord(db, context, input),
    ),
    r = await getObjectRecord(database, context, saved);
  return Response.json(objectRecordDto(r), { status: 201, headers: { ETag: etag(r.version) } });
});
