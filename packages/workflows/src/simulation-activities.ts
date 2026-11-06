// Owned by the studio slice (AGENT-08). See docs/06-delivery/m7-slices.md and ADR-031 D5.
import { runSimulationStep } from '@ensemus/application/simulations';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import type { SimulationInput, SimulationOutcome } from './product-schemas';

export function createSimulationActivities(deps: { database: AppDatabase }) {
  return {
    async runSimulation(input: SimulationInput): Promise<SimulationOutcome> {
      return runSimulationStep(deps.database, createServiceContext(input.organizationId), {
        simulationId: input.simulationId,
      });
    },
  };
}
export type SimulationActivities = ReturnType<typeof createSimulationActivities>;
