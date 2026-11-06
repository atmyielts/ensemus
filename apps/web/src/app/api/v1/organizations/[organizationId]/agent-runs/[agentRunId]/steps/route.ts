import { listRunSteps } from '@ensemus/application/ai-timeline';
import { apiRoute } from '@/server/api';
import { agentRunParams } from '../../params';

export const dynamic = 'force-dynamic';

// Codes, counters and times. This tier's role has no grant on the table that holds model text.
export const GET = apiRoute(agentRunParams, async ({ context, database, params }) =>
  Response.json({ items: await listRunSteps(database, context, params.agentRunId) }),
);
