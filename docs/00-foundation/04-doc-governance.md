# Document governance and implementation discipline

**Status words:** Proposed (design only), Accepted (approved decision), Implemented (in code), Verified (tested in a named environment), and Deprecated. No document should blur design intent with delivery status.

**Versioning:** `vMAJOR.MINOR.PATCH` for product releases, `vMAJOR.MINOR` for public APIs and event envelopes, immutable Agent Version IDs, semantic versions for skill packages. Every breaking schema change requires explicit consumers, migration, and staged rollout.

**Document ownership:** Product owns vision, PRD, and UX; architecture owns ADRs, contracts, and domain models; security owns threat model and incident plan; ops owns reliability; finance/legal owns commercial terms. Coding agents may propose but not silently approve security or contract changes.

**Change workflow:** issue → proposed ADR/spec diff → design review → policy review (if data egress, permissions, providers, or licensing) → test plan → implementation → release evidence → status update. Use links to source code, CI results, and deployment manifests when implemented.

**Confidential material:** This suite is a blueprint, not a repository for customer API keys, commercial agreements, personnel records, actual client documents, or production run traces. Examples use fictional records. Never paste credentials into prompts, test fixtures, bug reports, or ticket descriptions.

**Reviewer checklist:** Did the change preserve tenant isolation, BYOM behavior, Sovereign offline operation, auditability, default-deny agent permissions, and rollback? What are its cost and latency consequences? Are customer-facing UI concepts understandable without AI/engineering jargon?

**Documentation quality gate:** Every major feature has a product requirement, API/data contract, authorization matrix, performance envelope, failure behavior, integration tests, telemetry definition, and acceptance criteria before shipping.
