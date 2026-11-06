// Owned by the timeline slice (AGENT-06). What a person can see of a run: codes and counters, and no
// model text, because the role this runs under cannot read any. See docs/06-delivery/m4-slices.md. Every
// stub refuses.
import type { AgentRunView, ExecutionStepView } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';

export function getAgentRun(
  _database: AppDatabase,
  _context: TenantContext,
  _agentRunId: string,
): Promise<AgentRunView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listRunsForWork(
  _database: AppDatabase,
  _context: TenantContext,
  _workUnitId: string,
): Promise<readonly AgentRunView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listRunSteps(
  _database: AppDatabase,
  _context: TenantContext,
  _agentRunId: string,
): Promise<readonly ExecutionStepView[]> {
  throw new Error('NOT_IMPLEMENTED');
}
