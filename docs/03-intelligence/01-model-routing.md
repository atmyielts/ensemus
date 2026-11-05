# Model-neutral intelligence routing — TypeScript-native, policy first

## Scope

Ensemus owns **capability selection, tenant authorization, cost/quality policy and provider-egress decisions**. Model SDKs are replaceable transports. We favor the open-source Vercel AI SDK/provider registry (for Node) and direct provider adapters where necessary; **LiteLLM is not mandatory** in v2.0. A proxy may be introduced for central operational billing or multi-language consumption only with a measured business case.

## Execution sequence

`RequestedTask → Actor/tenant + data classification → Approved model/provider candidate set → Capability conformance → Health/rate/budget constraints → Estimated total outcome cost → Selected adapter → Pre-send payload inspection/egress guard → Inference → Typed result validation → Metering + audit`.

No provider selection or fallback happens before data policy. If a model cannot accept required capabilities/structured output, fail gracefully or choose another **approved** model; do not simulate support by silently dropping required constraints.

## Abstract contract

```ts
export type InferenceTask = {
  tenantId: string; actorId: string; runId: string;
  purpose: 'classify' | 'extract' | 'reason' | 'research' | 'compose';
  quality: 'economy' | 'balanced' | 'high';
  required: ('tools' | 'structured_output' | 'vision' | 'long_context')[];
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  allowedProviderProfileIds: string[];
  maxCostUsd: number; timeoutMs: number;
  dataResidency?: string;
};
export interface InferencePort {
  generate(task: InferenceTask, authorizedPayload: unknown): Promise<{
    data: unknown; modelProfileId: string; usage: UsageReceipt;
  }>;
}
```

This is an **illustrative type**. Actual code uses Zod validators, strongly typed prompts/tools/outputs, explicit provider payload types, redaction/classification metadata, cancellation and streaming interfaces.

## Provider registry

For each endpoint/model deployment store: opaque model profile ID, provider and region, supported modalities/capabilities, max input/output, structured-output quality, tool-call semantics, token/usage measurement, price schedule, billing owner, tenant allowlist, retention/training contractual settings, approved data classes, latency/availability SLO observations, tokenization/version, and testing date. Model registry is never an excuse to store raw API keys in normal rows; credentials are vault handles.

**Model neutrality does not imply model equivalence.** Provider-specific features remain optional plugins behind capability flags; tool schemas, image inputs, token counts, streaming and reasoning controls have conformance tests.

## Three mode rules

- **Cloud:** Ensemus pays/operates inference; expose included metered allowance, explicitly opt-in overages and fair-use. Quota denial must preserve Work Unit and not charge the customer for failed executions that violate policy.
- **BYOM:** customer supplies approved provider key or private endpoint; customer bears provider bill. Ensemus-hosted workers may still process authorized plaintext; document that BYOM is *not* zero-knowledge SaaS. Credentials live in encrypted tenant-bound vault with short-lived retrieval for authorized workers only.
- **Sovereign:** all routing and conformance checks run locally, using customer model keys, local inference and locally installed model registry. No mandatory Ensemus cloud inference or licensing validation.

## Security, reliability and cost controls

Preflight sensitivity, tenant settings, regions, procurement agreements, blocked providers and explicit consent. Deny arbitrary model base URLs to prevent SSRF; approved endpoint verification, TLS and egress allowlists are required. An agent cannot choose a new provider by prompt injection. Provider response is untrusted and subject to output validation.

Use per tenant/team/run budgets and reservations, then reconcile actual usage. Include retries, tool calls and verification in cost per **verified outcome**. Make fallback conditional on idempotency and compatible semantics. No blind retry of tool side effects.

Record provider ID, model alias, request hash, token/cost totals, latency, policy decision code, error class and trace ID—not raw prompts or document passages by default. Keep opt-in debug content isolated, encrypted, access-reviewed and time-limited.

## Benchmarks and acceptance

Conformance tests include structured JSON accuracy, tool calls, multimodal safety, long-context truncation, cancellation, timeouts, rate limits, streaming/partial results, pricing changes, policy-denied fallback, quota exhaustion and adapter upgrades. Track outcome quality plus cost/latency, not arbitrary benchmark scores.
