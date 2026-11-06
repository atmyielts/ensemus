# M3 evidence report: verified external actions

**Date:** 2026-11-06
**Status: implemented and exercised locally; formal closure remains open.** The original report preceded execution. The continuation below records actual merged-tree results separately from CI and external acceptance. No new CI run or production release is claimed.

M3 is what lets Ensemus do something it cannot take back. The exit in the [delivery plan](../06-end-to-end-delivery-plan.md) is Slice 2 passing, and `QA-007`, `QA-008`, `QA-019` and `AI-TS-01` passing, with fault injection at timeout-after-send. The decisions are in [ADR-027](../../00-foundation/adr/ADR-027-verified-external-actions.md), which is **proposed** and awaits the owner and an outside security review.

**No real credential has been stored or used, and no real provider or mail relay has been contacted.** Every test uses generated values, `@example.invalid` addresses and a test sink.

## Results

| Gate | Where it runs | Result |
|---|---|---|
| Format, lint, typecheck, unit and replay after the merge | CI `quality` | **Not yet run on the merged tree** |
| Integration tests, real PostgreSQL roles | CI `integration` | **Not yet run on the merged tree** |
| Stack suite with no profile, zero outbound attempts | CI `stack` | **Not yet run on the merged tree** |
| Slice 2 and the exit scenarios, `tests/stack/slice-2.test.ts` | CI `connectors` | **Not yet run in CI on the merged tree** |
| Air-gap gate, `--connectors` round | CI `connectors` | **Not yet run in CI on the merged tree** |
| Replay of the new workflows' histories | CI `quality` | **Not yet run on the merged tree** |

The owner authorized continued platform completion. The integrator runs isolated local container projects with generated test configuration; these local checks do not substitute for the CI or outside-review gates.

## Local continuation, 2026-11-06

M3 was composed with the newer M2 controls on `codex/platform-completion` (`0cd34eb`, followed by `bb3b27b` and `9357d37`). Source worktrees and their uncommitted work were preserved before integration.

| Command / scope | Actual local result |
|---|---|
| `pnpm test:unit` | **831 passed**, 46 files; includes bounded SMTP reply and gate/pin regressions |
| Full PostgreSQL integration on isolated `ensemus-m3-integration` | **819 passed**, 20 files |
| `pnpm test:replay` | **90 passed**, 16 explicit capture cases skipped |
| Connector stack files: Slice 2, webhook route, external action API | Initial **33 passed, 1 failed, 1 skipped**; the new self-approval assertion expected 409 while the correct result was 403. Corrected API file rerun: **17 passed** |
| Other built-stack files | **300 passed, 1 failed**; the aggregate API coverage check incorrectly included operations owned and checked by the dedicated connector file. Scoped it to its own operations; complete API file rerun: **54 passed** |
| Full browser run | Initial **141 passed, 6 failed**; fixed a real accessible-label mismatch and two test assumptions (oldest-first queue and sign-out navigation timing) |
| Browser confirmation: `external-actions.spec.ts`, `drafts.spec.ts` | **27 passed**, including all affected journeys and the four receipt-state axe checks in both themes/widths |
| Air-gap deliberate-attempt control, isolated private subnet | **Passed**: direct and DNS attempts detected; container addresses checked |
| Connector zero-egress air-gap round | **11 passed**, five messages reached the test relay, **zero outbound attempts** |

The SMTP reader now bounds aggregate unread wire bytes, including parsed multiline replies and queued complete replies. Four focused parser checks pass, including two negative controls that failed before the fix. No real relay or provider was contacted. Local logs are in the ignored `.local/m3-*.log`; the table records their results without treating those local files as durable CI evidence.

## What each exit scenario is held by

These scenarios were exercised by the local connector stack run above. CI confirmation and independent review remain open.

