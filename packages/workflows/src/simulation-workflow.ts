// A simulation (ADR-031 D5). Deterministic workflow code: only @temporalio/workflow and types may be imported
// here. One Activity, because the report is a pure function of what the row holds. Owned by the studio slice.
import { proxyActivities } from '@temporalio/workflow';
import type { SimulationInput, SimulationOutcome } from './product-schemas';
import type { SimulationActivities } from './simulation-activities';

const { runSimulation } = proxyActivities<SimulationActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5 },
});

export async function simulationWorkflow(input: SimulationInput): Promise<SimulationOutcome> {
  return runSimulation(input);
}
