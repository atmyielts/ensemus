import { AppError, idSchema } from '@ensemus/application';
import { linkObjectRecords, listObjectRelations } from '@ensemus/application/custom-objects';
import { linkObjectRecordsSchema } from '@ensemus/contracts/custom-objects';
import { apiRoute, readJson } from '@/server/api';
import { objectRecordParams } from '@/server/object-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(objectRecordParams, async ({ database, context, params, request }) => {
  const raw = new URL(request.url).searchParams.get('after');
  const after = raw ? idSchema.safeParse(raw) : undefined;
  if (after && !after.success) throw new AppError('INVALID_INPUT');
  const page = await listObjectRelations(
    database,
    context,
    params.recordId,
    after?.success ? { after: after.data } : {},
  );
  return Response.json({
    items: page.items.map((r) => ({
      id: r.id,
      relation_key: r.relationKey,
      to_record_id: r.toRecordId,
      to_display_name: r.toDisplayName,
    })),
    truncated: page.truncated,
    next: page.next,
  });
});
export const POST = apiRoute(objectRecordParams, async ({ database, context, params, request }) => {
  const b = await readJson(request, linkObjectRecordsSchema),
    r = await linkObjectRecords(database, context, {
      fromRecordId: params.recordId,
      toRecordId: b.to_record_id,
      relationKey: b.relation_key,
    });
  return Response.json(r, { status: 201 });
});
