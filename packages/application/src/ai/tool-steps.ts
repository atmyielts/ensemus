// Owned by the tools slice (AGENT-03). The storage side of the tool gateway. See
// docs/06-delivery/m4-slices.md and ADR-028 FD-18. Only agent-worker uses this. Every stub refuses.
import type { AgentContext, AppDatabase } from '@ensemus/database';

export type StoredProposal = {
  id: string;
  runId: string;
  stepId: string;
  toolId: string;
  toolVersion: string;
  payloadHash: string;
  idempotencyKey: string;
  status: string;
  /** From `ai.step_payloads`. This is why only the agent role can run this. */
  args: unknown;
};

/** Written by the model turn that proposed it, with its arguments in `ai.step_payloads`. */
export function storeProposal(
  _database: AppDatabase,
  _context: AgentContext,
  _input: { runId: string; stepNumber: number; toolId: string; args: unknown },
): Promise<{ proposalId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function loadProposal(
  _database: AppDatabase,
  _context: AgentContext,
  _input: { runId: string; stepNumber: number },
): Promise<StoredProposal | null> {
  throw new Error('NOT_IMPLEMENTED');
}

export function setProposalStatus(
  _database: AppDatabase,
  _context: AgentContext,
  _input: { proposalId: string; status: string; decisionCode: string | null },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
