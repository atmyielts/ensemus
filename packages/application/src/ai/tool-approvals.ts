// Owned by the approvals slice (AGENT-04, QA-007 agent path). See docs/06-delivery/m4-slices.md and ADR-027 D1.
// Reuses `checkExecution`, `actionHash` and M3's intent, and rewrites none of them. Every stub refuses.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ApprovalBinder, ExternalActionPort, HaltCheck } from './ports';

export function createApprovalBinder(_deps: {
  externalActions: ExternalActionPort;
  halt: HaltCheck;
}): ApprovalBinder {
  throw new Error('NOT_IMPLEMENTED');
}

/** What the approval page shows beside an agent's action. Web may call this: it reads no prompt. */
export type AgentActionView = {
  initiatorMembershipId: string;
  agentVersionId: string;
  agentRunId: string;
  toolId: string;
  toolVersion: string;
  dataClass: string;
  riskLabel: 'external_write';
  expiresAt: Date;
  requestHash: string;
};

/** Null when this approval is not an agent's. Needs the same access as reading the approval itself. */
export function getAgentActionForApproval(
  _database: AppDatabase,
  _context: TenantContext,
  _approvalId: string,
): Promise<AgentActionView | null> {
  throw new Error('NOT_IMPLEMENTED');
}
