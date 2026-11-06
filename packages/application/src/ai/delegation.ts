// Owned by the delegation slice (AGENT-05). See docs/06-delivery/m4-slices.md and ADR-028 FD-16. Only
// agent-worker uses this. Every stub refuses. Migration 0101 also refuses a child wider than its parent.
import type { AgentContext, AppDatabase } from '@ensemus/database';

export type ChildRunResult =
  | { kind: 'created'; childWorkUnitId: string; childRunId: string; maxCostMicros: number }
  | {
      kind: 'denied';
      code: 'DELEGATION_WIDENED' | 'DELEGATION_DEPTH' | 'DELEGATION_FANOUT' | 'BUDGET_EXHAUSTED';
    };

/** Writes the child Work Unit and queued run, with scopes the intersection of what was asked and held. */
export function createChildRun(
  _database: AppDatabase,
  _context: AgentContext,
  _input: { parentRunId: string; stepNumber: number },
): Promise<ChildRunResult> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Child finished: gives what it did not use back to the parent's reservation. Safe to repeat. */
export function settleChildRun(
  _database: AppDatabase,
  _context: AgentContext,
  _input: { parentRunId: string; childRunId: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
