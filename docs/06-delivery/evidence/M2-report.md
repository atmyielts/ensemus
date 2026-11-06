# M2 evidence report: core work without AI

**Date:** 2026-11-06 (Asia/Tashkent)
**Status:** implemented and verified on the committed baseline; continuation checks passed locally. **M2 is not formally closed.** QA-007's exact email scenario, the owner review and inherited M1 requirements remain open. No production deployment or pilot acceptance is claimed.

The inspected checkout started at `780d4fb8cfa292d40527d5452acfa83a3402d27b`, branch `m1-release-skeleton`. Continuation is on `codex/m2-continuation`. The pending form fix was already present when this continuation started; it has been preserved and independently reviewed. This report distinguishes that working tree from the committed CI baseline.

## Implemented behavior

People can create an organization, invite and confirm members, organize teams, create clients and projects, and run work without a model. Work has an accountable owner, scoped human assignments, a dependency DAG, optimistic versions, files, exact-content approvals and history. Checklist plans execute in Temporal through the dispatcher and transactional outbox. A generated checklist does not count as independent completion evidence. Work comments are catalogued in the specification but are not implemented in this checkout.

Home, Work, People, Clients, approvals and the inbox expose this behavior through authorized server reads and actions. The public API validates versioned contracts. Authenticated status streams recover from durable state, including across two web replicas. Authorization is checked afresh; this is not a claim that distributed ACL-cache infrastructure has been built. Notifications and reminders are in-app and available offline; recipients see them when they open Ensemus.

