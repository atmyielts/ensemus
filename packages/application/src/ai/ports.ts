// What governed AI needs from storage, as ports (ADR-028). @ensemus/intelligence and
// @ensemus/agent-runtime have no database import at all: they name what they need here, and the services
// beside this file supply it. That keeps a model call outside any transaction, by construction.
import type { AgentContext, TenantContext, Tx } from '@ensemus/database';
import type {
  AiClassification,
  AiReasonCode,
  BillingOwner,
  EgressDestination,
  LedgerStatus,
  ModelCapability,
  ModelProfileStatus,
  ModelPurpose,
  ProviderKind,
  RetentionBasis,
  UsageMeter,
} from '@ensemus/domain/ai';
import type { ExternalActionStatus } from '@ensemus/domain/external-action';
import type { ProposedExternalAction, ProposeExternalActionInput } from '../external-actions';

// So agent code, which may not import the database package at all, can name these.
export type { AgentContext, TenantContext, Tx };

// --- Model profiles.

/** What routing needs to know about a profile. There is no key here: only whether one is on file. */
export type RoutableProfile = {
  id: string;
  version: number;
  providerKind: ProviderKind;
  modelId: string;
  alias: string;
  endpointUrl: string;
  secretRef: string | null;
  billingOwner: BillingOwner;
  destination: EgressDestination;
  region: string | null;
  capabilities: readonly ModelCapability[];
  limits: { maxInputTokens: number; maxOutputTokens: number };
  allowedClasses: readonly AiClassification[];
  allowedPurposes: readonly ModelPurpose[];
  retentionBasis: RetentionBasis;
  contractRef: string | null;
  fallbackProfileIds: readonly string[];
  crossBillingApproved: boolean;
  status: ModelProfileStatus;
};

export type RateCardRef = {
  id: string;
  version: number;
  inputMicrosPerMtok: number;
  outputMicrosPerMtok: number;
  source: 'tenant_estimate' | 'ensemus_card';
};

/** Reads under the agent's tenant. A profile from another tenant cannot be returned: RLS, then a test. */
export interface ProfileStore {
  listCandidates(context: AgentContext): Promise<readonly RoutableProfile[]>;
  getProfile(context: AgentContext, profileId: string): Promise<RoutableProfile | null>;
  latestRateCard(context: AgentContext, profileId: string): Promise<RateCardRef | null>;
}

// --- Recording what was decided. Each method is its own short transaction.

export type EgressRecord = {
  runId: string | null;
  stepId: string | null;
  profileId: string | null;
  dataClass: AiClassification;
  purpose: ModelPurpose;
  destinationHost: string | null;
  decision: 'allow' | 'deny';
  reasonCode: AiReasonCode;
  policyVersion: string;
  requestHash: string | null;
  expiresAt: Date | null;
};

export interface EgressLog {
  /** Written for every decision, allow or deny, before anything leaves. A failure stops the call. */
  record(context: AgentContext, entry: EgressRecord): Promise<void>;
}

// --- Usage and budgets (ADR-028 FD-6, FD-12). Integers of micro-USD.

export type Headroom = {
  /** The smallest headroom of the budgets that apply. Null when no budget is configured. */
  availableMicros: number | null;
};

export type ReservationRequest = {
  runId: string;
  stepId: string;
  attempt: number;
  agentVersionId: string;
  amountMicros: number;
};

export type Reservation =
  | { ok: true; reservationId: string; amountMicros: number }
  | { ok: false; code: 'BUDGET_EXHAUSTED' | 'BUDGET_NOT_CONFIGURED' };

export type LedgerEntry = {
  idempotencyKey: string;
  meter: UsageMeter;
  quantity: number;
  unit: 'token' | 'call';
  costMicros: number;
  rateCardId: string | null;
  rateCardVersion: number | null;
  reservationId: string | null;
  workUnitId: string;
  runId: string;
  stepId: string | null;
  profileId: string | null;
  profileVersion: number | null;
  providerKind: ProviderKind | null;
  requestHash: string | null;
  status: LedgerStatus;
  correctsId?: string;
};

export type RunReconciliation = { ledgerMicros: number; counterMicros: number; matches: boolean };

