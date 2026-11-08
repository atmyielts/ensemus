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
  /** Display pagination uses (date_trunc('milliseconds', occurred_at), id) in both ORDER BY and WHERE. */
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
  /**
   * Durably fence every named run before deleting payloads. A fence prevents all later transcript
   * writes, including a model response already in flight; cancellation alone is insufficient. This
   * idempotent database operation is repeated on every purge attempt and immediately after deletion.
   * An older adapter without this operation cannot certify a completed purge.
   */
  fenceUsing?(
    tx: Tx,
    context: TenantContext,
    query: { runIds: readonly string[] },
  ): Promise<{ fenced: boolean }>;
  purgeUsing(
    tx: Tx,
    context: TenantContext,
    query: { runIds: readonly string[] },
  ): Promise<{ removed: number; remaining?: number }>;
}

/** Generated file erasure is owned by the artifact lifecycle. Provider calls occur outside the source
 * transaction, while its final read-only proof runs under the caller's source lock. Missing adapters
 * never imply an empty success. Counts of removed headers are cumulative and durably verified. */
export interface DerivedArtifactPurge {
  purgeSource(
    context: TenantContext,
    input: { sourceId: string; limit: number },
  ): Promise<{ removed: number; remaining: number; held: number; confirmed: boolean }>;
  confirmInTx(
    tx: Tx,
    context: TenantContext,
    input: { sourceId: string },
  ): Promise<{ remaining: number }>;
}

/** Copied Work bodies and run control are separate from file/header/byte removal counts. This
 * source-only port does not claim typed-record closure, provider completion or financial settlement. */
export type DelegatedWorkPurgeCounts = {
  removed: number;
  remaining: number;
  controlsRemaining: number;
  unproven: number;
  confirmed: boolean;
};
export interface DelegatedWorkPurge {
  purgeSource(
    context: TenantContext,
    input: { sourceId: string; limit: number },
  ): Promise<DelegatedWorkPurgeCounts>;
  confirmInTx(
    tx: Tx,
    context: TenantContext,
    input: { sourceId: string },
  ): Promise<DelegatedWorkPurgeCounts>;
}

/** M4's agent runs. The flagship asks for one, and reads how it went. */
export interface AgentRuns {
  /** Durably bind the real run and waiting state to requestKey in the caller's transaction. No unbound
   * success and no model call; the run, outbox and onboarding state commit together. */
  requestRun(
    tx: Tx,
    context: TenantContext,
    input: { workUnitId: string; agentKey: string; requestKey?: string },
  ): Promise<{ agentRunId: string }>;
  statusOf(
    tx: Tx,
    context: TenantContext,
    agentRunId: string,
  ): Promise<{
    status: string;
    costMicros: number | null;
    /** Fresh identity and actual generated artifact IDs, read from M4's authoritative records. Older
     * adapters missing these fields cannot advance onboarding or publish its cost as measured. */
    workUnitId?: string;
    initiatorMembershipId?: string;
    artifactIds?: readonly string[];
    /** Complete retained output/attempt inventory before viewer filtering. Hidden history cannot choose a winner. */
    artifactState: 'none' | 'ready' | 'ambiguous' | 'unavailable';
  } | null>;
}
