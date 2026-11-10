import { getAgentDraft, updateAgentDraft } from '@ensemus/application/agent-drafts';
import { updateAgentDraftSchema } from '@ensemus/contracts/studio';
import { apiRoute, readJson, readIfMatch, etag } from '@/server/api';
import { agentDraftDto, agentDraftParams } from '@/server/studio-api';
import { webProductPorts } from '@/server/product-ports';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(agentDraftParams, async ({ database, context, params }) => {
  const row = await getAgentDraft(database, context, params.agentDraftId);
  return Response.json(agentDraftDto(row), { headers: { ETag: etag(row.version) } });
});
export const PATCH = apiRoute(agentDraftParams, async ({ database, context, params, request }) => {
  const expectedVersion = readIfMatch(request),
    b = await readJson(request, updateAgentDraftSchema);
  const row = await updateAgentDraft(database, context, webProductPorts(), {
    draftId: params.agentDraftId,
    expectedVersion,
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.answers !== undefined ? { answers: b.answers } : {}),
  });
  return Response.json(agentDraftDto(row), { headers: { ETag: etag(row.version) } });
});
