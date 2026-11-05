# Acceptance criteria, Definition of Done, and non-negotiable release gates

## General Definition of Done (every feature)

- User journey demonstrably works in supported deployment modes.
- Domain and API contracts versioned; data migration and compatibility checked.
- Tenant/role/resource authorization implemented, not delegated to model prompts.
- Negative tests for denied access and error boundaries pass.
- Failure states, retries, cancellation and idempotency documented and tested if feature has external effects.
- Metrics/traces sanitize customer content; costs/quotas measured if AI/compute involved.
- Privacy, retention, export, and audit consequences documented.
- UI accessible, meaningful empty/error/loading states, nontechnical copy.
- Threat model impact reviewed; provider/connector egress verified.
- Developer docs and end-user release notes updated; rollback viable.

## Gate A — core security

Two isolated tenants, restricted and confidential data, malicious document, and compromised tool fixtures. No cross-tenant result, no unapproved egress, no plaintext secret logs, no unauthorized tool action. Any critical failure blocks release.

## Gate B — work integrity

Work Unit DAG cycle rejection, same-tenant FK validation, concurrent version conflict, human/agent assignment, dependency resolution, approval expiry, artifact proof and corrected reopening. Fault injection ensures no duplicate consequential external action.

## Gate C — intelligence

A published agent passes schema, tool-choice, grounding and policy evaluations; maintains hard token/step/cost limits; successfully stops, pauses and resumes; produces evidence-linked artifacts; fails closed on unavailable approved model; does not treat model-generated unsupported facts as trusted memory.

## Gate D — memory and connectors

Source ingestion preserves tenant, ACL, classification, version and citation; unauthorized retrieval cannot return restricted chunks; revocation blocks serving immediately; derived indexes/cache eventually purge and report completion; provider egress for embeddings and rerankers validated.

## Gate E — each commercial mode

**Cloud:** included credits metered and enforced, approved model gateway, no surprise overages.

**BYOM:** customer credentials protected, provider account is billed externally, no vendor-provider fallback, platform behavior stays functional when provider unavailable except model-dependent features.

**Sovereign:** clean offline install from signed bundle, local inference, no compulsory vendor endpoint, maintenance expiration does not shut down licensed release, test backup/restore and offline upgrade, third-party license inventory complete.

## Gate F — operating readiness

On-call runbooks, cost dashboards, rollback, database and object restore, model/connector outage drills, event replay safety, incident escalation, security disclosure process, customer export verified, and production RPO/RTO/SLAs agreed.

## Sign-off template

Feature/release ID, scope, responsible owner, test report URL, threat assessment, data classification, modes tested, provider contracts, deployment notes, known exceptions, approvers and release decision. Exceptions require named expiry and mitigation; security-critical invariants cannot be waived by an agent publisher.
