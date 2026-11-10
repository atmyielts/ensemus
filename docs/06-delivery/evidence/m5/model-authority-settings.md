# Native model authority settings — source checkpoint

Scope: MODEL-01 / MODEL-02 / KNOW-04 / ADR-029 model qualification and bounded Knowledge workloads. This is source evidence, not a release or live-provider acceptance statement.

## Implemented behavior

- Existing Models settings now expose an exact capability test for semantic indexing, search ranking or grounded answers. The request pins profile version, purpose, server-derived protocol and (for embeddings) explicit dimension and vector-space version. Every per-call/per-job token, cost and deadline bound is entered explicitly. A connection probe cannot substitute for this evidence.
- Safe, manager-only qualification history shows durable job state/refusal, current versus earlier profile version, result digest and qualification timestamp. An unknown paid outcome is explicitly unconfirmed and has no automatic retry. Requests merely queue work; the web process has no model transport, credential lender, raw payload read or Temporal poller.
- A leaf under Models records expiring workload approvals for organization search/answers/agent evidence or exactly one source/connection for document indexing. Approvals retain exact qualification IDs, purposes, classification ceiling, scope, expiry and bounds. Runtime policy, access, organization budget and availability remain necessary for every call. Unavailable approval/evidence leaves search lexical or generation refused.
- Approval locks the selected actual profile rows while checking current qualification/version; it never asks the app role to lock agent-only qualification rows. Reused request keys cannot widen authority. Missing or foreign revocation IDs refuse; an already-revoked local approval remains safe to revoke again.
- API and form handlers use the original verified native context from the shared tenant boundary, including required-SSO. The real request services call `model_profile.activate` or `model_workload.approve` inside the effect transaction; no session/MFA/protocol/activation flag is accepted from the browser. Conservative revocation requires manager authority but no new MFA proof. No navigation, global CSS, shared UI primitive or migration was added.
- New native forms use the existing PageHead, ErrorNotice, Empty, SubmitButton, ConfirmForm, classification badge and shared field/list/facts classes. Forms and confirmation work without JavaScript. No spending cap, expiry, embedding precision or model choice is guessed.

## Verification

Executed in the isolated source checkout, serialized:

- `pnpm --filter @ensemus/contracts generate`: passed; canonical OpenAPI types regenerated.
- Scoped Prettier and ESLint with zero warnings: passed.
- `pnpm exec vitest run --project unit tests/unit/model-workload-settings.test.ts tests/unit/ai-model-profile-pages.test.ts tests/unit/openapi-contract.test.ts --maxWorkers=1`: **120 tests / 3 files passed**.
- Application and web (`next typegen` + no-emit) TypeScript checks: passed.
- Initial browser-test types reached a pre-existing DOM/Undici stream type mismatch in the real synthetic qualification fixture's transport import. No type suppression, test configuration change or weaker fixture was introduced; the isolated stream adapter correction is a separate prerequisite checkpoint.
- Final bounded gate including the stream prerequisite: **179 tests / 4 files passed**, scoped Prettier/ESLint (zero warnings) and `git diff --check` passed. Intelligence, integration-test and browser-test no-emit checks passed, including the final disabled-manager regression. Browser execution was not performed.

Authored, not executed here: eight real-role/native-session cases (fresh manager reads, member/foreign-tenant denial, stale/absent native proof, exact request-key bounds, stale-MFA conservative revocation, wrong version/purpose, disabled-manager stale context and concurrent profile change) and three browser cases (no-JS explicit bounds/step-up refusal, real generated qualification → bounded approval → stale-MFA revoke, denied member/foreign tenant/identity-smuggling requests). The browser fixture uses auth-role generated proof and synthetic model transport; it does not prove human MFA enrollment or live provider quality.

## Pending joined gates and reproduction

The parent owns migration journals/snapshots and the joined PostgreSQL/Temporal runtime. 0216 must precede the 0404 native approval backstop. Actual restricted-role DB tests, browser/axe/no-JS execution, worker availability, live/native provider qualification, production MFA/SSO and commercial-mode acceptance remain pending. Cloud credit holds/billing and M8 eraser reach remain separately pending joins; this screen grants none of those missing capabilities.

Reproduce after the joined gate: Settings → Models → a profile with a Knowledge purpose → enter explicit capability identity and one-call ceilings → verify MFA if prompted → inspect the recorded worker outcome. Then Models → Knowledge workload approvals → select exact usable evidence and explicit scope/class/bounds/expiry → approve. Revoke from the recorded approval and verify new calls stop while any already-dispatched accounting remains retained.
