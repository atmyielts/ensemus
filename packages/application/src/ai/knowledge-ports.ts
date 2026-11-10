import type { AgentContext, TenantContext } from '@ensemus/database';
import type {
  ModelJobBounds,
  QualifiedModelOperation,
  KnowledgeModelPurpose,
} from '@ensemus/domain/knowledge-models';
import type { Classification } from '@ensemus/domain/policy';
import type { ModelCallMetadata, ModelUsage } from '@ensemus/knowledge/ports';
import type { RateCardRef, RoutableProfile, Tx } from './ports';

export type KnowledgeModelPrincipal =
  | { kind: 'job'; context: TenantContext; jobId: string }
  | {
      kind: 'agent_run';
      context: AgentContext;
      step: {
        runId: string;
        stepId: string;
        stepNumber: number;
        attempt: number;
        workUnitId: string;
        agentVersionId: string;
      };
    };
export type KnowledgeModelCandidate = {
  profile: RoutableProfile;
  rateCard: RateCardRef;
  qualification: QualifiedModelOperation;
  approvalId: string | null;
  bounds: ModelJobBounds;
  deadlineAt: Date;
  /** Only the exact fixed synthetic qualification request may use a probing profile. */
  qualifying: boolean;
};
export type PrepareKnowledgeCall = {
  candidate: KnowledgeModelCandidate;
  purpose: KnowledgeModelPurpose;
  classification: Classification;
  requestHash: string;
  metadata: ModelCallMetadata;
  ceiling: { inputTokens: number; outputTokens: number };
  policyVersion: string;
  qualificationProofHash?: string;
};
export type KnowledgeCallClaim = { callId: string; state: string };
export type ModelResultTarget =
  | { kind: 'embeddings'; id: string; spaceId: string }
  | { kind: 'answer' | 'evidence' | 'qualification'; id: string };
export type ModelResultConsumer = (
  tx: Tx,
  usage: ModelUsage,
  target: ModelResultTarget,
) => Promise<void>;
export interface KnowledgeCallStore {
  candidates(
    principal: KnowledgeModelPrincipal,
    purpose: KnowledgeModelPurpose,
  ): Promise<readonly KnowledgeModelCandidate[]>;
  prepare(
    principal: KnowledgeModelPrincipal,
    input: PrepareKnowledgeCall,
  ): Promise<KnowledgeCallClaim>;
  dispatch(principal: KnowledgeModelPrincipal, callId: string): Promise<boolean>;
  settle(
    principal: KnowledgeModelPrincipal,
    callId: string,
    input: {
      usage: { inputTokens: number; outputTokens: number } | null;
      mayHaveBilled: boolean;
      reasonCode: string | null;
    },
  ): Promise<ModelUsage>;
  recoverUnknown(principal: KnowledgeModelPrincipal, callId: string): Promise<void>;
  assertResultFresh(principal: KnowledgeModelPrincipal, callId: string): Promise<void>;
}

/** Cloud prepaid credit holds need the approved M8 card, not an inferred USD/credit conversion. */
export interface KnowledgeCloudSpend {
  reserveInTx(
    tx: Tx,
    context: TenantContext,
    input: {
      callId: string;
      ceilingMicros: number;
      profileId: string;
      modelJobId: string | null;
      runId: string | null;
    },
  ): Promise<void>;
  settleInTx(
    tx: Tx,
    context: TenantContext,
    input: { callId: string; costMicros: number; status: 'final' | 'estimated' },
  ): Promise<void>;
}
