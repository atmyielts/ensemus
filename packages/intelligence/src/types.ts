// The model side of governed AI (ADR-028 FD-8 to FD-13). No database, no Temporal and no `ai` core here,
// by lint. What an adapter returns is untrusted, and a failure is a code from the list below: an SDK
// error can quote the whole prompt, so one never crosses the adapter's boundary.
import type { AgentContext, RateCardRef, RoutableProfile } from '@ensemus/application/ai-ports';
import type {
  AiClassification,
  AiReasonCode,
  ModelCapability,
  ModelOutcome,
  ModelPurpose,
  ProviderKind,
  StopCode,
} from '@ensemus/domain/ai';

/**
 * Structured roles keep a poisoned document as data (FD-17). Only `policy` ever reaches a model's system
 * role. Evidence and tool output go in the user turn, delimited, whatever they say.
 */
export type ContextMessage = {
  role: 'policy' | 'task' | 'evidence' | 'tool_output';
  /** Which part this is, for the secret scan's report. */
  partId: string;
  text: string;
  classification: AiClassification;
};

export type AdapterTool = {
  id: string;
  version: string;
  description: string;
  /** JSON Schema for the arguments, from @ensemus/contracts/ai-tools. */
  parameters: Record<string, unknown>;
};

export type AdapterCall = {
  providerKind: ProviderKind;
  modelId: string;
  endpointUrl: string;
  messages: readonly ContextMessage[];
  tools: readonly AdapterTool[];
  /** A JSON Schema the final output has to meet, or null for plain text. */
  responseSchema: Record<string, unknown> | null;
  maxOutputTokens: number;
  timeoutMs: number;
  /** A fresh guarded fetch for this call, pinned to its endpoint. Adapters use no other. */
  fetch: typeof fetch;
  /** Lent for this call only. An adapter must keep no reference to it after it returns. */
  apiKey: Buffer | null;
};

export type AdapterUsage = { inputTokens: number; outputTokens: number } | null;

/**
 * Exactly what was wrong with an answer that arrived whole but could not be used, so one fixed correction
 * can say so (a repair turn). A code from this list is the only thing about the answer that is kept: the
 * model's own words are never echoed back, logged or stored with it.
 */
export const MALFORMATIONS = [
  'multiple_tool_calls',
  'unknown_tool',
  'tool_args_not_json',
  'tool_args_not_object',
  'empty_output',
  'output_not_json',
  'output_schema_mismatch',
] as const;
export type Malformation = (typeof MALFORMATIONS)[number];

/** Every way a call can fail, with no provider text. */
export const ADAPTER_FAILURES = [
  'timeout',
  'cancelled',
  'rate_limited',
  'server_error',
  'auth_failed',
  'bad_request',
  'context_too_long',
  'malformed_response',
  'partial_response',
  'connect_failed',
  'endpoint_refused',
  'unknown',
] as const;
export type AdapterFailure = (typeof ADAPTER_FAILURES)[number];

export type AdapterResult =
  | { kind: 'final'; text: string; usage: AdapterUsage }
  /** The arguments are unparsed and untrusted, and the tool gateway validates them later. */
  | { kind: 'tool_call'; toolId: string; args: unknown; usage: AdapterUsage }
  | {
      kind: 'failure';
      failure: AdapterFailure;
      /** Whether the provider may have billed this call, so the ledger over-counts rather than under. */
      mayHaveBilled: boolean;
      usage: AdapterUsage;
      /** A provider's Retry-After, in milliseconds and already capped. Only a passing outage has one. */
      retryAfterMs?: number | null;
      /** Set for `malformed_response` when the answer was whole and only its shape was wrong. */
      malformation?: Malformation;
    };

/**
 * One model call and nothing more: no retries, no second step, no routing. Never throws for anything a
 * provider did, and never logs. A throw means a bug here, and the turn fails closed.
 */
export interface ModelAdapter {
  generate(call: AdapterCall, signal: AbortSignal): Promise<AdapterResult>;
}

/** An endpoint that passed `checkEndpoint`, with what the guard needs to pin it. */
export type VerifiedEndpoint = {
  host: string;
  port: number;
  protocol: 'https:' | 'http:';
  /** The operator's list allowed a private or plain HTTP address. A tenant can never set this. */
  viaPrivateAllowlist: boolean;
};

/**
 * A fetch for one endpoint. Resolves DNS once and connects only to that pinned address, refuses every
 * private range unless the operator listed it, and makes any redirect an error.
 */
export interface EndpointGuard {
  fetchFor(endpoint: VerifiedEndpoint): typeof fetch;
}

