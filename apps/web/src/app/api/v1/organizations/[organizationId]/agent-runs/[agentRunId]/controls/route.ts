import { controlAgentRun } from '@ensemus/application/ai-run-control';
import { runControlSchema } from '@ensemus/contracts/ai';
import { apiRoute, readJson } from '@/server/api';
import { agentRunParams } from '../../params';

export const dynamic = 'force-dynamic';

// 202: the request is on record, and each step rechecks it before acting. It has not happened yet, and
// this answer does not claim so.
export const POST = apiRoute(agentRunParams, async ({ request, context, database, params }) => {
  const { kind } = await readJson(request, runControlSchema);
  await controlAgentRun(database, context, { agentRunId: params.agentRunId, kind });
  return new Response(null, { status: 202 });
});
