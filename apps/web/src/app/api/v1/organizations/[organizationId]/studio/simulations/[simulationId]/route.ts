import { getSimulation } from '@ensemus/application/simulations';
import { apiRoute } from '@/server/api';
import { simulationDto, simulationParams } from '@/server/studio-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(simulationParams, async ({ database, context, params }) =>
  Response.json(simulationDto(await getSimulation(database, context, params.simulationId))),
);
