import { requestSimulation, getSimulation } from '@ensemus/application/simulations';
import { requestSimulationSchema } from '@ensemus/contracts/studio';
import { apiRoute, readJson } from '@/server/api';
import { agentDraftParams, simulationDto, studioOnce } from '@/server/studio-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(agentDraftParams, async ({ database, context, params, request }) => {
  const b = await readJson(request, requestSimulationSchema),
    input = {
      subject: { kind: 'agent_draft' as const, draftId: params.agentDraftId },
      scenarioKey: b.scenario_key,
    };
  const id = await studioOnce(
    database,
    context,
    request.headers.get('idempotency-key') ?? '',
    'simulation.request',
    input,
    (db) => requestSimulation(db, context, input),
    202,
  );
  return Response.json(simulationDto(await getSimulation(database, context, id)), { status: 202 });
});
