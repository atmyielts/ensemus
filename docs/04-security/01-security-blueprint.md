# Security blueprint — customer secrets and organizational trust

## 1. Security objective

No tenant, employee, agent, provider, integration, or operator may access or disclose business information outside explicit authorization. Preserve integrity of decisions and external actions and maintain usable service during failures. Design for independent customer sovereignty and observable enforcement, rather than unprovable "secure AI" claims.

## 2. Data classifications

| Class | Examples | Default model egress | Logging / export |
|---|---|---|---|
| Public | Published website and product descriptions | Permitted to approved models | Minimal metadata; content only if purpose permits |
| Internal | Non-sensitive SOPs and internal projects | Only approved provider profiles | No raw prompts by default |
| Confidential | Client contracts, private plans, financial reports | Approved region, contract, and purpose; otherwise deny | Encrypted, strict ACL, no normal prompt tracing |
| Restricted | API keys, credentials, regulated/sensitive data, trade secrets explicitly marked as such | **Deny external provider egress by default**; use private approved inference or non-AI path | Strongest access, no general logs; explicit retention |

Classification propagates through copying, summarization, embeddings, search, exports, artifacts and agent delegations. Mixing data inherits the strongest applicable classification unless formal redaction/declassification is performed and recorded.

## 3. Security controls by layer

- **Edge:** TLS, secure cookies/sessions, rate limits, CSRF protections, input validation, DNS/SSRF protections.
- **Identity:** OIDC/SAML where supported, MFA for privileged actions, short sessions for elevated operations, least-privilege service accounts.
- **Authorization:** deny-by-default RBAC+ABAC, tenant-aware RLS, record ACLs, permission checks at search and tool boundaries.
- **Secrets:** vault/KMS, envelope encryption, rotation, time-bounded worker access, no secret payloads in traces/prompts.
- **Data:** encryption at rest/transit, key lifecycle, source revocation, retention, protected backup copies.
- **Agent runtime:** budget/capability sandbox, prompt injection defenses, explicit approval checks, output schema validation.
- **Integrations:** scoped tokens, signed webhook verification, outbound allowlists, action reconciliation.
- **Supply chain:** SBOM, pinned dependencies, image signing, vulnerability scanning, reproducible build evidence.
- **Monitoring:** redacted audit, anomaly alerts, restricted incident access, local-only Sovereign telemetry by default.

## 4. Zero trust for AI

There is no "trusted model" capable of overriding central authorization. A model's response is treated as a proposal. Policy evaluation uses authenticated server principal + tenant + requested resource + exact operation + data classification + destination + risk, not words from the model. No hidden provider fallback, no route to arbitrary public LLM when confidentiality rules fail.

## 5. Access governance

Admin, billing, security steward, agent publisher, and break-glass operator are separate roles. A tenant owner is not automatically a viewer of personal restricted HR or legal records. Customer support cannot assume standing permission to inspect company documents. Break-glass requires purpose, time limit, notification where possible, and review.

## 6. Security ownership

Ensemus operates SaaS infrastructure and gateway enforcement for Cloud/BYOM; customers configure classifications, connectors, users, providers, and approved delegates. Sovereign customers control hosting/key custody and model endpoints, while Ensemus remains responsible for contracted software fixes/support. A shared responsibility matrix belongs in each contract; no broad claim that one party takes every risk.

## 7. Verification

Minimum prelaunch: code review, SAST/DAST/dependency scanning, architecture threat workshop, RLS tests using production-like roles, integration pen test, prompt injection/adversarial evaluation, secrets-canary traces, backup restore test, and air-gap network testing. Engage independent security review for production launch and periodically thereafter.
