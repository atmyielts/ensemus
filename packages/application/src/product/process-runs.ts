// Owned by the process slice (AGENT-13). See docs/06-delivery/m7-slices.md and ADR-031 D7.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { StepStatus } from '@ensemus/domain/process-run';
import type { ProductPorts } from './ports';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type ProcessRunView = {
  id: string;
  specId: string;
  processName: string;
  rootWorkUnitId: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  stopCode: string | null;
  steps: readonly {
    key: string;
    label: string;
    status: StepStatus;
    stopCode: string | null;
    workUnitId: string | null;
    approvalId: string | null;
    externalActionId: string | null;
    agentRunId: string | null;
  }[];
  /** From M4's ledger through a port. Null while unavailable, and labelled an estimate where it is one. */
  cost: { costMicros: number; isEstimate: boolean } | null;
  version: number;
  createdAt: Date;
  finishedAt: Date | null;
};

/**
 * Needs `studio.publish` on a spec the starter can read. Makes the root Work Unit, the run and its steps, and
 * PROCESS_RUN_REQUESTED, in one transaction. Restricted specs may not hold an `external_action` step.
 */
export async function startProcessRun(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { specId: string; title: string; dueAt?: Date; requestKey?: string },
): Promise<ProcessRunView> {
  throw NOT_BUILT();
}

/** Installs a catalog workflow as a spec this tenant can run, once per version. Needs `studio.publish`. */
export async function installBundledWorkflow(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { processKey: string },
): Promise<{ specId: string; versionNumber: number }> {
  throw NOT_BUILT();
}

export async function listProcessRuns(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { status?: ProcessRunView['status']; after?: string } = {},
): Promise<{ items: readonly ProcessRunView[]; next: string | null }> {
  throw NOT_BUILT();
}

/** Filtered by who can read the root Work Unit. Anyone else gets not found. */
export async function getProcessRun(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'usage'>,
  _runId: string,
): Promise<ProcessRunView> {
  throw NOT_BUILT();
}

/** Needs `canManageWork` on the root. Commits the stop first, and the next step finds it in PostgreSQL. */
export async function requestStopProcessRun(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { runId: string; expectedVersion: number },
): Promise<void> {
  throw NOT_BUILT();
}

export type AdvanceResult =
  { next: 'wait' } | { next: 'finished'; status: 'completed' | 'failed' | 'cancelled' };

/**
 * The worker's one step, with a service context. Under a lock on the run: reads the spec and every step,
 * asks `nextProcessSteps`, and starts what it says. Rechecks before each effect that the starter is still
 * active, the root is not stopped, and the spec's hash is what was stored. Repeating it changes nothing:
 * every effect is keyed on (run, step), and an effect always goes through the normal service, so an external
 * action still needs its own approval, and an agent task acts as the starter (M4 FD-3), never as a service.
 */
export async function advanceProcessRun(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'agentRuns'>,
  _input: { runId: string; temporalRunId: string },
): Promise<AdvanceResult> {
  throw NOT_BUILT();
}

/** For the workflow's stop path: marks what is left, and records why. */
export async function finishProcessRun(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { runId: string; code: string },
): Promise<void> {
  throw NOT_BUILT();
}
