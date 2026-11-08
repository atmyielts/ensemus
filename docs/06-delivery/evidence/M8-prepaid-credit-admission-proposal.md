# Proposed 0513: prepaid model-call authority

Status: proposed source design, not implementation or acceptance. The base is isolated payment join 2316ffc; checked payment branch 5d530fd and the join remain preserved. No SQL/schema/shared runtime has been edited. No tests, types, install, database, provider, build or browser commands ran for this proposal. No provider, price, conversion, commercial term or activation is supplied.

## Context and actual call paths

| Boundary | Main agent inference | Knowledge inference |
| --- | --- | --- |
| Actual dispatch | `packages/intelligence/src/gateway.ts`: `createInferenceGateway`, reserve near line359, fresh dispatch near line480 | `packages/intelligence/src/knowledge-model-gateway.ts`: `call`, prepare near line245, dispatch near line275 |
| Frozen input/output bound | `ceilingFor` counts the provider-neutral SDK envelope; max output is min(compiled limit, profile limit). Current main snapshots retain request/profile/run/step/attempt but not token ceilings. | `ai.model_call_attempts` already freezes max_input_tokens/max_output_tokens, request/input inventory hashes, profile/version and exact job OR run/step principal. |
| Existing money | `UsageLedger.reserve` holds provider-cost micro-USD per budget. It is not M8 prepaid capacity. | `createKnowledgeCallStore.prepare` holds the same USD budget domain and job/run counters. |
| Before native call | Current `admitMainModelDispatchInTx` rechecks exact profile, run, scope, halt and input-snapshot writer. | `KnowledgeCallStore.dispatch` rechecks named member/input authority, actual principal and halt, then claims prepared -> dispatched once. |
| Native output bound | Gateway passes maxOutputTokens to the pinned native adapter; `adapters/index.ts` passes it to doGenerate. Native conformance/real supported-provider enforcement must still qualify that bound. | Generation passes the same cap; embeddings have an actual zero output-token operation. Input is bounded before prepare. |
| Unknown/lost answer | `charge` can emit one estimated input row with no output row; `ai/usage.ts:lostAnswerEntry` deliberately records quantity0 and USD ceiling. | `knowledge-call-store.ts:settleInTx` records two estimated quantity0 rows while charging USD ceiling; it separately consumes frozen token bounds in job/run counters. |
| M8 today | `saas/credits.ts:consumeUsage` asynchronously prices quantities against a billing-period card, using `usage:<ledger-id>`. | Same asynchronous consumer. Optional KnowledgeCloudSpend currently receives only ceilingMicros/costMicros, so it cannot implement exact credit holds. |

`createUsageLedgerReader` already avoids losing late commits by finding missing durable `usage:<id>` keys rather than trusting the timestamp cursor for billable rows. Keep that behavior. The common commercial factory currently refuses Cloud under f2bba01; keep it until BOTH actual dispatch paths have mandatory prepaid admission and qualification.

Approved M8 prices are `billing.rate_cards` + `billing.rate_card_lines(meter,unit,microcredits_per_unit)`. They are distinct from `ai.rate_cards` USD-per-million-token rates. The current supported usage meters are `model_input_tokens`/`model_output_tokens`, unit `token`. Read both exact approved M8 lines; no missing-line default, USD conversion, allowance-to-price inference or synthetic rate. Explicit owner-approved zero rates can be represented as data, but zero must never stand in for missing authority or missing usage.

## Minimal proposed data

One new private retained relation, `billing.model_credit_holds`:

- Tenant/id; exclusive actual principal FK: main input snapshot OR Knowledge model_call_attempt; main USD reservation-group anchor when applicable. Derive run/step/reservation-attempt or job identity from those actual rows, not caller JSON.
- Immutable exact source request hash, profile/version and actual input/output token ceilings. Main requires two additive frozen ceiling fields on `ai.main_input_snapshots`, authored only by its native prepare path. Knowledge reuses its existing immutable attempt ceilings.
- Actual original billing-period/plan/card/version pins, exact token-unit input/output rates read from the approved immutable M8 card, and the BigInt credit ceiling. No caller-supplied price/card choice. Validate all products/sums against the actual database integer range before admission.
- Prepared/dispatched/final/estimated/released state; actual writer identity/claim; ledger input/output IDs and settlement/correction metadata. Financial lineage is retained, not portable authority or an erasure-zero shortcut. Source/live-parent FK retention must be reviewed before erasure registration.

