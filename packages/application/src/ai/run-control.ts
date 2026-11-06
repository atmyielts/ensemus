// Owned by the timeline slice (AGENT-06). The web side of a run: start, stop, pause, resume. A request is
// a row and an outbox event in one transaction, so the web tier never reaches Temporal. Needs `agent.run`
// and `agent.stop`, on top of being able to change the Work Unit. Every stub refuses.
import type { AgentRunView, RunControlRequest, StartAgentRun } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';

/** Reads limits from the agent version, never from the request. Emits agent_run.requested. */
export function startAgentRun(
  _database: AppDatabase,
  _context: TenantContext,
  _input: StartAgentRun,
): Promise<AgentRunView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Writes `ai.run_controls` and emits agent_run.control_requested. */
export function controlAgentRun(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { agentRunId: string } & RunControlRequest,
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
