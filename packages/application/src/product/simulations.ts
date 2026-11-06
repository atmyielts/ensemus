// Owned by the studio slice (AGENT-08). See docs/06-delivery/m7-slices.md and ADR-031 D5.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { SimulationReport } from '@ensemus/domain/simulation';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type SimulationSubject =
  | { kind: 'agent_draft'; draftId: string }
  | { kind: 'process_draft'; draftId: string }
  | { kind: 'bundled_workflow'; processKey: string };

export type SimulationView = {
  id: string;
  subjectKind: 'agent_draft' | 'process_draft' | 'bundled_workflow';
  subjectId: string | null;
  subjectKey: string | null;
  subjectSha256: string;
  scenarioKey: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'errored';
  outcomeCode: string | null;
  report: SimulationReport | null;
  createdAt: Date;
  finishedAt: Date | null;
};

/**
 * Needs `studio.author`, or `onboarding.manage` for a catalog workflow. Commits the row and SIMULATION_REQUESTED
 * together, and the worker does the rest. The hash is read here, so a later edit cannot change what ran.
 */
export async function requestSimulation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { subject: SimulationSubject; scenarioKey: string },
): Promise<SimulationView> {
  throw NOT_BUILT();
}

export async function getSimulation(
  _database: AppDatabase,
  _context: TenantContext,
  _simulationId: string,
): Promise<SimulationView> {
  throw NOT_BUILT();
}

export async function listSimulations(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { subject: SimulationSubject },
): Promise<readonly SimulationView[]> {
  throw NOT_BUILT();
}

/**
 * Called by the worker's Activity, with a service context. Claims a queued run, computes the report with the
 * pure simulators, and records it. Running it again on a finished run changes nothing.
 */
export async function runSimulationStep(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { simulationId: string },
): Promise<'passed' | 'failed' | 'errored' | 'already_finished'> {
  throw NOT_BUILT();
}