Add a nullable derived `prepaid_hold_id` on `platform.usage_ledger` for new qualified calls only. A fixed exact-table SQL guard derives/checks the hold from the actual reservation/call/principal tuple and rejects caller-swapped pins. It is not a browser-stamped or free-form admission field. No legacy row is backfilled as proven. Existing price/payment/credit tables stay authoritative; no new balance counter is needed.

Use the actual `credit_accounts` row lock plus an indexed sum of prepared/dispatched credit ceilings to compute `available = balance - held`. All hold creation/transitions must take that same lock. Existing balance remains the sum maintained by credit_ledger's actual INSERT trigger. This avoids introducing a second mutable financial total that could disagree after restore. Concurrent top-ups/expiry/consumption serialize on the same account.

## Proposed fixed port and effects

Replace the USD-only KnowledgeCloudSpend contract with a shared mandatory Cloud credit port; do not retain a USD-to-credit compatibility implementation:

```ts
type CreditPrincipal =
  | { kind: 'main'; snapshotId: string; usdReservationId: string }
  | { kind: 'knowledge'; callId: string };

interface CloudModelCreditSpend {
  reserveInTx(tx: Tx, context: TenantContext, principal: CreditPrincipal): Promise<{ holdId: string }>;
  dispatchInTx(tx: Tx, context: TenantContext, principal: CreditPrincipal): Promise<void>;
  settleInTx(tx: Tx, context: TenantContext, principal: CreditPrincipal,
    outcome: NativeCreditOutcome): Promise<void>;
}
```

`NativeCreditOutcome` is a proposed narrow internal bound result, not a public request DTO: actual native response with validated input/output usage, genuine not-sent, or indeterminate. The native worker/adapter must bind it to the exact one-time call/request/writer. Arbitrary booleans, numeric usage or a serialized branded object cannot mint a refund. SQL independently checks actual login/context/principal, immutable source/hold tuple, ledger birth/uniqueness, pinned prices and allowed transitions. SQL metadata checks do not themselves prove a provider/TLS response; that native verifier trust boundary must be explicit and tested before a correction path is enabled.

1. Main: after its real USD reservation returns an actual group ID, reserve credits in the SAME prepare transaction. Persist exact input/output ceilings with the snapshot. A failed credit reservation rolls back USD reservation/snapshot admission too. Recheck and claim the credit hold in the SAME transaction as the existing main dispatch claim, before native provider I/O. Every fallback is a distinct existing reservation-attempt/source snapshot and must reserve its own capacity.
2. Knowledge: reserve from the actual new model_call_attempt and frozen token ceilings in its existing prepare transaction; recheck/claim inside its existing dispatch transaction. A job/run payload cannot select a different card, principal or hold. Qualification/synthetic workloads follow the actual billable/commercial rules; no generic probe/service exemption is added.
3. Both paths must refuse Cloud dispatch when the actual credit port is absent, billing is disabled, approved current plan/card/meter authority is missing, current eligibility/standing fails, or available capacity does not cover the full credit ceiling. BYOM remains customer billed, and Sovereign preserves its signed offline entitlement path with zero hosted dependency.
4. Do not remove f2bba01 merely by adding a readiness boolean/config flag or returning a positive feature check. The eventual trusted composition must install both mandatory provider-bound gates before relaxing the common early Cloud refusal. Other constructors/defaults retain refusal.

## Settlement, unknowns and the shared key

Final response: in the same transaction that records actual M4 input/output usage, write the M8 consumption entries with EXACT `creditKeys.consumption(usageId)` (`usage:<id>`). Price actual quantities using the hold's original approved M8 lines. Settle/release that call's held ceiling in the same transaction. Actual measured overuse is accounted in full and further admission/content is refused; it cannot silently expand an admitted output cap. Overflow/incomplete accounting remains an unresolved debt, not a settled zero.