Files have object-store bytes and a separate tombstone ledger. Restore tests exercise the documented reapply procedure. The ledger protects files/artifacts within [ADR-026's boundaries](../../00-foundation/adr/ADR-026-tombstones-survive-restore.md), including its undrained-ledger, cached-clear and unavailable-store limitations. This is not universal deletion or backup/restore acceptance for the full future product.

## Continuation changes: UX-13 / API-11 and FOUND-01

- Preserved the pending Work-detail form gate: while one form is submitting, the other submit buttons wait until its response is rendered. A subsequent action then uses the current version instead of conflicting with the person's own save. Refused saves release the gate and keep the draft. Server authorization and optimistic locking remain authoritative.
- Preserved the delayed-response browser regression, the assertion that controls return after a refused save, and assertions against saved objective text rather than text still present in the edit field.
- Excluded `.claude/**` from ESLint, as formatting already does. Lint was traversing dozens of nested Claude worktree copies; it now checks this checkout without checking those separate clones.
- Reconciled the README, delivery-plan status, M2 ticket statuses and QA tracking with the evidence below. QA-007 now also traces to its M3 intent/receipt tickets, so the email-specific verification has an explicit owner. No milestone assignment or acceptance criterion has been removed.

Changed implementation/test files: `apps/web/src/app/o/[organizationId]/work/[workUnitId]/page.tsx`, `apps/web/src/components/{one-action-at-a-time,submit-button}.tsx`, `apps/web/src/lib/action-gate.ts`, `tests/unit/web-action-gate.test.ts`, `tests/browser/specs/{drafts,product}.spec.ts`, and `eslint.config.mjs`.

**Schema/API/events:** no changes in this continuation. **Migrations:** none added; the baseline's real release-upgrade gate applied six migrations between `a603fc9` and `780d4fb`. **Secrets/config:** no new secrets, external services or runtime settings. Only the lint exclusion changed.

## Fresh local verification

Windows, Node 24.13.0, pnpm 10.17.0 and Docker Desktop. Commands below were executed against this working tree with throwaway test values.

| Command | Observed result |
|---|---|
| `pnpm format:check` | Passed, including the reconciled README |
| `pnpm lint` | Passed after excluding nested worktrees; original crawling run was stopped |
| `pnpm --filter @ensemus/web exec next typegen` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test:unit` | 331 passed in 27 files, including six form-gate tests |
| `pnpm test:replay` | 14 passed; one history-capture test skipped by design |
| `pnpm check:backlog` | Passed after reconciliation: 143 live tickets, 108 traced items |
| `pnpm check:contracts` | Passed; generated contracts unchanged |
| `pnpm check:licenses` | Passed: 251 production packages on Windows; four license categories still need counsel review |
| `pnpm audit --prod --audit-level high` | Passed at the configured threshold; one moderate advisory remains |
| `pnpm check:proxy` | 27 behaviors checked, zero failed |
| `pnpm stack:up` | Built web/worker images; stack and both web replicas healthy |
| `pnpm test:browser` | 131 passed in Chromium (7.2 minutes), including the delayed-save and refused-save gate regressions |
| `pnpm test:integration` | 427 passed in 12 files on a fresh isolated PostgreSQL database (84.49 seconds), including actual roles, denied/cross-tenant cases and OIDC |

Integration used the temporary Compose project `ensemus-m2-continuation` with network prefix `172.38`. The main test stack was stopped while its fixed host ports were needed, its volumes were preserved, and it was restored afterwards. Only the temporary project's newly created volumes were removed. Browser and integration logs are in `.local/m2-continuation-browser.log` and `.local/m2-continuation-integration.log` (ignored by git).

`git diff --check` passed, and the 20 relative documentation links in the README, delivery plan and this report resolve. The documentation manifest was regenerated.

Fresh unit/replay checks and browser tests do not establish hosted, real-provider, independent security or human usability acceptance. The browser suite checks axe, keyboard behavior, themes, responsive layouts, failure recovery and JavaScript-disabled forms; it is not independent WCAG certification.

## Committed baseline CI

Inspected directly with `gh run view 42228039404 --json jobs,url,headSha,conclusion` and `gh run view 42228039404 --log`. [Run 42228039404](https://github.com/atmyielts/ensemus/actions/runs/42228039404) passed all six jobs (`quality`, `integration`, `proxy`, `stack`, `browser`, `upgrade`) at **780d4fb**. These are results for that commit, not for the uncommitted continuation.

| Gate | Baseline result |
|---|---|
| Unit | 325 passed |
| Replay | 14 passed; one capture test skipped |
| Integration, actual PostgreSQL roles | 427 passed in 12 files |
| Stack, built containers | 292 passed; one deliberate skip |
| Chromium browser | 130 passed |
| Air-gap positive control | 11 deliberate outbound packets detected |
| Air-gap full stack and outage round | Zero outbound attempts, counted by the gate |
| SBOM and offline manifest verification | Signature valid; modified manifest and SBOM rejected, using throwaway signing material |
| Release upgrade from `a603fc9` | A paused approval survived six migrations and the upgraded work reached Done |
| Proxy | CI job passed |

The air-gap, upgrade and signing gates have not been rerun locally for this continuation. No backend, workflow, schema or deployment behavior changed in the pending UI fix. A future CI run must verify the final committed continuation before it acquires its own CI evidence.

## M2 ticket evidence

`verified_ci` in the backlog refers to the committed baseline above, within the M2 scope stated here. It does not mean independent review, production readiness or milestone sign-off.

| Ticket | Evidence and limits |
|---|---|
| WORK-01 | `tests/integration/work.test.ts`, `state-integrity.test.ts`, `tenant-rules.test.ts`: versions, state transitions and tenant-safe references |
| WORK-02 | Concurrent DAG/cycle cases in `tests/integration/work.test.ts`; same-tenant constraints |
| WORK-03 | `tests/integration/access-scopes.test.ts`: human owner and scoped delegates. The [data model](../../02-architecture/03-data-model.md) explicitly permits only human assignments until M4; agent delegation is not implemented here |
| WORK-04 | File hashes, linking and criteria in integration tests; `tests/stack/joined-member-slice.test.ts` proves joined member → plan → file → review → completed work |
| WORK-05 | Hash binding, expiry, reviewer access and invalidation in integration/stack tests. Exact changed-email-recipient scenario QA-007 remains partial below |
| WORK-06 | `tests/integration/dispatcher.test.ts`, `idempotency.test.ts`, `tests/stack/real-failures.test.ts`: outbox/inbox dedupe and crash paths |
| WORK-07 | `tests/replay/`, `tests/stack/workflow-behaviour.test.ts`, `work-execution.test.ts`; real baseline upgrade gate |
| API-10 | Server-only DAL, import boundaries and denied reads in integration/stack tests |
| API-11 | `tests/stack/server-actions.test.ts`, `scopes.test.ts`, refused/audited mutation cases; pending form gate changes coordination only |
| API-12 | `tests/stack/api.test.ts` and generated-contract checks |
| API-13 | `tests/stack/replicas.test.ts`, `tenant-streams.test.ts`, browser live-status tests: reconnect and tenant scoping |
| SEC-12 | `tests/stack/replicas.test.ts`: disabled membership, role removal, restricted-work delegation and sign-out take effect across replicas |
| ID-01 | `tests/stack/first-owner.test.ts`, product flows, signup/setup and JavaScript-disabled browser tests |
| ID-02 | Invitation expiry/revocation/confirmation, inviter authority and tenant denial in integration, stack and browser tests |
| UX-11 | Browser axe, theme, viewport, keyboard and failure-state coverage; independent audit remains later |
| UX-12 | Role-filtered Home, assigned work, empty states and pagination in integration/browser tests |
| UX-13 | Work views, evidence and version conflict tests; fresh continuation adds coordinated submissions |
| UX-14 | Bound approval details and keyboard decision flow in browser tests |
| UX-15 | Directory filtering, team hierarchy/cycle and membership tests |
| UX-16 | Same-named clients isolated across tenants, linked projects/work, UI and FK tests |
| UX-17 | Offline in-app inbox and deterministic reminder workflow; no email notification service claimed |
| LIFE-01 | `tests/integration/tombstone-ledger.test.ts`, `reapply-command.test.ts`, `tests/stack/restore.test.ts`; files only, bounded by ADR-026 |

## Exit scenario status

| Scenario | Status / owning tests |
|---|---|
| QA-001 / QA-002 | Verified in baseline CI: tenant isolation, same-named clients, denied API/SQL access |
| QA-003 | Verified in baseline CI: `tests/stack/tenant-streams.test.ts` uses one person in two organizations and switches streams |
| QA-004 / QA-005 | Verified in baseline CI: sequential and concurrent reverse-edge/cycle insertion |
| QA-006 | Verified in baseline CI: completion denied without required evidence; full joined-member slice |
| QA-007 | **Partial:** generic action-hash invalidation is tested. No email sending exists in this checkout, so changing recipients after email approval has not been verified. Full scenario remains required in M3; this is not a waiver of the M2 exit |
| NEXT-01 | Verified in baseline CI: forged/cross-tenant Server Actions refused and audited |
| NEXT-02 | Verified in baseline CI: client/RSC and diagnostics secret-canary scans |
| NEXT-03 | Verified in baseline CI: immediate access revocation across two built web replicas |
| NEXT-04 | Verified in baseline CI: workflows survive web restart and status recovers; browser reconnect tests |

## Measurements and forecast

[M2-measurements.json](M2-measurements.json) is a prior developer-machine measurement, not rerun here and not production capacity evidence. It used six tenants, 5,000 rows each, and 1,000 read samples per case. Isolated single-row reads had p95 **2.36 ms** versus **1.76 ms** without isolation; the transaction helper plus ORM had p95 **3.08 ms**. The reported full-read and baseline p95 values differ by **1.32 ms** on that machine; this is not a paired measurement of each transaction's overhead.

Dispatcher delay was p95 **521 ms** at idle and **3,725 ms** for a burst of 200 events, about **51 events/s**. At 200 status streams, the one-replica poller issued about **1,994 statements/s**, delivered changes at p95 **991 ms** with no missed sampled changes, and served the work page at p95 **47 ms**. Those figures support keeping the current bounded poller for local M2 use, and put stream fan-out and dispatcher bursts on the measurement list before widening pilots. They do not meet a named production load profile or establish an SLA.

**Forecast from observed delivery:** 22 M2 ticket implementations and the M2-specific baseline gates are present, while 106 planned tickets belong to M3–M11. This is an inventory, not a complexity-weighted completion percentage. The repository history spans only 2026-11-05–06 and contains extensive generated/parallel work plus later review fixes; it supplies no stable rate of independently accepted milestones or owner review throughput. Consequently the original 18–36 month guess is not validated by these commits, and no replacement calendar date is defensible. The next forecastable batch is integrating the **four M3 tickets**, running their real connector/fault/browser gates, and measuring elapsed integration plus owner-review time. Re-forecast at that evidence point and again at M5, as the plan requires.

## Privacy, modes and outstanding gates

- The form gate holds a boolean/count in page memory, introduces no storage or telemetry, and grants no authority. Drafts retain the existing per-person scope. Denied/cross-tenant behavior remains server-enforced.
- Cloud, BYOM and Sovereign share this code and the offline-capable built stack. The baseline air-gap test is evidence for this current non-AI stack; it does not certify local inference, licensing, hosted billing or full commercial-mode parity.
- M1's outside security review, legal entity/jurisdiction and signing-key custody decisions remain open. Real credentials and real-provider acceptance are still prohibited until the required review.
- M1 reproducible builds, image vulnerability scans, complete tracing and counsel's license review remain incomplete here. Later local hardening branches contain work, which is not acceptance evidence for this checkout.
- Data residency remains an owner decision from Before M2; no jurisdiction or residency guarantee has been invented.
- QA-007's exact scenario and overall owner sign-off remain open. No dates, approvals, external-review findings or production claims have been fabricated.

## Manual reproduction and continuation

1. Follow the root README's local test-stack setup; use throwaway accounts and data.
2. Create work, open **Edit the details**, change its objective and save. During a delayed save, **Mark ready** waits. Once saving finishes, mark it ready and confirm the saved objective and new status both remain, without a version-conflict error.
3. In another tab, change the same work before saving the first draft. The stale save must explain the conflict and preserve typed text; after refusal, the other controls must become available again.
4. Run `pnpm --filter @ensemus/browser-tests exec playwright test specs/drafts.spec.ts specs/product.spec.ts` against the test stack for automated reproduction. The browser suite deliberately stops services/changes tables in some tests; use a test stack only.

The next product milestone is M3. Local branch `m3-verified-actions` at `78b38e9` contains a merged implementation and a report that explicitly leaves its integrated CI and connector exit tests unverified. Inspect its ADR-027 and report, integrate in dependency order, preserve the M2 continuation, then run the M3 gates. M4–M11 foundations and slice branches must not be merged wholesale or marked done from their existence. No later milestone code was imported by this continuation.

**Review:** a separate read-only review agent found no actionable defect in the form gate or lint exclusion; its focused gate unit run passed six tests. This is an internal code review, not the required outside security review. Rollback of this continuation removes the client gate and lint exclusion; it needs no data rollback.
