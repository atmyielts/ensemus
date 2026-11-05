# Ensemus design principles and non-negotiable invariants

## Product principles

1. **Company-centered, not app-centered.** The unit of meaning is an organization with people, responsibilities, relationships, knowledge, and measurable outcomes. Workspaces organize attention; they are not arbitrary collections of pages.
2. **People own accountability.** Agents operate within delegated rights; management approval remains necessary where consequence, uncertainty, law, or contract demand it.
3. **Universal core, configurable edges.** Keep identity, Work Units, audit, policy, and event semantics strongly typed; allow bounded custom entities, views, schemas, and processes for industries.
4. **Native UX, not chat everywhere.** Search, context, agent work, and direct actions should enhance normal surfaces (tasks, clients, projects, meetings). A chat entry point is optional, not required.
5. **Useful first, expansive second.** Deliver complete workflows and verified outcomes instead of shallow feature counts.
6. **Security defaults cannot be bypassed through customization.** Capability packs, agents, and custom objects must use shared authentication, authorization, provenance, and audit controls.
7. **Customer choice.** The same domain contract must support managed AI, BYOM, and Sovereign without entangling business entities with specific provider SDKs.

## Technical invariants

| Concern | Rule | Verification |
|---|---|---|
| Data boundaries | Every tenant-owned row and derived record has explicit tenant identity and source ownership | Cross-tenant query and cache tests |
| Authorization | Default deny; check before search, before tool execution, and when emitting results | Denial and confused-deputy scenarios |
| AI routing | Policy and capability eligibility precede any cost/quality routing | Provider routing suite |
| Durable work | Retryable workflows have durable state and idempotent or reconcilable effects | Crash / retry / network-partition tests |
| Evidence | Important assertions preserve source IDs, validity, and information class | Provenance tests |
| Memory | No automatic promotion of model guesses into trusted organizational facts | Memory write tests |
| Observability | Identifiers, costs, statuses and redacted error codes—not raw secrets—are default telemetry | Secret-canary tests |
| Cost | Budget and concurrency ceilings are enforced before invocation | Budget-exhaustion tests |
| Sovereign | Offline deployments function without Ensemus-hosted APIs | Air-gap acceptance test |
| Ownership | No hidden dependency on vendor-held keys for continued use of a perpetual licensed version | License disconnect test |

## Architecture guardrails

- Primary system of record: PostgreSQL. Durable process state: Temporal. Object blobs: customer-authorized storage. Derived views can be rebuilt from authoritative records.
- Modular monolith for most business domains initially; separately scalable inference/agent, ingestion, and connector workers as needed.
- Typed contracts and transactional consistency inside core domains; asynchronous events for cross-domain reactions.
- Skills describe behavior; tools execute capabilities; policies authorize actions; models propose next steps. These responsibilities are never merged.
- Prefer stable primitives over custom orchestration frameworks, distributed agents, and premature streaming complexity.
- Avoid accidental lock-in from dependencies. Sovereign distribution requires explicit legal and technical approval for each bundled component.

## Product anti-goals

- Unlimited or unmetered provider inference under an economically unbounded subscription.
- Agents that can read all organizational data by default.
- Agent-to-agent chatter as the primary mechanism for routine deterministic workflows.
- Exposing internal AI engine terminology in employee-facing UI.
- Arbitrary native code installed from an unreviewed skills marketplace into privileged containers.
- Pretending that a purchased license gives the customer title to Ensemus intellectual property.
- Claiming security standards, certifications, or third-party provider privacy conditions without evidence.