Unknown or lost response: debit the full PINNED INPUT PLUS OUTPUT credit ceiling as estimated debt; never price the current quantity0 placeholders as free. Preserve the honest unknown token quantities. Main needs a matching estimated output usage row for new credit-bound calls (quantity0, no extra USD cost), so both credit meters have real stable `usage:<id>` anchors. Knowledge already has both rows. The hold's estimated debt is the source of the amount, not invented measured tokens. Close active reserved capacity only atomically with those conservative debits; a crash before that transaction commits leaves the full hold in place. No timeout, lease, billing-off switch or cancellation proves not-sent.

The asynchronous consumer must recognize qualified prepaid usage and use that exact same settlement derivation/key/card. Already-written entries replay without another debit. It must not reprice prepaid rows using a newer/current period. An unconsumed prepaid row restored independently is reconciled from the immutable original hold; it is not silently skipped as handled. Legacy unbound billable estimates/quantity0 rows remain explicit unresolved inventory and block positive new Cloud admission until genuinely reconciled; do not manufacture a ceiling from USD or current prices.

Genuine not-sent: release only the exact own prepared/dispatch attempt when the native protocol positively establishes no request was sent/accepted; preflight rejection before dispatch is a distinct safe path. Other dispatched/unknown outcomes retain the hold/debt. Model adapter's existing `wire.requested` and `mayHaveBilled` handling must be tested at the actual send boundary, including abort-after-admission, worker loss and a late result. A caller-provided `mayHaveBilled:false` is not a SQL credential.

Genuine later correction: append an actual per-meter usage correction linked to the original usage/hold and a bound native measured-usage receipt. Its credit entry uses `usage:<correction-id>` and original card/period/rates, with delta from the original estimate. Retries do not refund twice. Missing authentic correction source leaves the estimate intact. There is no new human/model authority to assert an external usage refund; exact native receipt design/role qualification is still required.

## Locks, restore and acceptance gates

Existing source/principal/body-authority locks come first. Take organization/credit-account locks NOWAIT when entered from such a caller, then the exact hold; contention refuses/retries the whole short transaction before network, never reverses into blocking source locks. The asynchronous accounting path may lock organization/account first, but must not then wait for a run/job/source body authority lock. It uses only retained fixed financial metadata/immutable ledger rows. No SQL transaction spans provider I/O. Late accounting must remain possible after initiator revocation or billing-off without authorizing a new call/refund.

Restore reconciliation is an explicit OPEN gate: separately restored balance, credit ledger, holds, USD/usage rows, snapshots/calls and authority receipts must not manufacture spendable capacity or reusable dispatch. Existing model/connector restore gates stay closed until actual retained ledgers/claims are reconciled. Missing earlier native/financial debt cannot be reconstructed from zero quantities, current card, a HEAD-like absence inference or elapsed time. No positive restore/erasure claim is part of this proposal.

Required source/real-role scenarios: simultaneous main+Knowledge calls sharing a small balance; mixed job/run/fallback principals; foreign/swapped/replayed holds; actual native output cap and full request-input bound; reserved-card change/period boundary; disabled/unpriced/no-subscription before key/transport; late ledger commit plus direct/async settlement race; failure before send vs lost/late answer; full input/output estimated debt; authentic correction replay; revoked initiator late accounting; rollback at each write; restore-ledger mismatch refusing admission; unchanged BYOM/Sovereign behavior. Generated fixtures only. Prices stay unset until operator-owned data is explicitly approved.

## Options and next action

- Keep only asynchronous consumption: rejected for admission, because concurrent calls can spend one balance and unknown quantity0 rows can appear free.
- Treat USD budget holds as credits: rejected because the card/unit domain and commercial authority differ.
- Add fixed credit holds with shared ledger settlement (proposed): one additional financial control relation and narrow call bindings; added lock/restore/correction obligations are explicit.

Next action is parent review of these exact source/schema/port boundaries and native correction trust, followed by bounded implementation only after approval. 0513 is not authored, registered, applied or activated by this note.
