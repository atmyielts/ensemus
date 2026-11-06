# M3 evidence report: verified external actions

**Date:** 2026-11-06
**Status: not closed, and not yet shown to work.** This file was written with the end-to-end tests and before they first ran. **Nothing below is a pass unless the results table says so, with a CI run to point at.** Whoever merges the slices and sees CI updates this file, and only from what CI showed.

M3 is what lets Ensemus do something it cannot take back. The exit in the [delivery plan](../06-end-to-end-delivery-plan.md) is Slice 2 passing, and `QA-007`, `QA-008`, `QA-019` and `AI-TS-01` passing, with fault injection at timeout-after-send. The decisions are in [ADR-027](../../00-foundation/adr/ADR-027-verified-external-actions.md), which is **proposed** and awaits the owner and an outside security review.

**No real credential has been stored or used, and no real provider or mail relay has been contacted.** Every test uses generated values, `@example.invalid` addresses and a test sink.

## Results

| Gate | Where it runs | Result |
|---|---|---|
| Format, lint, typecheck, unit and replay after the merge | CI `quality` | **Not yet run on the merged tree** |
| Integration tests, real PostgreSQL roles | CI `integration` | **Not yet run on the merged tree** |
| Stack suite with no profile, zero outbound attempts | CI `stack` | **Not yet run on the merged tree** |
| Slice 2 and the exit scenarios, `tests/stack/slice-2.test.ts` | CI `connectors` | **Not yet run anywhere** |
| Air-gap gate, `--connectors` round | CI `connectors` | **Not yet run anywhere** |
| Replay of the new workflows' histories | CI `quality` | **Not yet run on the merged tree** |

Stack tests, browser tests and the air-gap gate do not run on the development machine. Only CI runs them.

**On the integrator's machine, on the merged tree, and not CI:** format, lint, typecheck, unit, replay, backlog, contracts and licenses passed, and so did every file of the integration suite except the OIDC part of `tests/integration/auth.test.ts`, which could not start its mock because another project on that machine held its fixed port. That part is unchanged by M3. None of this is a pass in the table above.

## What each exit scenario is held by

Each of these is written. None has been run, so none is evidence yet.

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

The backlog and `qa-scenarios.csv` are unchanged, because they move only on evidence.

| Ticket | Status | What is missing |
|---|---|---|
| `WORK-08` External tool intent and reconciliation | Not shown | The `connectors` job |
| `CONNECT-01` Connector SDK and cursor protocol | Not shown | The merged integration tests |
| `CONNECT-02` Webhook authentication and dedupe | Not shown | The merged tests and the `connectors` job |
| `CONNECT-06` External action outbox and receipt UI | Not shown | The merged tests, browser specs and the `connectors` job |

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