| Scenario | The test in `tests/stack/slice-2.test.ts` | What it checks on real containers |
|---|---|---|
| Slice 2 | `goes from a signed callback to a receipt, one message, and work that can finish` | A signed post gets 202, the worker verifies it, an intent waits, the owner approves what is shown, the sink takes one message with the exact recipients and no Bcc header, a provider's receipt is on the page, and the work completes |
| `QA-008` | `sends once, ends unknown, tells the owner, says so, and lets them say what they found` | The sink takes the message and goes silent. One message, `unknown` past the deadline, no second one after a further minute, the owner's inbox, the page's words, the record naming who resolved it |
| `AI-TS-01` | `still ends with one message, unknown, and asking again takes a new approval` | `docker kill` on the connector worker while the attempt is open and the sink is silent, then a restart. One message, `unknown`, and a retry that waits for its own approval |
| `QA-007` | `leaves the old one unable to send, and only the new recipients ever get anything` | With the worker stopped, approve and then revise. The old intent and its approval are closed, the old run contacts nobody when the worker returns, and only the new approval sends |
| `QA-019` | `makes one intent, whichever way it is replayed` | ADR-027 D4's three replays, one intent, and nothing sent |
| Denied | `refuses an unsigned post...`, `does nothing for another tenant's token...`, `shows a member of another tenant nothing...`, `lets only the person named...`, `lets only someone who manages connections...` | Unsigned, wrong key, altered body, an unknown address, another tenant's token and pages by every path, and the wrong approver |
| Confidentiality | `keeps a recipient, a subject and a body out of Temporal, logs and events` | Canaries in a recipient, a subject and a body, with a control for each scan, and a credential, secret and token absent from Temporal, logs and the database |

The same path with no containers beyond PostgreSQL is in `tests/integration/verified-actions-path.test.ts`: real outbox and dispatcher role, real broker, real email connector over real TLS, the real egress gateway code in-process, and a relay in the test process. Temporal and the web server are not in it, so it is not the exit and does not replace the table above.

What sits underneath, in each slice's own tests: `tests/integration/external-actions.test.ts`, `connections.test.ts`, `connector-sync.test.ts`, `webhooks.test.ts`, `email-connector.test.ts` and `receipts.test.ts`, with `tests/stack/external-actions-api.test.ts`, `webhook-route.test.ts` and `tests/browser/specs/external-actions.spec.ts`.

## Ticket status

M3 backlog rows are partial pending the remaining gates. The exact email scenarios now have local evidence; formal CI status remains separate.

| Ticket | Status | What is missing |
|---|---|---|
| `WORK-08` External tool intent and reconciliation | Locally exercised | The `connectors` job |
| `CONNECT-01` Connector SDK and cursor protocol | Locally exercised | The merged integration tests |
| `CONNECT-02` Webhook authentication and dedupe | Locally exercised | The merged tests and the `connectors` job |
| `CONNECT-06` External action outbox and receipt UI | Locally exercised | The merged tests, browser specs and the `connectors` job |

## What this will not prove, even when it passes

- **That a real relay or provider works.** The sink is a test double for the outside world. No real provider has been used, and the false-`unknown` rate is not measured.
- **Exactly-once.** At most one effect from Ensemus's side, and an honest `unknown` when nobody can say. A relay that loses a message after a 250, or a bounce after it, is outside what this can see.
- **A provider's reconcile.** No connector in M3 has a lookup, so `found`, `not_found` and `refused` are covered only by a test double.
- **Restore safety.** A restore to before a send can send it again if Temporal was restored too. The runbook has a procedure and the code does not enforce it, until `OPS-02`.
- **Load.** The webhook limits are starting values. `OPS-01` should test them.

## What stops M3 closing

1. The results table above shows passes, from a CI run on the merged tree.
2. The owner and the security owner decide on ADR-027, and its open questions are answered.
3. **Outside security review** of D2, D4, D5, the hand-written SMTP client, the triggers, and the shared `ensemus_app` role. No real credential until then.
