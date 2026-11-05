# Product Requirements Document (PRD) — Ensemus

## 1. Executive summary

Ensemus is a configurable, secure, AI-native operating environment for organizations that want to coordinate people, processes, knowledge, and autonomous assistance in one coherent system. It targets companies with roughly 10–300 workers initially while keeping tenant and domain models capable of serving larger organizations. Industry specificity is achieved through typed custom objects, configurable workflows, integration packs, views, and policy profiles—not by cloning unrelated industry software.

### Core promise

> Give every worker the right context, every responsibility a clear owner, every AI action accountable permissions, and every business process a verifiable outcome.

## 2. Market position and exclusion boundaries

Initial customer wedge: agencies, consulting firms, professional services, software teams, and operational service companies with cross-team handoffs. Strategic advantage: common Work Units, evidence-based organizational intelligence, and governed human-agent execution. Do not market "unlimited AI" or claim replacement for specialist ERP, medical, payroll, or financial compliance systems without relevant integrations and domain validation.

Not in initial horizontal core: full payroll, payroll tax, accounting ledger, medical record system, regulated credit decisions, irreversible automated hiring rejection, or unsupervised financial transfers. Integrate with approved systems where necessary. Custom object support does not create regulatory compliance by itself.

## 3. Business objectives

- Reduce handoff latency and missed commitments between teams.
- Deliver useful AI execution without forcing users to continuously prompt a chatbot.
- Preserve organizational context as staff and tools change.
- Support the same operational primitives for Cloud, BYOM, and Sovereign customers.
- Provide predictable economics, measurable quality, and practical onboarding for small/medium organizations.

## 4. User jobs

1. **Founder / executive:** Know what is happening, where outcomes are at risk, and which decisions require attention.
2. **Team manager:** Organize work, delegate to humans/agents, resolve blockers, approve high-risk actions, and understand capacity.
3. **Individual contributor:** Find accurate context, complete work, delegate repetitive steps safely, collaborate, and publish deliverables.
4. **Operations administrator:** Configure the company structure, integrations, permissions, model routes, policies, and audit.
5. **Security/compliance lead:** Ensure authorized processing, control egress, investigate actions, and enforce retention.
6. **IT / Sovereign operator:** Deploy, upgrade, monitor, backup, and restore the platform without hidden cloud dependencies.

## 5. Functional requirements and IDs

| ID | Requirement | Acceptance evidence |
|---|---|---|
| ORG-01 | Create orgs with independent data, policy, and entitlements | Cross-tenant isolation suite |
| ORG-02 | Nested teams, multiple memberships, delegated administration | Membership and role tests |
| WRK-01 | CRUD versioned Work Units and dependencies; reject cycles | DAG integrity tests |
| WRK-02 | Assign human/agent owners, deadlines, completion criteria | State transition tests |
| WRK-03 | Resume work after wait/approval/outage without losing state | Temporal recovery test |
| AI-01 | Register multiple model providers and deployments | Router conformance tests |
| AI-02 | Select providers only after policy and classification gates | Negative routing tests |
| AI-03 | Version agents and skills, publish after safe simulation | Version/publish tests |
| AI-04 | Constrain cost, depth, time, tools, and permissions of runs | Budget/permission tests |
| MEM-01 | Permission-aware search over files and structured data | Retrieval + ACL tests |
| MEM-02 | Record provenance, freshness, and reversible memory writes | Traceability tests |
| INT-01 | Connect tools using approved OAuth/webhook/API integrations | Sync/action integration tests |
| INT-02 | Log external side effects with idempotency/reconciliation | Retry fault injection |
| SEC-01 | Default-deny secrets access and provider egress | Secret-canary tests |
| SEC-02 | Audit meaningful actions without storing sensitive payloads by default | Audit-redaction review |
| COM-01 | Three distinct commercial entitlement and routing modes | Mode matrix tests |
| COM-02 | Sovereign runs offline without vendor SaaS dependency | Air-gap test |
| UX-01 | Role-aware home, work, company search, and approvals | Usability studies |
| UX-02 | Nontechnical agent setup with visible autonomy settings | Task-based UX test |
| OPS-01 | Meter usage and reliability; exports and restore procedures | Billing/recovery tests |

## 6. Core functional surface

### Workspaces
Role-aware home; active Work Units, projects, clients, collections, tasks, approvals, knowledge, and agent runs. All surfaces share one work/entity model and authorization layer.

### Company Pulse
Evidence-backed organizational health, risk signals, due dates, bottlenecks, trend explanations, and drill-down to source data. It should not invent subjective employee performance scores or assert causation from incomplete data.

### Delegation and agent work
Employees create a Work Unit, select approved skills/agents, review policy-dependent autonomy, and track execution as a sequence of understandable actions. Delivered artifacts are inspectable and correctable.

### Knowledge and memory
Structured business objects are authoritative; connectors synchronize information with ACLs; search combines text and vector retrieval; facts require provenance and clear trust state.

### Extensions
Admins may add typed custom objects, workspace views, skills, connectors, and workflows without bypassing security boundaries. Extension review must display data access and side effects.

## 7. Nonfunctional requirements

Security: tenant isolation, auditable least privilege, credential vaulting, classified egress, strict provider allowlists, redacted telemetry, explicit approval for consequential writes. Reliability: durable jobs, bounded retries, backpressure, idempotency. Performance: objective budgets and measurable p95/p99 SLOs, not unsupported fixed promises. Accessibility: keyboard navigation, screen-reader labels, understandable statuses, responsive layouts. Portability: structured exports; customer-controlled deployment; model-neutral contracts. Observability: cost per successful outcome and traceable failure reasons.

## 8. Product success measures

North-star: **verified completed work with acceptable human effort and cost**. Supporting metrics: work completion lead time, blocked time, accepted artifacts, manual coordination reduction, agent correction rate, unauthorized-action rate (target zero), time to first value, user retention, and inference cost per verified completion. Guard against vanity metrics such as message count or agent count.

## 9. End-to-end example

Sales marks a deal won; the organization policy creates a client-onboarding Work Unit; agreements are retrieved through authorized connectors; approved agents draft a kickoff plan, request required approvals, and create artifacts; management handles exceptions; completion criteria verify project creation and kickoff readiness; the system records evidence and updates the client relationship. All side effects are logged and reconciled before retry.

## 10. Shipping criteria

A feature is not complete until the user journey, policy enforcement, failure recovery, telemetry, export behavior, and tests are implemented for all supported modes. See [Acceptance and DoD](../06-delivery/03-acceptance-and-dod.md).
