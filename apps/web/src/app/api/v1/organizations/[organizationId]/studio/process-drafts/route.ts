import {
  createProcessDraft,
  getProcessDraft,
  listProcessDrafts,
} from '@ensemus/application/process-specs';
import { createProcessDraftSchema } from '@ensemus/contracts/studio';
import { apiRoute, organizationParams, readJson, etag } from '@/server/api';
import { processDraftDto, studioOnce } from '@/server/studio-api';
import { webProductPorts } from '@/server/product-ports';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(organizationParams, async ({ database, context }) =>
  Response.json({ items: (await listProcessDrafts(database, context)).map(processDraftDto) }),
);
export const POST = apiRoute(organizationParams, async ({ database, context, request }) => {
  const input = await readJson(request, createProcessDraftSchema);
  const id = await studioOnce(
    database,
    context,
    request.headers.get('idempotency-key') ?? '',
    'process-draft.create',
    input,
    (db) => createProcessDraft(db, context, input),
  );
  const row = await getProcessDraft(database, context, webProductPorts(), id);
  return Response.json(processDraftDto(row), { status: 201, headers: { ETag: etag(row.version) } });
});
