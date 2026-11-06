import { getAgentRun } from '@ensemus/application/ai-timeline';
import { apiRoute } from '@/server/api';
import { agentRunParams } from '../params';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(agentRunParams, async ({ context, database, params }) =>
  Response.json(await getAgentRun(database, context, params.agentRunId)),
);