export type ProfileKeyRef = {
  organizationId: string;
  profileId: string;
  endpointUrl: string;
  secretRef: string;
  providerKind: ProviderKind;
};

/**
 * Lends a model key for one call, over SecretBroker. The purpose names the profile and endpoint, so a
 * key under a changed endpoint yields SecretUnavailable. Refuses a hosted kind unless the operator's
 * review interlock is set (FD-21). The buffer is wiped when `use` returns.
 */
export interface CredentialLender {
  withKey<T>(profile: ProfileKeyRef, use: (key: Buffer) => Promise<T>): Promise<T>;
}

/**
 * What a turn needs. It has no field for anything a model said, so an injected prompt has no way to
 * influence which provider is chosen (MODEL-03).
 */
export type InferenceTask = {
  runId: string;
  purpose: ModelPurpose;
  quality: 'economy' | 'balanced' | 'high';
  required: readonly ModelCapability[];
  classification: AiClassification;
  requiredRegion: string | null;
  allowFallback: boolean;
  /** Set after the first turn. A changed version stops the run (FD-13). */
  pinned: { profileId: string; profileVersion: number } | null;
};

export type RouteDecision =
  | {
      kind: 'selected';
      profile: RoutableProfile;
      rateCard: RateCardRef;
      /** Later entries of an explicit fallback list, each already through the full check. */
      fallbacks: readonly { profile: RoutableProfile; rateCard: RateCardRef }[];
      policyVersion: string;
    }
  | { kind: 'denied'; reasonCode: AiReasonCode; policyVersion: string };

export interface ModelRouter {
  select(task: InferenceTask, context: AgentContext): Promise<RouteDecision>;
}

export type StepRef = {
  runId: string;
  stepId: string;
  stepNumber: number;
  attempt: number;
  workUnitId: string;
  agentVersionId: string;
};

export type CompiledTurn = {
  messages: readonly ContextMessage[];
  tools: readonly AdapterTool[];
  responseSchema: Record<string, unknown> | null;
  task: InferenceTask;
  /** SHA-256 of the assembled messages, for the egress record and the ledger. */
  requestHash: string;
  maxOutputTokens: number;
  timeoutMs: number;
};

/** In memory only. The model's words go to `ai.step_payloads`, and never cross Temporal. */
export type TurnOutcome = {
  outcome: ModelOutcome;
  stopCode: StopCode | null;
  decisionCode: AiReasonCode | null;
  usage: { inputTokens: number; outputTokens: number; costMicros: number };
  profile: { id: string; version: number } | null;
  /** Present for `final_output`. */
  text: string | null;
  /** Present for `tool_proposed`. Unvalidated: this is the model's claim. */
  toolCall: { toolId: string; args: unknown } | null;
  /** Trusted metadata receipt, in memory only; never a model argument or a Temporal result body. */
  inputSnapshotId?: string;
  /**
   * Set when the turn ended on a passing outage and the caller asked to hold fallback (see TurnOptions):
   * the caller may try the turn again later, as a new step. Absent means the outcome is final.
   */
  retry?: { afterMs: number | null };
  /** Repair calls this turn made after an unusable answer. Each one counts as a model turn. */
  repairs?: number;
};

/** What the caller allows a turn beyond its first call. Absent means a turn behaves as it always has. */
export type TurnOptions = {
  /**
   * `hold`: a passing outage ends the turn with `retry` set, so the caller can wait and try the same
   * profile again durably. `fall_back`: the last round, where the outage moves down the explicit fallback
   * list as FD-9 allows.
   */
  transient?: 'hold' | 'fall_back';
  /**
   * One repair turn after an answer whose shape was wrong. The caller says whether its turn limit leaves
   * room for one more, and how many tokens are left for the run, since the gateway cannot see the counters.
   */
  repair?: { allowed: boolean; tokensLeft: number };
};

/**
 * The order below is fixed (FD-8), and a test proves each stage stops before the next: entitlement,
 * headroom, actor and class, candidates, capability, egress, reservation, secret scan, key, adapter,
 * output, ledger. A denial reserves nothing and opens no key.
 */
export interface InferenceGateway {
  turn(
    context: AgentContext,
    step: StepRef,
    compiled: CompiledTurn,
    signal: AbortSignal,
    options?: TurnOptions,
  ): Promise<TurnOutcome>;
}

/** Sends one synthetic prompt through the real path (FD-23). Holds no tenant data. */
export interface ProfileProber {
  probe(input: { organizationId: string; profileId: string }): Promise<'passed' | 'failed'>;
}
