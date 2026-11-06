# Canonical model purposes: separable source checkpoint

The canonical domain/profile purpose vocabulary now contains the existing `classify`, `extract`, `reason`, `research`, `compose` plus the genuine Knowledge purposes `embed`, `rerank`, `answer`. No new purpose is mapped onto `reason`. Existing approved profile purpose arrays are not expanded automatically.

The Knowledge call port remains restricted to its three actual primitives. Its egress simulation proposal, workload, policy evaluation and result fields use the canonical eight-purpose type, as do runtime input validators, the request/response OpenAPI enums and model-settings labels. This allows real M4 workloads to be represented by the same pure egress policy instead of a Knowledge-only union or a not-wired mapping.

Two pure regressions cover canonical domain/contract agreement and passing every distinct purpose through simulation without aliases. No new migration, provider call, capability qualification, budget or model-job schema is mixed into this checkpoint. Extending the vocabulary alone does not qualify any profile for a new model operation.

Fresh source validation on 2026-11-07:

- `pnpm --filter @ensemus/contracts generate` passed; the actual OpenAPI generator produced the declaration changes, with no other generated contract changes.
- Scoped Prettier write/check, scoped ESLint with zero warnings and `git diff --check` passed.
- `pnpm exec vitest run --project unit --maxWorkers 1 tests/unit/ai-vocabulary.test.ts packages/knowledge/src/egress-simulation.test.ts packages/policy/src/egress.test.ts`: 102 tests passed across three files (1.54 seconds).
- Sequential no-emit checks passed for domain, contracts, knowledge, application, web (including Next route type generation) and tests.

No database, Docker, build, real-provider, replay or browser acceptance was executed for this source checkpoint. The actual Knowledge model job/qualification/runtime bridge remains the next implementation scope.
