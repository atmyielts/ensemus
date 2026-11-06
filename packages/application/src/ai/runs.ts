// Owned by the spine slice (AGENT-02, AI-13). The worker side of a run: claim, step rows, counters, finish.
// See docs/06-delivery/m4-slices.md and ADR-028 FD-1, FD-7, FD-12. Only agent-worker uses this, except
// `closeStrandedRun`, which the base worker's upkeep calls. Every stub refuses.
import type { AgentContext, AppDatabase, TenantContext } from '@ensemus/database';
import type { AgentRunStatus, RunCounters, RunLimits, StopCode } from '@ensemus/domain/ai';
import type { TurnStore } from './ports';

export type ClaimedRun = {
  agentRunId: string;
  agentVersionId: string;
  initiatorMembershipId: string;
  limits: RunLimits;
  counters: RunCounters;
  nextStepNumber: number;
};

/** Finds the queued run through `withRunLookupTx`, then claims it under its initiator's context. */
export function claimQueuedRun(
  _database: AppDatabase,
  _input: { organizationId: string; workUnitId: string; temporalRunId: string },
): Promise<ClaimedRun | null> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The initiator's context for this run, read fresh. Every Activity starts here. Throws
 * TenantAccessDenied when the initiator is disabled, which ends the run as INITIATOR_INACTIVE.
 */
export function contextForRun(
  _database: AppDatabase,
  _input: { organizationId: string; agentRunId: string },
): Promise<AgentContext> {
  throw new Error('NOT_IMPLEMENTED');
}

export function setRunStatus(
  _database: AppDatabase,
  _context: AgentContext,
  _input: { agentRunId: string; status: AgentRunStatus },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export function addToCounters(
  _database: AppDatabase,
  _context: AgentContext,
  _input: { agentRunId: string; delta: Partial<RunCounters> },
): Promise<RunCounters> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Terminal status, reservations released, payloads purged. Safe to repeat. */
export function finishRun(
  _database: AppDatabase,
  _context: AgentContext,
  _input: { agentRunId: string; status: AgentRunStatus; stopCode: StopCode | null },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** The base worker's upkeep found the workflow gone. The one update `ensemus_app` may make to a run. */
export function closeStrandedRun(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { workUnitId: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export function createTurnStore(_database: AppDatabase): TurnStore {
  throw new Error('NOT_IMPLEMENTED');
}
