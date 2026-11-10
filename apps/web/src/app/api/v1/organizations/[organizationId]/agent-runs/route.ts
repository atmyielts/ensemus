import { idSchema, requestHash, runIdempotent } from '@ensemus/application';
import { startAgentRun } from '@ensemus/application/ai-run-control';
import { listRunsForWork } from '@ensemus/application/ai-timeline';
import { startAgentRunSchema } from '@ensemus/contracts/ai';
import { z } from 'zod';
import {
  apiRoute,
  idempotencyKeyReused,
  organizationParams,
  readJson,
  readQuery,
} from '@/server/api';

export const dynamic = 'force-dynamic';

const listQuery = z.object({ work_unit_id: idSchema });

export const GET = apiRoute(organizationParams, async ({ request, context, database }) => {
  const { work_unit_id: workUnitId } = readQuery(request, listQuery);
  return Response.json({ items: await listRunsForWork(database, context, workUnitId) });
});

// The body has no field for a limit, a tool or a model, and a strict schema refuses one that adds any. A
// run's terms come from the agent version. 202, because this records a request: the worker does the rest.
export const POST = apiRoute(organizationParams, async ({ request, context, database }) => {
  const body = await readJson(request, startAgentRunSchema);
  const outcome = await runIdempotent(
    database,
    context,
    {
      key: request.headers.get('idempotency-key') ?? '',
      requestHash: requestHash(['POST', 'agent-runs', JSON.stringify(body)]),
    },
    (joined) => startAgentRun(joined, context, body),
    (run) => ({ status: 202, body: run }),
  );
  if (outcome.kind === 'conflict') throw idempotencyKeyReused();
  return Response.json(outcome.body, { status: outcome.status });
});
