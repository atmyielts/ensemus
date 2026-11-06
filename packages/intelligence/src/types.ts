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
  ): Promise<TurnOutcome>;
}

/** Sends one synthetic prompt through the real path (FD-23). Holds no tenant data. */
export interface ProfileProber {
  probe(input: { organizationId: string; profileId: string }): Promise<'passed' | 'failed'>;
}
