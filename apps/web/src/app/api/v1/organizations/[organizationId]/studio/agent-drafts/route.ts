import {
  createAgentDraft,
  getAgentDraft,
  listAgentDrafts,
} from '@ensemus/application/agent-drafts';
import { createAgentDraftSchema } from '@ensemus/contracts/studio';
import { apiRoute, organizationParams, readJson, etag } from '@/server/api';
import { agentDraftDto, studioOnce } from '@/server/studio-api';
import { webProductPorts } from '@/server/product-ports';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(organizationParams, async ({ database, context }) =>
  Response.json({ items: (await listAgentDrafts(database, context)).map(agentDraftDto) }),
);
export const POST = apiRoute(organizationParams, async ({ database, context, request }) => {
  const b = await readJson(request, createAgentDraftSchema),
    input = {
      name: b.name,
      answers: b.answers,
      ...(b.agent_definition_id ? { agentDefinitionId: b.agent_definition_id } : {}),
    };
  const id = await studioOnce(
    database,
    context,
    request.headers.get('idempotency-key') ?? '',
    'agent-draft.create',
    input,
    (db) => createAgentDraft(db, context, webProductPorts(), input),
  );
  const row = await getAgentDraft(database, context, id);
  return Response.json(agentDraftDto(row), { status: 201, headers: { ETag: etag(row.version) } });
});
