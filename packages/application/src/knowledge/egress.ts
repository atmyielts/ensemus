// Owned by the egress slice (AGENT-10, AGENT-11). See docs/06-delivery/m5-slices.md and ADR-029 D9. The
// machine-readable ledger, and the simulator that shows what a proposed provider would get. Needs
// `egress.view`, and both hold codes and IDs, and never company text.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { SimulationRow } from '@ensemus/knowledge/egress-simulation';
import type { EgressPolicyPort, EgressProposal } from '@ensemus/knowledge/ports';
import type { AgentWorkloads, EgressLedgerRow, RunEgressDecisions } from './ports';

export type EgressLedgerPage = { items: readonly EgressLedgerRow[]; next: string | null };

/** Newest first, across `knowledge.model_calls` and M4's run decisions, with a stable cursor. */
export function listEgressLedger(
  _database: AppDatabase,
  _context: TenantContext,
  _deps: { runDecisions: RunEgressDecisions },
  _input: { after?: string; limit?: number },
): Promise<EgressLedgerPage> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Lists every workload that would send data, per class, and whether policy would let it reach this
 * proposal. Transmits nothing, opens no socket and unseals nothing. Knowledge's own workloads (embedding,
 * reranking, answers) are read from the classes this tenant's sources actually hold.
 */
export function simulateProvider(
  _database: AppDatabase,
  _context: TenantContext,
  _deps: { policy: EgressPolicyPort; agentWorkloads: AgentWorkloads },
  _input: { proposal: EgressProposal },
): Promise<readonly SimulationRow[]> {
  throw new Error('NOT_IMPLEMENTED');
}
