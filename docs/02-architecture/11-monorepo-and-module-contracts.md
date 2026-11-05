# TypeScript monorepo structure and module rules

## Proposed layout

```text
ensemus/
  apps/
    web/                         # Only user-facing HTTP/API/BFF; Next.js App Router
  workers/
    workflow/                    # Temporal Workers + Activities
    ingestion/                   # Indexing, connectors, CPU work
    dispatcher/                  # Outbox publisher + reconciler
    realtime/                    # OPTIONAL only if benchmarks demand sockets
  packages/
    domain/                      # Pure Work Unit, client, team, agent abstractions
    contracts/                   # Zod/JSON schemas, API DTOs, events, validation
    database/                    # Drizzle schema, migrations, RLS helpers
    auth/                        # OIDC/session + actor identity and delegation
    policy/                      # ABAC, classification, access + egress decisions
    secrets/                     # Vault abstraction; NEVER browser-importable
    intelligence/                # Model routing/adapter, inference meters
    agent-runtime/               # Typed bounded agent loop, tools, skills
    knowledge/                   # Ingestion, retrieval, ACL + context compiler
    workflows/                   # Shared Temporal workflow/Activity contracts
    integrations/                # Connectors, sync cursors, MCP tools
    commercial/                  # Signed entitlements and mode rules
    telemetry/                   # Redacted metrics, trace propagation
    ui/                          # Shared accessible components + design tokens
  infrastructure/
    containers/                  # Web and worker Dockerfiles
    compose/                     # Profiles + operational examples
    scripts/                     # Health, backup, restore, migrations, license
  tests/
    unit/ integration/ security/ load/ e2e/ sovereign-offline/
  evaluations/
    agents/ routing/ memory/ safety/
  docs/
    ...
  pnpm-workspace.yaml
  package.json
  turbo.json                    # Optional pipeline accelerator, not a runtime
```

A pnpm monorepo is recommended; Turborepo is optional. Pin Node.js supported LTS, package manager version and dependency checksums. Build artifacts and source maps must not leak embedded credentials.

## Dependency direction

`web / worker entry points → application services → domain / contracts` and `application services → port interfaces ← infrastructure adapters`. No package inside `domain` imports Next.js, Drizzle, Temporal, Vercel AI SDK, or browser globals.

- `packages/domain`: pure TypeScript business invariants and state transitions.
- `packages/database`: infrastructure adapters implement the domain's repository ports; own transaction + RLS helpers.
- `packages/policy`: pure decision engine plus explicit source adapters; cannot call LLM to approve an action.
- `packages/workflows`: deterministic workflow definitions; external I/O only in Activities.
- `packages/intelligence`: OpenAI/Anthropic/Google/local adapters and model policy, no domain hardcoding.
- `packages/ui`: no imports from server-only packages (lint + build gate).
- Every package defines public entrypoints via `exports`; avoid arbitrary deep imports.

## Contracts and errors

Use strict TypeScript plus Zod for runtime validation of all external inputs, configuration, tool args, model structured outputs and events; generate JSON Schema/OpenAPI as appropriate. Do not mistake compile-time TypeScript types for runtime validation. Make explicit domain error codes, correlation IDs, redacted messages, and idempotency keys. Track schema versions separately from package versions.

## Build and CI

`format → lint → typecheck → unit → integration → Next build → worker bundle → contract/security/eval checks → SBOM → image vulnerability scan/sign → staged deployment`. Cache builds only by content hash; invalidate when schema, policy or agent definitions change. Include smoke tests from *built* images, not just source.

## Code agent rules

- Implement a full vertical slice; maintain tests and docs in same change.
- Never add a second backend framework or new datastore without ADR.
- No mock responses served as production behavior; only explicit test doubles.
- No secrets in logs, traces, fixtures, client bundles or error outputs.
- Require Cloud/BYOM/Sovereign contract verification for changes touching model, data, entitlement, identity or deployment.
