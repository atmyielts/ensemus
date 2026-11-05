# Three commercial modes — functional, security, and deployment contract

This document is normative product architecture. Pricing and final legal terms require business/legal approval.

## Mode A — Ensemus Cloud (Ensemus models included)

**Commercial:** recurring subscription to Ensemus; includes platform hosting and specified AI usage allowances. Ensemus pays providers from its own business accounts. Provider cost exposure must be controlled through bundled credits, tier rules, rate limits, max run cost, and purchased top-ups. No unbounded "unlimited" usage promises.

**Architecture:** tenant-scoped provider profiles managed by Ensemus; centralized inference gateway; policy first, then cost/quality router. The system must track provider, purpose, data classification, retention terms, locality, cost, and evidence of permission. Customer content may leave Ensemus to an approved model provider under disclosed contractual terms and policy; "not used for training" must be verified per provider agreement, not assumed.

**Customer:** subscribes once to Ensemus; not required to hold external model subscriptions. Model selection can be automatic within approved policies or manually constrained by admins.

## Mode B — Ensemus BYOM (customer models)

**Commercial:** recurring platform subscription excluding third-party inference; customer pays model providers or operates private inference. Subscription still covers platform compute, storage/entitlements, support level, indexing, etc. If Ensemus offers any platform-metered overages, disclose them separately and do not re-bill customer-owned model tokens.

**Architecture:** customer supplies provider account credentials via encrypted secret vault or private network endpoint. Keys are organization-specific, not visible to application users/agent prompts. Supported endpoint types: hosted APIs, private VPC endpoint, OpenAI-compatible API with explicit compatibility contract, or self-hosted serving interface. Provider routes must be tested for tool use/structured output and required data policy. No silent fallback to Ensemus-managed inference. Embeddings, OCR, rerankers, and evaluator models are also billable inference components: customers must know which require a provider.

**Privacy caveat:** BYOM does not mean Ensemus never processes prompts or documents; in SaaS mode, authorized data still passes through Ensemus platform services and its storage/memory/logging boundary. A private endpoint plus SaaS does not guarantee zero third-party egress unless configured and verified.

## Mode C — Ensemus Sovereign (one-time perpetual license)

**Commercial:** one-time fee buys a perpetual license to specified Ensemus version/edition and authorized deployment footprint. The license is for use of software, not ownership of the Ensemus IP unless an explicit separately negotiated assignment is signed. Customer provides/operates models and pays hardware, cloud, third-party, and model expenses. Maintenance is a **separate optional agreement** for security patches, fixes, upgrades, support, and professional services; a lapsed maintenance contract does not disable continued operation of the purchased licensed release.

**Architecture:** customer-controlled infrastructure, private database, object storage, inference gateway and models. Standard deployment profiles: network-connected self-hosted, private cloud, and offline/air-gap. Must not depend on Ensemus-hosted licensing checks, analytics, identity, updates, model gateway, or secrets vault to continue operating; offline entitlement validation is local. Customer may elect to send opt-in diagnostic exports for support, redacted by default.

**Distribution:** build a signed software bill of materials (SBOM), third-party notices, release checksums, deployment artifacts, support compatibility matrix, offline deployment tests, operational runbooks, upgrade scripts, and export tools. Review rights to redistribute components and use community versus enterprise editions; e.g., bundled Langfuse enterprise features must never be assumed free.

## Capability parity matrix

| Feature | Cloud | BYOM | Sovereign |
|---|---|---|---|
| Work Units, graph, knowledge | Yes | Yes | Yes |
| Agent Studio, skills, approvals | Yes | Yes | Yes |
| Model routing | Ensemus providers | Customer providers | Customer providers |
| External AI inference bills | Ensemus (covered within package) | Customer direct | Customer direct |
| Platform recurring license | Yes | Yes | No after one-time payment |
| Hosting ownership | Ensemus | Ensemus | Customer |
| Offline operation | No | No | Supported deployment profile |
| Vendor telemetry | Strictly minimal, configured | Strictly minimal, configured | Disabled by default |
| Updates | Ensemus-managed | Ensemus-managed | Supplied under maintenance terms, self-applied or paid services |
| Customer data ownership | Customer | Customer | Customer |

## Mode-switching and migration

Cloud↔BYOM should be reversible without moving business records. Switching model profiles prompts an explicit egress/privacy review and tests for embedding dimensionality, features, compatibility, and provider account limits. Moving to Sovereign requires export of relational data, blobs, indexes or reindex material, agent/skill versions, credentials re-bindings, and a verified restore. External service credentials are never exported as plaintext. Sovereign→Cloud migration requires an explicit customer-authorized import contract.

## Shared non-negotiables

No hidden model fallback; no customer secrets in prompts by default; provider egress classified and auditable; per-tenant isolation; explicit license obligations; transparent costs and statuses; export capability; honest data-processing statements; and no plan-specific weakening of core security boundaries.
