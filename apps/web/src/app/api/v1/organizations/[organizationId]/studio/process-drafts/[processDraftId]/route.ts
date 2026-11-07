import { getProcessDraft, updateProcessDraft } from '@ensemus/application/process-specs';
import { updateProcessDraftSchema } from '@ensemus/contracts/studio';
import { apiRoute, readJson, readIfMatch, etag } from '@/server/api';
import { processDraftDto, processDraftParams } from '@/server/studio-api';
import { webProductPorts } from '@/server/product-ports';
import { processGraphInput } from '@/lib/studio-input';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(processDraftParams, async ({ database, context, params }) => {
  const row = await getProcessDraft(database, context, webProductPorts(), params.processDraftId);
  return Response.json(processDraftDto(row), { headers: { ETag: etag(row.version) } });
});
export const PATCH = apiRoute(
  processDraftParams,
  async ({ database, context, params, request }) => {
    const expectedVersion = readIfMatch(request),
      b = await readJson(request, updateProcessDraftSchema);
    const row = await updateProcessDraft(database, context, webProductPorts(), {
      draftId: params.processDraftId,
      expectedVersion,
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.classification ? { classification: b.classification } : {}),
      ...(b.graph ? { graph: processGraphInput(b.graph) } : {}),
    });
    return Response.json(processDraftDto(row), { headers: { ETag: etag(row.version) } });
  },
);
