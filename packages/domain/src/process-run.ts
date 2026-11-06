// Running a compiled process (AGENT-13, ADR-031 D7). Pure, and owned by the process slice. A workflow's
// decisions live here, as review-wait.ts does for reviews, so a unit test can reach every path.
import type { ProcessSpec } from './process-spec';
import type { SimulationReport, SimulationScenario } from './simulation';

export type StepStatus = 'pending' | 'ready' | 'waiting' | 'done' | 'failed' | 'skipped';

export type RunDecision =
  | { next: 'start_steps'; stepKeys: readonly string[] }
  | { next: 'wait' }
  | { next: 'completed' }
  | { next: 'failed'; stepKey: string };

/** Which steps can start, given where every step stands. A failed step stops what follows it. */
export function nextProcessSteps(
  _spec: ProcessSpec,
  _statuses: Readonly<Record<string, StepStatus>>,
): RunDecision {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Walks a spec with nothing behind it (ADR-031 D5). A step that would write outside is reported as that, and
 * a report with a missing approval fails. Called by `runSimulationStep` for a process or catalog subject.
 */
export function simulateProcess(
  _spec: ProcessSpec,
  _specSha256: string,
  _scenario: SimulationScenario,
): SimulationReport {
  throw new Error('NOT_IMPLEMENTED');
}
