# Quality engineering and test pyramid

## 1. Testing principles

Use production-like auth roles, realistic tenants, deterministic fixtures, synthetic confidential data, and fault injection. No live client data in CI or third-party AI evaluation without explicit authorization. Functional tests alone are insufficient for an agent operating system; test policy, recovery, observability, latency, and model drift.

## 2. Test layers

| Layer | Examples | Cadence |
|---|---|---|
| Unit | State transitions, cycle detection, policy predicates, amount/cost math | Every change |
| Database | RLS tenant context, same-tenant foreign keys, migration rollback, index plans | Every migration |
| Contract | OpenAPI, event schemas, agent specs, connector interface, provider adapter | Every change |
| Integration | Temporal recovery, outbox/inbox, OAuth revoke, file ingestion | Pull request/staging |
| Agent eval | Evidence-backed output, tool choice, schema accuracy, security red-team | Every agent/prompt/model change |
| End-to-end | First setup, team assignment, approval, agent work, billing mode change | Release gate |
| Performance | Mixed-tenant load, p95/p99, vector-filter recall, saturation | Regular benchmark |
| Security | Cross-tenant, injection, secrets leak, SSRF, supply chain, air-gap | CI + prelaunch audit |
| Recovery | Backup restore, lost provider, worker crash, unknown side effect | Scheduled drills |
| Accessibility | Keyboard, screen reader, contrast, reduced motion | UI release gate |

## 3. Core scenario set

- A company manager creates work with a dependency and cycle attempt is rejected.
- Two tenants with same client name never share a result, model context, memory, or cache entry.
- Revoked document stops appearing in results even before search projection refresh.
- BYOM route fails closed rather than using Ensemus provider.
- Sovereign boots without network egress.
- Approved email body changed after approval causes denial.
- Retry after tool timeout reconciles external state and avoids duplicate send.
- Confidential attachment enters indexing; embedding endpoint choice follows egress policy.
- Agent delegates subtask; child cannot exceed parent scope or budget.
- Memory candidate contradicts verified fact; remains disputed, not authoritative.

## 4. Agent evaluation gates

Separate task-specific truth sets from model subjective grading; prefer deterministic verification. A published Agent Version must demonstrate task completion quality, stable cost, no critical permission violations, acceptable correction rate, and reversible rollout. Validate compatibility against every supported provider class, not every known model.

## 5. Release evidence

CI artifacts, threat register updates, test environment IDs, anonymized traces, deployment manifests, benchmark results, migration plan, approval signatures, and customer impact notes. The DoD is explicit about what has been implemented versus what remains planned.