/** `@ensemus/application/ai-usage` implements this over `ensemus_agent`. Web never calls it. */
export interface UsageLedger {
  headroom(
    context: AgentContext,
    query: { runId: string; agentVersionId: string },
  ): Promise<Headroom>;
  /** One atomic update per budget, so two reservations cannot both take the last of the headroom. */
  reserve(tx: Tx, context: AgentContext, request: ReservationRequest): Promise<Reservation>;
  /** Moves `amountMicros` from reserved to spent. May overspend what was reserved: it is what happened. */
  settle(
    tx: Tx,
    context: AgentContext,
    settlement: { reservationId: string; actualMicros: number },
  ): Promise<void>;
  release(tx: Tx, context: AgentContext, reservationId: string): Promise<void>;
  /** Same key twice is one row. Answers false when the row was already there. */
  record(tx: Tx, context: AgentContext, entry: LedgerEntry): Promise<boolean>;
  reconcileRun(context: AgentContext, runId: string): Promise<RunReconciliation>;
}

// --- A model turn's durable record (ADR-028 FD-12).

export type TurnStart =
  /** A step with this number already finished. Its stored outcome is the answer, and nothing is sent. */
  | { kind: 'already_done'; stepId: string; outcome: string }
  /** A row, in flight at this attempt. If `lostAttempt` is set, the caller records that estimate first. */
  | {
      kind: 'begin';
      stepId: string;
      attempt: number;
      lostAttempt: { attempt: number; reservationId: string; amountMicros: number } | null;
    };

export interface TurnStore {
  beginTurn(
    context: AgentContext,
    step: { runId: string; stepNumber: number },
  ): Promise<TurnStart>;
  /** Pins the run to a profile on its first turn. Refused if a different one is already pinned. */
  bindProfile(
    context: AgentContext,
    binding: { runId: string; profileId: string; profileVersion: number },
  ): Promise<void>;
}

// --- Halting (ADR-028 FD-15).

export type HaltTarget = {
  agentVersionId?: string;
  providerKind?: ProviderKind;
};

export interface HaltCheck {
  /** Throws AppError('AI_HALTED') if a switch covers this, or if the switches cannot be read. */
  assertRunning(tx: Tx, context: TenantContext, target: HaltTarget): Promise<void>;
}

// --- External effects. M3's real service behind a small port (ADR-027 D1, ADR-028).

export type ExternalActionState = {
  status: ExternalActionStatus;
  approvalId: string | null;
};

export interface ExternalActionPort {
  /** M3's `proposeExternalActionInTx`. Writes the intent and its approval, with one hash on both. */
  propose(
    tx: Tx,
    context: AgentContext,
    input: ProposeExternalActionInput,
  ): Promise<ProposedExternalAction>;
  /** Reads where M3's workflow has got to. Sending is M3's own workflow, started by its own event. */
  readState(tx: Tx, context: AgentContext, externalActionId: string): Promise<ExternalActionState>;
}

// --- Approvals for agent actions (AGENT-04).

export type ApprovalRef = { approvalId: string; externalActionId: string; requestHash: string };

export type RecheckResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'APPROVAL_NOT_VALID'
        | 'APPROVAL_EXPIRED'
        | 'APPROVER_LOST_ACCESS'
        | 'PAYLOAD_CHANGED'
        | 'RUN_NOT_RUNNING'
        | 'HALTED'
        | 'POLICY_DENIED';
    };

export interface ApprovalBinder {
  /** Picks the approver by policy, never from anything a model said, and proposes the intent. */
  request(
    tx: Tx,
    context: AgentContext,
    input: {
      proposalId: string;
      runId: string;
      workUnitId: string;
      connectionId: string;
      toolId: string;
      toolVersion: string;
      payload: unknown;
    },
  ): Promise<ApprovalRef>;
  /** In the same transaction as the step that acts on the approval. */
  recheck(tx: Tx, context: AgentContext, input: { proposalId: string }): Promise<RecheckResult>;
}

// --- Entitlements (ADR-028 FD-8). @ensemus/commercial implements this, and M6 and M8 extend it.

export type EntitlementResult =
  | { ok: true; billable: boolean; commercialMode: 'cloud' | 'byom' | 'sovereign' }
  | { ok: false; code: 'ENTITLEMENT_DENIED' };

export interface Entitlements {
  check(context: TenantContext, feature: string): Promise<EntitlementResult>;
}
