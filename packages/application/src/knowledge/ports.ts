// What knowledge needs from milestones being built alongside it (ADR-029 D10). Each is small, and the
// sibling's code implements it at the final merge, so this code never imports theirs. Slices test against
// doubles, in tests/helpers/knowledge.ts. A port with no implementation fails closed where it is used.
import type { TenantContext, Tx } from '@ensemus/database';
import type { EgressWorkload } from '@ensemus/knowledge/ports';

/** One row of AGENT-10's ledger. The same shape whichever table it came from, and it holds no content. */
export type EgressLedgerRow = {
  id: string;
  occurredAt: Date;
  source: 'knowledge' | 'agent_run';
  purpose: string;
  dataClass: string;
  modelProfileRef: string | null;
  providerKind: string | null;
  destinationHost: string | null;
  decision: 'allow' | 'deny';
  reasonCode: string;
  policyVersion: string;
  requestSha256: string | null;
  runId: string | null;
};

/**
 * M4's `governance.egress_decisions`, for calls made inside an agent run. M4's plan says this table cannot
 * be backfilled and that AGENT-10 reads it. Its row maps to the shape above.
 */
export interface RunEgressDecisions {
  list(
    tx: Tx,
    query: { before: { occurredAt: Date; id: string } | null; limit: number },
  ): Promise<readonly EgressLedgerRow[]>;
}

/** M4's published agent versions, as the workloads the egress simulator asks about (AGENT-11). */
export interface AgentWorkloads {
  list(tx: Tx): Promise<readonly EgressWorkload[]>;
}

/**
 * Prompts M4 keeps for a run can hold a document's words. When a source closes, the purge asks M4 to
 * remove the transcripts that used it (ADR-029 D3). `sourceIds` come from `knowledge.evidence_items`.
 */
export interface RunTranscriptPurge {
  purgeUsing(
    tx: Tx,
    context: TenantContext,
    query: { runIds: readonly string[] },
  ): Promise<{ removed: number }>;
}

/** M4's agent runs. The flagship asks for one, and reads how it went. */
export interface AgentRuns {
  /** In the caller's transaction, so the run and the rest commit together. No model call happens here. */
  requestRun(
    tx: Tx,
    context: TenantContext,
    input: { workUnitId: string; agentKey: string },
  ): Promise<{ agentRunId: string }>;
  statusOf(
    tx: Tx,
    context: TenantContext,
    agentRunId: string,
  ): Promise<{ status: string; costMicros: number | null } | null>;
}
