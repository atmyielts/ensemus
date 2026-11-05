# Environment profiles, build reproducibility, CI/CD and release

## Environments

`local` (containerized dependencies and local Node web/workers), `ci` (ephemeral DB/Temporal, seeded synthetic tenants), `staging` (production-like identities/roles and traffic), `production-cloud`, `production-byom` (same SaaS runtime with different credential provider mode), `sovereign-connected`, `sovereign-airgap`.

## Build pipeline

Lock Node LTS and pnpm version; dependency restore with lockfile freeze → lint/types → unit and API contracts → Drizzle migration/RLS smoke → worker deterministic replay tests → Next.js build and client bundle secret canary scan → integration tests with Temporal/Postgres/object store → web e2e and agent evaluations → load smoke → vulnerability scan/SBOM/license review → sign web/worker images/release manifest → stage → canary.

## Release manifest

Records `release`, Git commit, image references + sha256 digests, DB schema version, event version, API major, agent-runtime protocol version, Temporal worker compatibility range, Node version, required infrastructure, supported commercial modes, feature/license schema version, SBOM digest and image signing key identifier.

## Deployment safety

No production credentials during build; supply at runtime via secrets. Migrate once with lock and backup; restrict broad RLS bypass role to migration job only. Store immutable images in a registry exportable for offline installation. Every release runs schema expand/contract compatibility and active workflow replay tests.

## Tests and evidence

Collect signed CI artifacts, release notes and test results, baseline performance under defined load, security negative tests, data deletion/revocation, offline network capture, and restore proof. Failed gates halt rollout. A customer-owned Sovereign operator can verify signed images/manifest without vendor contact.
