// What company knowledge needs from the rest of the product (ADR-029 D5). A small port, so this package
// needs no model SDK, no database and no network, and so M4's router can implement it at the final merge
// without this package changing. Types only.
import type { KnowledgeCode } from '@ensemus/domain/knowledge';
import type { Classification } from '@ensemus/domain/policy';
import type { ModelPurpose as CanonicalModelPurpose } from '@ensemus/domain/ai';

export type ModelPurpose = 'embed' | 'rerank' | 'answer';

export type RouteRequest = {
  organizationId: string;
  purpose: ModelPurpose;
  /** The strongest class of everything that would go. The caller works it out, and cannot omit it. */
  classification: Classification;
  /** For `embed`, the space existing vectors are in. A route into another space is a new space. */
  spaceHint?: {
    modelId: string;
    dimension: number;
    vectorSpaceVersion: string;
    modelProfileRef?: string | null;
    modelProfileVersion?: number | null;
    qualificationId?: string | null;
  } | null;
};

export type ModelRoute = {
  modelProfileRef: string;
  modelProfileVersion: number;
  modelId: string;
  providerKind: string;
  /** Host only, for the egress ledger. Never a URL with a path, a query or a credential. */
  destinationHost: string;
  policyVersion: string;
  /** Required by the actual bridge; legacy unqualified routes cannot be used by it. */
  qualificationId?: string;
  purpose?: ModelPurpose;
  classification?: Classification;
  /** Set for `embed`. The port must return vectors of exactly this length. */
  embedding?: { dimension: number; vectorSpaceVersion: string };
};

export type RouteDecision =
  | { decision: 'allow'; route: ModelRoute }
  /** Nothing was unsealed and nobody was contacted. Policy's own code, for the ledger, and no text. */
  | { decision: 'deny'; reasonCode: string; policyVersion: string };

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Micro-USD, or null when no rate card applies. Never a guess. */
  costMicros: number | null;
  /** The canonical paid attempt. A domain writer accepts this receipt in its own transaction. */
  callId?: string;
  /** Protection of a used model result includes every input, including uncited ranking passages. */
  classification?: Classification;
};

export type ModelInputRef = {
  kind: 'chunk' | 'work_unit' | 'project' | 'client';
  id: string;
  sourceId?: string;
  sha256: string;
  classification: Classification;
};
export type ModelCallMetadata = {
  /** Stable trusted operation, never model-selected citation arguments. */
  operationKey: string;
  /** Explicit exhaustive actual-read inventory, including an explicit empty list for a raw query. */
  inputs: readonly ModelInputRef[];
};

export type EmbedResult = { vectors: readonly (readonly number[])[]; usage: ModelUsage };

export type RerankResult = {
  /** Positions in the `passages` passed in, best first. May be shorter than the input. */
  order: readonly number[];
  usage: ModelUsage;
};

/**
 * The same shape as M4's `ContextMessage`, so it passes straight to its adapters. The roles keep a document
 * from speaking as the system (05-context-compiler): only `policy` ever reaches a model's system role.
 * `task` is the question, and `evidence` is untrusted data. An evidence part's `partId` is its citation key.
 */
export type KnowledgeMessage = {
  role: 'policy' | 'task' | 'evidence';
  partId: string;
  text: string;
  classification: Classification;
};

export type AnswerResult = { text: string; usage: ModelUsage };

/**
 * Model calls for knowledge work. Implemented over M4's router and adapters, so the same egress policy,
 * key handling, budgets and kill switch apply, and only in the process that can reach a model. A test
 * double lives in `@ensemus/knowledge/testing`, which lint keeps out of every shipped entry point.
 */
export interface KnowledgeModelPort {
  /** Trusted adapter capability only: the durable gateway records its own actual allow decision. */
  readonly recordsCalls?: true;
  /** Asks policy and picks a model. Contacts nobody and unseals nothing, so a deny is free and safe. */
  route(request: RouteRequest): Promise<RouteDecision>;
  embed(
    organizationId: string,
    route: ModelRoute,
    inputs: readonly string[],
    signal: AbortSignal,
    metadata: ModelCallMetadata,
  ): Promise<EmbedResult>;
  rerank(
    organizationId: string,
    route: ModelRoute,
    query: string,
    passages: readonly string[],
    signal: AbortSignal,
    metadata: ModelCallMetadata,
  ): Promise<RerankResult>;
  answer(
    organizationId: string,
    route: ModelRoute,
    messages: readonly KnowledgeMessage[],
    signal: AbortSignal,
    metadata: ModelCallMetadata,
  ): Promise<AnswerResult>;
}

/** Thrown by a port when a call failed. A code only: no provider text gets this far. */
export class ModelCallFailed extends Error {
  override name = 'ModelCallFailed';
  constructor(readonly code: KnowledgeCode) {
    super(code);
  }
}

/**
 * A deterministic look for what must not go further: key formats, PEM blocks, tenant canaries. Implemented
 * by M4's `scanForSecrets` in `@ensemus/policy`. It returns codes, and never the text. A hit raises the
 * document, which normally stops it being embedded. An extra signal, and never the only boundary.
 */
export interface ContentScanPort {
  scan(text: string): { raiseTo: Classification | null; codes: readonly string[] };
}

/**
 * A virus scanner, if a deployment has one. No implementation ships, and `not_scanned` is what a document
 * then says (ADR-029 D4). Whether to require one before a pilot is the owner's decision.
 */
export interface MalwareScanPort {
  scan(bytes: Uint8Array): Promise<'clean' | 'flagged' | 'not_scanned'>;
}

/**
 * A provider that does not exist yet, for the egress simulator (AGENT-11). The fields are what M4's
 * `EgressProfileFacts` needs, so `decideEgress` can be asked about it as it would be about a real profile.
 */
export type EgressProposal = {
  /** A column of data-egress-matrix.csv. */
  destination:
    'ensemus_cloud_managed_model' | 'customer_byom_public_api' | 'customer_private_inference';
  destinationHost: string;
  billingOwner: 'customer' | 'ensemus';
  retentionBasis: 'unreviewed' | 'contract_recorded' | 'self_hosted';
  region: string | null;
  contractRef: string | null;
  /** The classes the proposal says it may carry. */
  allowedClasses: readonly Classification[];
  purposes: readonly CanonicalModelPurpose[];
};

export type EgressVerdict = { allow: boolean; reasonCode: string; policyVersion: string };

/**
 * Asks egress policy about a provider that does not exist yet. Pure in M4's `decideEgress`: it transmits
 * nothing, holds no key and writes nothing, which is what AGENT-11 requires.
 */
export interface EgressPolicyPort {
  evaluate(input: {
    organizationId: string;
    proposal: EgressProposal;
    classification: Classification;
    purpose: CanonicalModelPurpose;
  }): EgressVerdict;
}

/** One workflow or agent that would send data to a model, and what classes it handles. */
export type EgressWorkload = {
  key: string;
  kind: 'knowledge' | 'agent';
  purpose: CanonicalModelPurpose;
  classes: readonly Classification[];
};
