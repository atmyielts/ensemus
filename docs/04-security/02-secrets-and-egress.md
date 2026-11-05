# Secrets, model-provider egress, and confidential information handling

## 1. The problem

Company secrets can leak through much more than a chat response: provider inference payloads, external embedding APIs, connector logs, prompts and traces, exported reports, delegated agents, browser tools, developer consoles, source code, support tickets and crash dumps. A single universal "AI setting" is insufficient.

## 2. Secrets boundary

Tenant secrets, such as provider API keys and OAuth refresh tokens, are held behind the `SecretBroker` port (ADR-024 D5). Its default adapter uses envelope encryption with AES-256-GCM: ciphertext sits in a dedicated `secrets` schema that only the broker's database role can read, and the key-encryption key comes from a mounted file or an external KMS. A customer's own vault or KMS is another adapter behind the same port. In this suite, "vault" means this boundary, not a specific product.

The web tier holds only a public sealing key, so it can store a submitted credential but can never read one back. Database credentials and signing material stay in orchestrator secret mounts or a KMS, never in application tables. Applications persist an opaque `secret_ref`, never raw key bytes.

**Review gate:** the project owner chose this design on 2026-11-05 in place of a bundled vault. Outside security review is required before any real credential is stored. If the review rejects it, a vault adapter replaces the default without changing callers. Workers resolve secrets just-in-time for a single authorized action and discard them promptly. Prohibit secret interpolation in prompt templates. Mask exceptions and third-party diagnostic responses.

Suggested boundary: `AgentRuntime → ToolGateway → short-lived service credential → SecretBroker → authenticated external provider`. Only the broker/tool gateway can retrieve credentials; the model and agent context cannot.

## 3. Provider profile registration

Admin enters provider, exact endpoint, account/tenant owner, approved model IDs, authorized region, data-processing/retention basis, training opt-out or contractual controls (verified independently), allowed classifications, maximum cost, and fallback set. Private endpoints require networking validation and SSRF protections. Secret keys are submitted to secure credential capture and cannot be retrieved from UI after save.

## 4. Egress decision contract

Inputs: tenant, principal, task purpose, data class, provenance/source ACL, provider profile, destination/network address, contractual retention terms, user consent where required. Outputs: allow/deny, justification code, optional redaction transform, expiry, audit reference. Check before initial inference, embedding, reranking, OCR, transcription, evaluator calls, web browsing, file downloads, and external tool output uploads.

Default provider matrix:

| Data class | Ensemus-managed provider | Customer API provider | Customer-local private model |
|---|---|---|---|
| Public | Allow if approved | Allow if approved | Allow if approved |
| Internal | Policy + approved purpose | Policy + approved purpose | Policy + approved purpose |
| Confidential | Explicit provider approval, terms and purpose | Explicit provider approval, terms and purpose | Allow subject to local ACL/authorization |
| Restricted | **Deny by default** | **Deny by default** | Only specially authorized secure profile; may still be denied |

## 5. Endpoint security

No arbitrary egress URL accepted from prompts, untrusted documents, or normal tenant users. Use allowlisted DNS names/IP ranges and TLS certificate validation; reject private network IP destinations unless provisioned as an approved private endpoint. Disable uncontrolled proxy usage and DNS rebinding opportunities. Browser/code execution sandboxes receive distinct network policies.

## 6. Classification of derived artifacts

Summaries, embeddings, extracted facts, translated text, screenshots, cached context and generated reports inherit restrictions of source content until explicit safe redaction/declassification. Names, contractual terms, and project descriptions can themselves be trade secrets; masking only API keys is not enough.

## 7. Logging and observability

Never record raw provider requests/responses, complete retrieved documents, OAuth refresh tokens, secrets, system prompts, or personally identifiable content in standard telemetry. Default to identifiers, token counts, model deployment IDs, duration, status, redacted error reason. Debug capture requires customer-authorized request, strict expiry, masking, least access, and auditable purpose. Opt-in does not justify copying secrets.

## 8. Sovereign special handling

Offline installation must make no compulsory telemetry/license calls. Third-party self-host packages may emit their own telemetry; explicitly inspect configuration and network egress during deployment validation. The default support diagnostic exporter generates a reviewable encrypted bundle with content minimization. Customer retains and rotates all keys.

## 9. Negative security tests

- Secret string embedded in source document must not appear in model request to unapproved provider, logs, cache or exported trace.
- Agent asks to reveal API key: tool access denied regardless of prompt.
- User changes provider endpoint to arbitrary URL: rejected until privileged review.
- Confidential Google document is revoked: cache/search/context access ceases before next inference.
- Fallback from customer provider to vendor provider is rejected absent prior explicit approval.
- Token/embedding provider egress is tested separately from text generation routes.
