# M8 slices

Ten builders work in parallel from the foundation commit, and one closes after they merge. **No file has two owners.** Everything they must agree on is already decided in [ADR-032](../00-foundation/adr/ADR-032-saas-operations-and-billing.md) and already typed in the code. Read that ADR first, because it holds the reasons.

If you need a change to a file you do not own, or to anything in "Fixed" below, stop and report it. Do not work around it, and do not edit the file.

## Fixed: nobody changes these

| What | Where |
|---|---|
| Migrations, RLS, roles and triggers. **No builder adds a migration** | `packages/database/migrations/0500_*`, `0501_*`, `packages/database/src/schema-saas.ts`, `infrastructure/compose/postgres/provision.sql`, `upgrade-roles-m8.sql` |
| Journal. The final merge stitches it in | `packages/database/migrations/meta/` |
| Tenant binding and read-only enforcement | `packages/database/src/tenant.ts`, `account.ts`, `payment-routing.ts`, `operator.ts`, `support.ts` |
| Standing checks, and the refusal mapping | `assertServing` in `packages/application/src/saas/standing.ts`, `refusalFromDatabase` in `errors.ts`, `apps/web/src/server/tenant.ts`, `api.ts`, `work-actions.ts`, `apps/web/src/app/o/[organizationId]/layout.tsx` |
| State tables, codes and event names | Every `*_STATUSES`, `*_TRANSITIONS`, `*_CODES`, `*_STATES`, `*_KINDS` and type in `packages/saas/src/**`, and `events.ts` and `money.ts` whole. A slice fills in the stub functions in its own file and changes no type |
| Ports | `packages/application/src/saas/ports.ts` |
| Temporal shapes and wiring | `packages/workflows/src/saas-schemas.ts`, `saas-deps.ts`, `workflows.ts`, `workers/workflow/src/main.ts`, `connector-worker.ts`, `dispatcher.ts`, `ops.ts`, `scripts/build.mjs` |
| Contracts | `packages/contracts/src/saas.ts` |
| Errors, words, capabilities, logs, settings | `packages/application/src/errors.ts`, `apps/web/src/lib/messages.ts`, `packages/domain/src/policy.ts`, `packages/telemetry/src/index.ts`, `packages/config/src/index.ts` |
| Import rules | `eslint.config.mjs` |
| Dependencies. **`pnpm-lock.yaml` is frozen, and no builder adds a package.** Every workspace link is in place | every `package.json`, `apps/web/next.config.ts` |
| Shared test helpers | `tests/helpers/saas.ts`, `tests/integration/saas-schema.test.ts`, `tests/unit/saas-foundation.test.ts` |
| The spec, until the close slice | `docs/specifications/openapi.yaml`, `packages/contracts/generated/**`, `tests/unit/openapi-contract.test.ts` |
| Decisions | ADR-032, this file |

A bug in any of these is reported, not fixed in passing.

## What runs where

| Rule | Detail |
|---|---|
| **Code only** | The owner's PC is low on disk, and the owner decides later when to dockerize. **Never run docker or compose in any form**, and never `test:integration`, `test:stack`, `test:browser`, `test:upgrade`, or anything needing a container. Do not edit a Dockerfile or a compose file: report what is needed |
| What you may run | `pnpm exec prettier`, `pnpm exec eslint <your paths>`, `pnpm --filter <pkg> typecheck`, `pnpm --filter @ensemus/web exec next typegen`, `pnpm exec vitest run --project unit <your paths>`, `pnpm test:replay`. Through the slot wrapper you were given, with a 600000 ms timeout. Exit 75 means no slot yet, so run it again. Never a dev server or a watch mode |
| Tests that need a stack | Still write integration, stack and browser tests, and typecheck them. They are **unverified**. Say so, and never report them as passing |
| Replay histories | Capturing needs Temporal, which you may not run. Write `tests/replay/capture-<yours>.test.ts` following `tests/replay/capture.test.ts`, and a `tests/replay/<yours>-corpus.test.ts` that lists the histories it expects and skips while they are absent. **Report them as owed** |
| Disk | Under 3 GB free on C:, stop and report |
| Time | The owner stops at 22:00 local. Run `date`. Past 21:15, commit what typechecks, and list the rest as not done |

## How stubs work

A stub throws `NOT_IMPLEMENTED`, and each slice can be tested without the others, as follows.

- `tests/helpers/saas.ts` seeds approved cards, plans, policies, tax treatments, accounts and subscriptions through the real triggers, and `asRole` runs as a role that cannot log in. Amounts are random, and the currency is `XTS`, the ISO code reserved for testing.
- Where your code calls another slice's stub at runtime, your own tests inject a double, or seed the rows that slice would write. The close slice proves the real parts together.
- Where your page links to another slice's page, write the link. It resolves when both are merged.
- Ports come from `packages/application/src/saas/ports.ts`, and tests bring their own. **A double lives with the tests and never ships as a default.** `@ensemus/saas/testing` is lint-blocked from `apps/` and `workers/`.

**Mid-wave, one existing test fails on purpose.** `tests/unit/openapi-contract.test.ts` refuses a route for an operation still marked `x-ensemus-status: planned`, and only the close slice flips those. Do not run that file, and do not edit it or the spec. Your own route tests assert behaviour, and the validator runs after the flip.

## Every slice

- **Denied and cross-tenant tests first, then the code.** Two tenants, same names, real roles.
- **Tenant access goes through `withTenantTx`, or `withAccountTx` for billing, support, export and leaving.** Check `can(context.role, ...)` or `context.actorType === 'service'` at the top of each service, as the stub's comment says.
- **Account routes pass `'account'` as `apiRoute`'s third argument, and account pages use `requireAccountTenant`**, so they work in any standing.
- Only IDs, enums and counters cross Temporal. New workflows only import `@temporalio/workflow` and types. A workflow's decisions live in a small pure module, so a unit test can reach them.
- All workflows run on `PLATFORM_TASK_QUEUE`. Anything holding a credential or leaving the process is an Activity proxied to `CONNECTOR_TASK_QUEUE`, which only the connector worker polls.
- **No invented values:** no price, percentage, period, SLA, RTO, RPO, hours, certification or legal term in code, docs or test names. Such a thing is configuration, data, or an owner decision. Generated test values only: `@example.invalid` addresses, random secrets, no real provider.
- Log codes, never text from a provider or a person, and never an amount, a name or an address. Stored reasons are codes.
- Pages follow what exists (`components/ui.tsx`, `globals.css`): empty, error and denied states, forms that work without JavaScript, and a denied person gets the usual not found.
- `AppError` messages are written. Add nothing to `errors.ts`.
- Follow the house comment style: say why, in plain sentences.

---

# Wave 1: all start at once

## catalog: `BILL-04` (rate cards)

Pure pricing, the operator's commands for the price list, and setting a provider's bill against the ledger. Acceptance: prices live in versioned tables, and usage reconciles to provider bills.

**Owns:**

- `packages/saas/src/catalog.ts` (the stubs), new `catalog.test.ts`, new `packages/saas/src/money.test.ts`
- `packages/application/src/saas/catalog.ts`, `operator-catalog.ts`
- `workers/workflow/src/ops-catalog.ts`, new `ops-catalog.test.ts`
- new `tests/integration/saas-catalog.test.ts`

**Implements** (signatures in the stubs):

```ts
// @ensemus/saas/catalog
priceUsage(card: RateCardFacts | null, usage, at: Date): Priced
canStartOn(plan: PlanTerms, mode: string): boolean
periodEnd(start: Date, interval: 'month' | 'year'): Date

// @ensemus/application/saas/catalog
listAvailablePlans(database, context): Promise<readonly (PlanTerms & { planCode; displayName })[]>
loadPlanTerms(tx, planVersionId): Promise<PlanTerms | null>
requirePublishedRateCard(tx, rateCardId): Promise<RateCardFacts>   // throws RATE_CARD_NOT_APPROVED
listTopUpOffers(database, context): Promise<readonly TopUpQuote[]>

// @ensemus/application/saas/operator-catalog, all on `OperatorDb`
draftRateCard, approveRateCard, draftPlanVersion, approvePlanVersion,
publishCollectionPolicy, publishTaxTreatment, enterProviderBill, reconcileProviderBill

// workers/workflow/src/ops-catalog.ts
catalogCommand(args: string[]): Promise<number>   // 0 done, 1 left to do, 2 refused
```

**Things to get right:**

- `priceUsage` refuses with a code for each row of its type: no card, a draft, not yet effective at `at`, a meter with no line, a unit that differs. Unit-test each one. Never a default.
- `periodEnd` by calendar in UTC: a period starting on the 31st ends on the last day of a short month, and the next starts from where this one ended, with nothing skipped or doubled. Property-test a run of periods.
- Every operator function writes `billing.operator_actions`. Validate `publishCollectionPolicy` steps with `collectionStepsSchema`.
- `reconcileProviderBill` reports the difference, and a person decides. **There is no tolerance in code.** Takes `ProviderCostPort`.
- `catalogCommand` opens `openOperatorDatabase(readSecret('DATABASE_URL_OPERATOR'))`, follows `reapply-command.ts` for parsing and exit codes, and every number comes from an argument or a file an operator names.

**Denied and fault tests:** application role cannot write any catalog table. A tenant cannot see a draft. An approved card's line cannot change or be removed, and a card cannot go back to draft (`EN801`). A card cannot be approved with no lines. A plan cannot be approved against a draft card or another currency. Two operators approving at once: one wins. `ops-catalog` with no secret or a bad number exits 2 and touches nothing.

## subscriptions: `COMM-01`, `OPS-21`

Subscriptions, entitlements, standing, provisioning and the account's front page. Acceptance: included capacity checked, top-ups explicit. Downgrades never destroy data, and suspension follows published terms.

**Owns:**

- `packages/saas/src/entitlements.ts` (the stubs), new `entitlements.test.ts`
- `packages/application/src/saas/subscriptions.ts`, `entitlements.ts`, `standing.ts` (not `assertServing`)
- `workers/workflow/src/ops-tenant.ts`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/entitlements/route.ts`, `billing/route.ts`, `billing/account/route.ts`, `billing/plans/route.ts`, `billing/subscription/route.ts`
- new `apps/web/src/app/o/[organizationId]/account/page.tsx`, `account/billing/**`, new `apps/web/src/server/billing-actions.ts`, new `apps/web/src/components/billing-*.tsx`
- new `tests/integration/saas-subscriptions.test.ts`, `saas-standing.test.ts`, `saas-entitlements.test.ts`, `tests/stack/saas-billing-api.test.ts`, `tests/browser/specs/account.spec.ts`

**Implements:**

```ts
// @ensemus/saas/entitlements
evaluateEntitlement(facts: EntitlementFacts, request: EntitlementRequest): EntitlementDecision
planChangeEffect(from: PlanTerms, to: PlanTerms, counts: TenantCounts): PlanChangeEffect

// @ensemus/application/saas/subscriptions
getBillingOverview(database, context, { billingEnabled }): Promise<BillingOverview>
saveBillingAccount(database, context, input): Promise<{ version }>
startSubscription(database, context, { planVersionId, startsAt? }): Promise<{ subscriptionId }>
changePlan(database, context, { toPlanVersionId, expectedVersion }): Promise<{ effective; excess }>
requestCancellation(database, context, { expectedVersion }): Promise<void>
withdrawCancellation(database, context, { expectedVersion }): Promise<void>
advanceSubscriptionInTx(tx, context, { subscriptionId, now }): Promise<'advanced' | 'canceled' | 'not_due'>

// @ensemus/application/saas/entitlements
checkEntitlementInTx(tx, context, request, { billingEnabled }): Promise<EntitlementDecision>
getEntitlements(database, context, { billingEnabled }): Promise<EntitlementsView>
createEntitlementChecker(database, billingEnabled)   // what M4's Entitlements.check calls

// @ensemus/application/saas/standing
setTenantStandingInTx(tx, context, { to, reasonCode, actor }, agents): Promise<'changed' | 'unchanged'>
provisionTenant(database, input): Promise<{ organizationId; invitationToken }>

// workers/workflow/src/ops-tenant.ts
tenantCommand(args: string[]): Promise<number>
```

**Calls** (stubs until merged, so seed or inject in your tests): `allocatePeriodCreditsInTx`, `loadCreditBalanceInTx` from credits, `loadPlanTerms`, `canStartOn`, `periodEnd` from catalog.

**Things to get right:**

- `evaluateEntitlement`'s order, per `docs/07-commercial/02` section 6: deployment, standing, subscription, feature, capacity. Sovereign answers `ALLOWED`, and nothing here asks for payment or a heartbeat. BYOM `model_capacity` is `CUSTOMER_BILLED` and allowed, and never spends. Exhaustive table test.
- `setTenantStandingInTx`: `billing.standing_changes` then `org.organizations.lifecycle`, in that order, or the trigger refuses. `occurred_at` is left to its default, since the trigger matches `now()`. It uses `TENANT_LIFECYCLE_TRANSITIONS`, emits `TENANT_STANDING_CHANGED`, notifies owners, and goes through `AgentHaltPort`.
- `provisionTenant` needs a person's account to exist first, and answers an invitation the operator passes on by a private route, as `setup-token` does. **Never prints it to a log.**
- The account page tells a suspended or read-only tenant plainly what state it is in, why, and what still works, and links to billing, support, export and leaving.

**QA:** `QA-026` entitlement half, `QA-027` entitlement half.

**Denied and fault tests:** a member cannot read or change billing, as not found. A tenant cannot start a plan for another mode, a draft, or a retired one. Sovereign refuses a subscription. A second live subscription refused. A downgrade with excess removes nothing, and every row count is the same after. A stale version conflicts. Another tenant's subscription is not found. A web caller cannot set standing: there is no route. A suspended tenant's write through an ordinary service fails with `TENANT_READ_ONLY`, through `withTenantTx`, and its read of billing works. A deleted tenant looks as if it never existed. `isAuditedRefusal` still logs a refusal from a read-only tenant, or the failure is swallowed safely.

## credits: `BILL-04` (credits), `BILL-05`

The allowance, consumption from M4's ledger, and explicit top-ups. Acceptance: runs pause or request a top-up at the limit, with no surprise charges.

**Owns:**

- `packages/saas/src/credits.ts` (the stub), new `credits.test.ts`
- `packages/application/src/saas/credits.ts`, `top-ups.ts`
- `packages/workflows/src/credit-activities.ts`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/billing/credits/route.ts`, `billing/top-ups/route.ts`
- new `apps/web/src/app/o/[organizationId]/account/credits/**`, new `apps/web/src/server/credit-actions.ts`
- new `tests/integration/saas-credits.test.ts`, `tests/stack/saas-credits-api.test.ts`, `tests/browser/specs/credits.spec.ts`

**Implements:**

```ts
// @ensemus/saas/credits
exhaustionDecision(balance, estimated, overagePolicy, warnBelow): ExhaustionDecision

// @ensemus/application/saas/credits
getCreditSummary(database, context): Promise<CreditSummary>
allocatePeriodCreditsInTx(tx, context, { billingPeriodId, includedMicrocredits, rateCardId }): Promise<void>
consumeUsage(database, context, usage: UsageLedgerPort, { limit }): Promise<{ entries; microcredits; exhausted; more }>
loadCreditBalanceInTx(tx, context): Promise<bigint>

// @ensemus/application/saas/top-ups
requestTopUp(database, context, { offerId, quoteHash, requestKey }): Promise<{ topUpId; invoiceId }>
creditPaidTopUpInTx(tx, context, { invoiceId }): Promise<'credited' | 'not_a_top_up' | 'already_credited'>
listTopUps(database, context): Promise<readonly {...}[]>

// @ensemus/workflows/credit-activities
createCreditActivities(deps: BillingActivityDeps) -> { consumeUsagePage }
```

**Calls:** `createTopUpInvoiceInTx` and `buildTopUpInvoice` from invoicing, `requirePublishedRateCard`, `priceUsage` from catalog, `creditKeys`, `quoteHash` as written.

**Things to get right:**

- Every ledger row uses `creditKeys`, so running twice writes one row. Insert `onConflictDoNothing`, and the balance moves only by the trigger: **never update `credit_accounts` yourself.**
- `consumeUsage` skips any entry with `billable: false`, so BYOM is never charged, and counts `estimated` entries, since a lost answer may have been billed. `UsageUnavailable` propagates: no port means nothing happens, and is not zero usage. The port's cursor is held in `credit_accounts.usage_cursor`, in the same transaction as the page it covers. Losing it only repeats work the keys make safe.
- `CREDITS_LOW` and `CREDITS_EXHAUSTED` fire once, on crossing. `warnBelow` is data from the plan or absent, with no percentage in code.
- `requestTopUp` is a person's: a service context is refused. It recomputes the quote under lock and compares. Refuses BYOM, a `pause` plan, and anything not `active`. No retry and no automatic path exist.
- **`QA-026`:** at zero, the next call is refused with `CREDITS_EXHAUSTED` and `remedy: 'top_up'` or `'upgrade'`, no invoice appears, and nothing is charged.

**QA:** owns `QA-026`.

**Denied and fault tests:** same key twice, one row and one balance change. A changed price answers `QUOTE_CHANGED` and buys nothing. Top-up credited before paid is refused (`EN802`). Paying credits it once, even if called twice. Ledger `UPDATE` and `DELETE` refused for every role. Balance always equals the ledger's sum, by a property test at unit level, and by query at integration. Another tenant's offer or top-up is not found. A member cannot top up. A negative balance charges nothing and stops the next call. A tenant on `pause` is never offered one.

## invoicing: `BILL-02`, `BILL-03`

The billing cycle, invoices and tax. Acceptance: invoices match the usage ledger and subscription terms. Tax treatment follows adviser guidance.

**Owns:**

- `packages/saas/src/invoice.ts`, `tax.ts` (the stubs), new `invoice.test.ts`, `tax.test.ts`, `packages/saas/src/testing/fake-tax.ts`
- `packages/application/src/saas/invoices.ts`
- `packages/workflows/src/billing-cycle-workflow.ts`, `billing-activities.ts`, `tax-activities.ts`, new `billing-cycle-step.ts`, `billing-cycle-step.test.ts`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/billing/invoices/route.ts`, `billing/invoices/[invoiceId]/route.ts`
- new `apps/web/src/app/o/[organizationId]/account/invoices/**` except `[invoiceId]/pay`
- new `tests/integration/saas-invoices.test.ts`, `tests/stack/saas-invoices-api.test.ts`, `tests/browser/specs/invoices.spec.ts`, `tests/replay/capture-billing-cycle.test.ts`, `tests/replay/billing-cycle-corpus.test.ts`

**Implements:**

```ts
// @ensemus/saas/invoice
buildPeriodInvoice(plan, overage, minorUnitExponent): DraftInvoice
buildTopUpInvoice({ priceMicros, currency }, minorUnitExponent): DraftInvoice
withTax(draft, { taxMicros, currency }): DraftInvoice
invoiceAddsUp(draft): boolean

// @ensemus/saas/tax
treatmentFor(approved, place): T | null

// @ensemus/saas/testing
createFakeTaxPort(script): TaxPort & { calls }

// @ensemus/application/saas/invoices
listInvoices, getInvoice, draftDuePeriodInvoices, listDraftsNeedingTax, loadTaxQuestion,
issueInvoice, createTopUpInvoiceInTx, voidInvoice

// @ensemus/workflows/billing-activities and tax-activities
createBillingActivities(deps) -> { runBillingSweep, issueDraftInvoice, runCollectionsStep }
createTaxActivities(deps) -> { computeTaxAndIssue }
// packages/workflows/src/billing-cycle-workflow.ts
billingCycleWorkflow(input: BillingCycleInput): Promise<BillingCycleResult>
```

**Calls:** `advanceSubscriptionInTx` from subscriptions, `requirePublishedRateCard`, `priceUsage`, `periodEnd` from catalog, `runCollections` from payments, `consumeUsagePage` from credits, `UsageLedgerPort.sumForPeriod`.

**The workflow, in order:** consume usage until no more, `runBillingSweep`, then each draft: `issueDraftInvoice`, or on `needs_tax_port` proxy `computeTaxAndIssue` to `CONNECTOR_TASK_QUEUE`, then `runCollectionsStep`. Its result is counts and one code. `tenantRemindersWorkflow` is the pattern for being run by a schedule.

**Things to get right:**

- Overage is what usage comes to in credits beyond the period's allowance, priced from the **period's own card**, not whatever is current. A plan change mid-period keeps each period's terms.
- `draftDuePeriodInvoices` refuses and stops, with `refusedCode`, audited once: no approved card, no treatment, or `UsageUnavailable`. **A period it cannot bill stays open and is tried again. It never writes a partial invoice, and never treats a missing ledger as no usage.**
- BYOM: `buildPeriodInvoice` throws on any usage, and an integration test proves a BYOM invoice is the platform fee only (`QA-027`).
- `issueInvoice`: the next `invoice_number` under a per-tenant lock, no gaps from a rollback. `bill_to` is a snapshot from the account now. The due date is `issued_at` plus the plan's `paymentTermsDays`, and a top-up falls due at once. Tax is zero and asks nobody only for an approved `not_collected`. `provider_computed` with no port stays a draft.
- Invoice detail shows every line, the period, and which card and plan version priced it. Words only, no currency symbol assumed: use `formatMoney`.
- The page links to `account/invoices/[invoiceId]/pay`, which payments owns.

**QA:** invoice half of `QA-027`.

**Denied and fault tests:** invoice totals equal the ledger's sum times the card, with a test per meter. A draft card, a missing treatment, and lines that do not add up each refuse at `open` (`EN802`), tested as a tampered row too. Money on an open invoice cannot change. A second invoice for a period is refused. The sweep running twice writes one invoice. A tax port failure leaves a draft and charges nothing. An invoice is not found from another tenant. A member sees none. A voided invoice is kept. `listDraftsNeedingTax` names no amount. No amount or address crosses Temporal: a schema test.

## payments: `BILL-01`

The payment intent, its attempts, the workflow, processor webhooks, and collections. **No processor is chosen: an adapter contract and a test double only.** Acceptance: subscriptions charge correctly, and failed payments follow published rules without data loss.

**Owns:**

- `packages/saas/src/payment.ts` (the stubs), new `payment.test.ts`, `packages/saas/src/testing/fake-processor.ts`
- `packages/connectors/src/payment/**`
- `packages/application/src/saas/payments.ts`, `payment-events.ts`, `collections.ts`
- `packages/workflows/src/payment-workflow.ts`, `payment-activities.ts`, new `payment-step.ts`, `payment-step.test.ts`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/billing/invoices/[invoiceId]/payments/route.ts`
- new `apps/web/src/app/o/[organizationId]/account/invoices/[invoiceId]/pay/**`, new `apps/web/src/server/payment-actions.ts`
- new `tests/integration/saas-payments.test.ts`, `saas-payment-events.test.ts`, `saas-collections.test.ts`, `tests/stack/saas-payments-api.test.ts`, `tests/replay/capture-payment.test.ts`, `tests/replay/payment-corpus.test.ts`

**Implements:**

```ts
// @ensemus/saas/payment
checkBeforeCharge(facts: PaymentCheckFacts): PaymentCheck
decideAfterCharge(result: ChargeResult, attemptNo: number): PaymentAttemptDecision
decideAfterLookup(result: PaymentLookupResult, lookup): PaymentLookupDecision
nextCollectionStep(steps, dueAt, stepNo, now): CollectionDecision

// @ensemus/saas/testing
createFakePaymentProcessor(script): PaymentProcessor & { charges }

// @ensemus/connectors/payment
createPaymentConnector(processor: PaymentProcessor): Connector<unknown>

// @ensemus/application/saas/payments
requestInvoicePayment, beginPaymentAttempt, finishPaymentAttempt, inspectInterruptedPayment,
beginPaymentReconcile, finishPaymentReconcile, failUnsentPayment, resolveUnknownPayment,
afterInvoicePaidInTx

// @ensemus/application/saas/payment-events
recordPaymentEventInTx, routePaymentEvent, applyPaymentFactInTx, listUnmatchedPaymentEvents

// @ensemus/application/saas/collections
runCollections(database, context, { agents }, now): Promise<CollectionOutcome>

// @ensemus/workflows/payment-activities
createPaymentPlatformActivities(deps) -> { inspectInterruptedPaymentStep, failUnsentPaymentStep, routePaymentEventStep }
createPaymentConnectorActivities(deps) -> { chargePaymentStep, reconcilePaymentStep }
// packages/workflows/src/payment-workflow.ts
paymentWorkflow(input: PaymentInput): Promise<PaymentResult>
paymentEventWorkflow(input: PaymentEventInput): Promise<PaymentEventOutcome>
```

**Calls:** `creditPaidTopUpInTx` from credits, `setTenantStandingInTx` from subscriptions, `withPaymentCustomerTx` from `@ensemus/database/payment-routing`. M3's `applyVerifiedDelivery` and `createWebhookEffectHandlers` are stubs here, and the real ones are on `m3-verified-actions`, so test `recordPaymentEventInTx` and `routePaymentEvent` directly.

**Things to get right:**

- **Read ADR-027 D2 first. This is that, for money.** The shape of `external-action-workflow` and `external-action-activities` on `m3-verified-actions` (`git show`, do not merge) is the pattern, and `externalActionWorkflow`'s options apply: `chargePaymentStep` has `maximumAttempts: 1`, `scheduleToStartTimeout` set, and a failure goes to `inspectInterruptedPaymentStep`, never to another charge unless that says `nothing_sent`. It ends on `unknown` and takes no further step.
- `chargePaymentStep`, on the connector queue: `beginPaymentAttempt`, then `deps.processors.get(processor)`. Null is `PROCESSOR_NOT_CONFIGURED`, and it fails cleanly with no contact, which is what happens on every deployment today. It leases the credential from `billingOrganizationId`'s connection, `charge` once, and `finishPaymentAttempt`.
- `runCharge`: only an explicit `not_sent` allows a retry. Anything thrown, and the deadline, is `indeterminate`. The same as `runSend` in M3, and unit-test each.
- `paymentEventWorkflow` is two transactions, safe to repeat: `applyPaymentFactInTx` in the tenant, then mark the row in the operator's organization. Crash between them, and the unique key makes the second run `already_done`.
- `applyPaymentFactInTx` settles only on an exact match: reference or our ID, amount and currency. A refund or dispute is recorded, flagged and changes nothing else.
- `resolveUnknownPayment` can only say `confirmed_not_charged`. The database refuses `succeeded` without evidence, and that is the point.
- `runCollections`: `step_no` moves under the case's lock, so each step runs once. **No approved policy: counted in `noPolicy`, and nothing happens.** It never deletes. A paid invoice resolves its case and restores standing.
- `createPaymentConnector`: `interpret` returns `{ kind: 'payment_event', event }`, or nothing for an event type `interpretWebhook` answers null for. `MalformedWebhook` for what it cannot read. Passes `describeConnectorConformance`.
- **Report to the close slice:** M3's `applyVerifiedDelivery` must gain the `payment_event` branch (ADR-032 D4).

**QA and faults:** the `BILL-01` half of Gate E. Fault injection at timeout-after-charge.

**Denied and fault tests:** the charge happens and then the call times out: one charge counted by the double, ends `unknown`, and repeated Activity calls add none. Worker "dies" after `beginPaymentAttempt`: a retried charge refuses, `attempt_open`, one charge. `not_sent`, retry, then `succeeded`: one charge, two attempts. Five `not_sent`: `failed`, `ATTEMPTS_EXHAUSTED`. Webhook arrives before the answer, or twice, or for the wrong amount, or another tenant's reference. A forged event with no account stays `unmatched`. A charge on a non-open invoice is refused. Two payment requests make one payment. `succeeded` with no evidence refused (`EN803`). Another tenant's invoice is not found, and a member cannot pay. Processor text in an error reaches no row, log or Temporal payload: canary test. No processor configured: refused, no contact, nothing lost.

## retention: `LIFE-02`, `LIFE-03`

Retention rules, the sweep, and legal holds. Acceptance: retention applies per data class, and numeric defaults come from legal sign-off, not code. Held records survive deletion requests, and the hold is audited.

**Owns:**

- `packages/saas/src/lifecycle.ts` (the stub), new `lifecycle.test.ts`
- `packages/application/src/saas/retention.ts`, `legal-holds.ts`
- `packages/workflows/src/retention-workflow.ts`, `retention-activities.ts`
- `workers/workflow/src/saas-ports.ts`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/retention-rules/route.ts`, `legal-holds/route.ts`, `legal-holds/[legalHoldId]/release/route.ts`
- new `apps/web/src/app/o/[organizationId]/account/retention/**`, `account/legal-holds/**`, new `apps/web/src/server/lifecycle-actions.ts`
- new `tests/integration/saas-retention.test.ts`, `saas-legal-holds.test.ts`, `tests/stack/saas-lifecycle-api.test.ts`, `tests/browser/specs/lifecycle.spec.ts`, `tests/replay/capture-retention.test.ts`, `tests/replay/retention-corpus.test.ts`

**Implements:**

```ts
// @ensemus/saas/lifecycle
retentionCutoff(rules, category, classification, now): Date | null

// @ensemus/application/saas/retention
listRetentionRules, setRetentionRule, sweepRetention, createRawFilesRetentionSource

// @ensemus/application/saas/legal-holds
listLegalHolds, placeLegalHold, releaseLegalHold, isHeldInTx

// @ensemus/workflows/retention-activities
createRetentionActivities(deps) -> { sweepRetentionPage }
// packages/workflows/src/retention-workflow.ts
retentionSweepWorkflow(input: RetentionInput): Promise<RetentionResult>
```

**Calls:** `deleteArtifact` from `packages/application/src/artifacts.ts`, `auditAction`, `emit`. `OFFBOARDING_RESUMED` when a release unblocks an offboarding.

**Things to get right:**

- **No default number, anywhere.** `basisRef` is required. A category with no rule, or a null, is kept. `retentionCutoff` property test: no rule never yields a date.
- `sweepRetention` catches `refusalFromDatabase(...)` of `LEGAL_HOLD_ACTIVE` per record in a savepoint, counts it `held`, and goes on. **Any other failure stops that category and is reported.** It never treats a failure as removed.
- `CATEGORIES_NOT_SWEPT` refuses a number. Other categories with no `RetentionSource` wired are skipped and reported, never pretended.
- `createRawFilesRetentionSource` goes through the existing deletion path, so tombstones and the ledger happen. `saas-ports.ts` adds it, and you own that file's other refusals, leaving them refusing.
- A hold's existence is sensitive: non-owners get not found. Audit holds IDs and codes, never `matter_ref`.
- Every scope is checked to be in this tenant, like `foreignReference`.

**QA:** `QA-025` hold half, Journey F hold half. Threat: deletion paths.

**Denied and fault tests:** deleting a held artifact through the normal service, a direct `DELETE`, a client and a project under a hold, and an artifact whose work unit, project or client is held: each refused, and the row and bytes are there after. Release, then the same deletion works. A deletion before the hold, re-applied after a restore, still applies. A retention sweep with a held record leaves it and removes the rest. Member and admin cannot place or release. Admin can set retention and owner can too. Another tenant's scope refused as a typing mistake. A released hold stays released. A rule with no basis refused. A sweep twice removes nothing more. Tenant B's rule touches nothing of tenant A's. The sweep with no rule does nothing at all.

## offboarding: `LIFE-04`

Tenant offboarding, with verified deletion. Acceptance: export offered, connections revoked, scheduled work ended, deletion verified and reported.

**Owns:**

- `packages/saas/src/offboarding.ts` (the stub), new `offboarding.test.ts`
- `packages/application/src/saas/offboarding.ts`
- `packages/database/src/eraser.ts`
- `packages/workflows/src/offboarding-workflow.ts`, `offboarding-activities.ts`, new `offboarding-step.ts`, `offboarding-step.test.ts`
- `workers/workflow/src/ops-erase.ts`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/offboarding/route.ts`, `offboarding/cancellation/route.ts`
- new `apps/web/src/app/o/[organizationId]/account/leave/**`, new `apps/web/src/server/offboarding-actions.ts`
- new `tests/integration/saas-offboarding.test.ts`, `saas-erasure.test.ts`, `tests/stack/saas-offboarding.test.ts`, `tests/browser/specs/offboarding.spec.ts`, `tests/replay/capture-offboarding.test.ts`, `tests/replay/offboarding-corpus.test.ts`

**Implements:**

```ts
// @ensemus/saas/offboarding
nextOffboardingStep(facts: OffboardingFacts, now: Date): OffboardingStep

// @ensemus/application/saas/offboarding
getOffboarding, requestOffboarding, cancelOffboarding, setTransitionEnd, advanceOffboarding,
beginErasure, finishErasure

// @ensemus/database/eraser
listErasableTables(db): Promise<readonly string[]>
eraseTenantRows(db, organizationId): Promise<readonly ErasedTable[]>

// @ensemus/workflows/offboarding-activities
createOffboardingActivities(deps) -> { advanceOffboardingStep }
// packages/workflows/src/offboarding-workflow.ts
tenantOffboardingWorkflow(input: OffboardingInput): Promise<OffboardingOutcome>

// workers/workflow/src/ops-erase.ts
eraseCommand(args: string[]): Promise<number>
```

**Calls:** `setTenantStandingInTx` from subscriptions, `revokeConnection`, `listConnections` from M3 (stubs here, real on `m3-verified-actions`, so inject in tests), the ports in `OffboardingPorts`, `emit(TENANT_SCHEDULES_ENDED)`.

**Things to get right:**

- **The workflow stops at `ready_for_erasure`, and nothing automated erases.** `advanceOffboardingStep` is one idempotent step, each recording its time. A durable `sleep` until `transition_ends_at`. No transition set: stays waiting and says so, and erasure is refused.
- **External actions in `sending`, `reconciling` or `unknown` hold up winding down**, and a person is told. They never just vanish.
- `requestOffboarding`: owner only, a person only, and the exact name typed. Case-sensitive, and a mismatch does nothing.
- `eraseTenantRows`: passes over `listErasableTables` until nothing moves, each table in its own transaction binding the tenant, in a savepoint, since `23503` means try again next pass. A table it cannot empty is reported. The list comes from the catalog, so it cannot go stale.
- `eraseCommand`, in order: `beginErasure` (app role), tombstone every artifact through the existing path, **wait for the ledger to drain, or stop and say so**, `eraseTenantRows` (eraser role), `finishErasure` (app role). Re-running is safe at every point. It refuses with `DATABASE_URL_ERASER` unset, or a role that cannot connect.
- `finishErasure`: anything `left_over` keeps it at `erasing` with the list. **"Verified" means nothing left.** The report states everything in `RETAINED_RECORDS`, with a reason code for each.
- **A test compares `lifecycle.retained_table` plus the eraser's grants against every table with `organization_id`, in the whole database**, so a later table cannot go unnoticed. This is the most important test in the slice. It lives in `saas-erasure.test.ts`.

**QA:** owns Journey F's deletion half. `QA-025` for offboarded data after a restore.

**Denied and fault tests:** an admin or member cannot start or cancel. A wrong name does nothing. Another tenant cannot see or cancel. Cancel after `erasing` refused. `erasing` refused with an active hold, an unfinished step, or a transition not over (`EN804`, `EN805`). A hold placed during erasure stops the eraser's next delete, by policy. Eraser cannot read content or touch another tenant, and cannot run with no open erasure. Crash mid-erasure, rerun: finishes, and the counts are honest. Billing, audit and tombstones survive, and tenant B is untouched row by row. A canary in a Work Unit title, a file and a ticket is gone from every table the eraser reaches, and appears nowhere in the report. A deleted tenant looks missing to its old members. Tombstones mean a restore does not bring bytes back.

## support: `OPS-22`, `OPS-24`

The support desk, and break-glass by design. Acceptance: published hours match real staffing, and support has no default access to content. Default is no support access to content, and any access needs a second authorizer, a time limit and an audit trail.

**Owns:**

- `packages/saas/src/support.ts` (the stubs), new `support.test.ts`
- `packages/application/src/saas/support.ts`, `support-desk.ts`, `break-glass.ts`
- `workers/workflow/src/ops-desk.ts`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/support/**`
- new `apps/web/src/app/o/[organizationId]/account/support/**`, `account/break-glass/**`, new `apps/web/src/server/support-actions.ts`
- new `tests/integration/saas-support.test.ts`, `saas-break-glass.test.ts`, `tests/stack/saas-support-api.test.ts`, `tests/browser/specs/support.spec.ts`

**Implements:**

```ts
// @ensemus/saas/support
signBreakGlass(facts, signature, config, now): BreakGlassDecision
breakGlassInForce(facts, now): boolean
withinCoverage(windows, timezone, at): boolean

// @ensemus/application/saas/support
listTickets, getTicket, openTicket, replyToTicket, closeTicket, getPublishedCoverage

// @ensemus/application/saas/support-desk
listDeskQueue, replyAsDesk, requestBreakGlass

// @ensemus/application/saas/break-glass
listBreakGlassRequests, decideBreakGlass, revokeBreakGlass, authorizeBreakGlassAsOperator

// workers/workflow/src/ops-desk.ts
deskCommand(args: string[]): Promise<number>
```

**Things to get right:**

- **No code path reads customer content because of a request.** No grant, no check, no "if authorized" anywhere. A test scans for one: nothing outside this slice's files imports `breakGlassInForce`.
- `signBreakGlass`: `authorized` needs both signatures, from two different people, within `config.maxMinutes`. Time runs from the second signature. `enabled: false` is `BREAK_GLASS_DISABLED`, which is every deployment by default.
- `decideBreakGlass`'s scope must be in this tenant. An owner can refuse or revoke at any time, and revoking needs no reason from them. Every step writes `support.break_glass_log` and `auditAction`.
- The ticket page says, in plain words, that support sees what is written here and nothing else, and asks people not to paste secrets.
- Coverage: none published means the page says none is published. **No hours, response times or promises in code or in the words.** `first_response_at` measures. It does not promise.
- A member sees only tickets they opened, an owner or admin sees all, and the desk queue shows IDs and status, not the subject, until a ticket is opened by the desk.

**QA and threat:** owns `SEC-011`, the support role boundary test, in `saas-support.test.ts`, on top of the catalog check in `saas-schema.test.ts`.

**Denied and fault tests:** `ensemus_support` reading `work`, `integrations`, `secrets`, `org`, `identity` or `billing` refused, each. The desk replying as a customer refused, and a customer replying as the desk refused. A requester signing as operator refused by constraint. Authorized with one signature refused. A limit longer than asked or than configured refused. Admin and member cannot authorize. Another tenant's request not found. Expiry holds by the clock with no sweep. A request filed with the feature off refused. A suspended tenant can still open a ticket. Another tenant's ticket is not found.

## operations: `OPS-04`, `OPS-06`, `OPS-23`, `OPS-25`

Dashboards, alerting, runbooks, the incident process, the status page and vulnerability disclosure. Acceptance: health, cost and trace correlation with sanitized logs. SRE can execute a documented incident drill. Drill completed with named roles, and provider outages distinguished from Ensemus outages. Published process exercised once, end to end.

**A person has to run the drills and exercise the disclosure process.** This slice makes them runnable and recordable, and does not claim they happened.

**Owns:**

- `packages/saas/src/operations.ts` (the stub), new `operations.test.ts`
- `packages/application/src/saas/status.ts`, `operator-incidents.ts`
- `workers/workflow/src/ops-incident.ts`
- new `apps/web/src/app/status/page.tsx`, `apps/web/src/app/security/page.tsx`
- new `infrastructure/observability/**`
- new `docs/05-operations/07-observability.md`, `08-runbooks.md`, `09-incident-process.md`, `10-vulnerability-disclosure.md`
- new `tests/unit/observability-rules.test.ts`, `tests/integration/saas-incidents.test.ts`, `tests/stack/saas-status.test.ts`, `tests/browser/specs/status.spec.ts`

**Implements:**

```ts
// @ensemus/saas/operations
overallStatus(open: readonly PublishedIncident[]): ServiceStatus

// @ensemus/application/saas/status
getStatusPage(database, { limit }): Promise<StatusPage>

// @ensemus/application/saas/operator-incidents
openIncident, assignIncidentRoles, updateIncident, resolveIncident, recordDrill,
recordVulnerabilityReport, moveVulnerabilityReport

// workers/workflow/src/ops-incident.ts
incidentCommand(args: string[]): Promise<number>
```

**Files, in `infrastructure/observability/`:** alert rules and dashboards as portable YAML and JSON, for the log fields and events that exist (`errorCode`, `count`, `tombstone_ledger.backlog`, `dispatcher.delivery_problem`, and so on). P0 per `docs/05-operations/01` section 3: cross-tenant policy signals, forbidden egress, compromised keys, repeated duplicate side effects. M8's own: `unmatched` payment events, `unknown` payments, overdue invoices with no policy, erasures left over, restore pending, and the outbox's dead count. **Thresholds are marked as tuning values, and no objective is one the owner has not agreed.** The monitoring product is an owner decision, so nothing is wired to one. Report the compose work as owed.

**Runbooks,** per `docs/05-operations/01` section 6, each with diagnosis, reversible mitigation, safe fallback, communication and post-incident check: database pressure, Temporal backlog, model provider outage, rate limit storm, webhook poison events, identity misconfiguration, compromised credential, storage outage, plus M8's: an unknown payment, an unmatched payment event, a suspended tenant asking to come back, and a failed erasure. Each uses commands that exist.

**Things to get right:**

- `overallStatus`: an open `model_provider` incident is `provider_degraded`, and never `degraded`. No published incident is `operational`, and if the read fails the page says `unknown`, and never operational. **No uptime percentage: none is measured.**
- `/status` takes no session, and works with no tenant bound, through `database.run`. RLS shows only published, non-drill incidents, and only the granted columns, which a test proves with a canary in `postmortem_ref` and `commander_ref`.
- `updateIncident` refuses to publish a drill. A commander is required. Closing anything above `medium` needs a postmortem reference.
- The disclosure doc and `security` page say how to report, what happens next, and safe harbor is **marked as needing counsel**. Contact and any terms are placeholders marked to replace, and `security.txt` is a template. No promise of response time.
- `recordVulnerabilityReport` holds references, never details.

**QA:** owns Gate F's drill scripts, with the owner running them.

**Denied and fault tests:** application role cannot read a draft or drill incident, or any vulnerability report. Support role cannot write incidents. A provider's outage never shows as ours. `operator-incidents` from a role without grants is refused. Rule files parse, every alert names a runbook that exists, and no rule file names a tenant, an email or a free-text field. Logs in the runbook's examples carry only fields in `SAFE_FIELDS`.

## load: `OPS-01`, `PLAT-17`

A dependency-free load harness and autoscaling manifests, **written and not run.** Acceptance: document p95 latency and tenant fairness, with web and agent p95, event-loop delay, backlog and cost per outcome recorded. An agent burst does not starve normal business reads.

**Owns:**

- new `tests/load/**`, new `tests/unit/load-harness.test.ts`
- new `infrastructure/autoscaling/**`
- `docs/05-operations/06-performance-and-load-plan.md`, `docs/05-operations/04-cost-and-capacity.md`

**Implements:**

```ts
// tests/load/harness.mjs, on Node's fetch and timers only, with no new dependency
runProfile(profile: LoadProfile, target: { baseUrl; tenants }, clock?): Promise<LoadReport>
summarize(samples): { p50; p95; p99; errorRate }
fairness(perTenant): { worstToBestP95Ratio }
// tests/load/profiles.mjs
small, medium, growing, multiTenantAggregate   // from docs/05-operations/04 section 4
// tests/load/run.mjs
// node tests/load/run.mjs --profile small --base-url <url> --out <file>
```

**Things to get right:**

- **The profiles are test personas, not capacity tiers** (`docs/05-operations/06`). Their numbers are parameters, and no output says what a size of company can do. A report states what ran, on what, and nothing beyond it.
- Runs A to L from the plan as named scenarios. What needs a stack refuses to run with no `--base-url`.
- `PLAT-17`: an agent burst scenario alongside business reads, and a report that separates web p95 from agent queue wait and event-loop delay. Cost per verified outcome reads M4's ledger, and is marked as owed until it exists.
- Manifests in `infrastructure/autoscaling/`: web and each worker scale on their own signal (HTTP latency, Temporal schedule-to-start backlog), and connector worker concurrency stays low. Container platform is an owner decision, so portable HPA-style and KEDA-style files with no cluster or registry named.
- A unit test proves the harness: `summarize` and `fairness` on known samples, a fake clock, and parsing every profile and manifest.

**Denied and fault tests:** the harness refuses a target that is not named on the command line, and has no default URL. It uses generated accounts only, never a real credential, and a tenant's data never appears in a report. A failed request counts against the numbers and is not dropped.

---

# Wave 2: after wave 1 is merged

## close: all M8 tickets

The one writer after the merge: flips the spec, proves it together, and says what is true. **None of the stack runs locally.** Make it typecheck, and say so.

**Owns:**

- `docs/specifications/openapi.yaml`, `packages/contracts/generated/**`, `tests/unit/openapi-contract.test.ts`
- `tests/unit/saas-foundation.test.ts` (add to it, weaken nothing)
- new `tests/stack/slice-m8.test.ts`, new `tests/helpers/slice-m8.ts`
- `packages/application/src/webhooks.ts`, `packages/workflows/src/webhook-activities.ts` **only** for the `payment_event` branch, if M3 is merged by then
- `docs/05-operations/05-container-deployment-runbook.md`, `docs/02-architecture/03-data-model.md`, `docs/05-operations/02-deployment-and-recovery.md`
- `docs/specifications/traceability.csv`, `qa-scenarios.csv`, `implementation-backlog.csv`, `threat-register.csv`
- new `docs/06-delivery/evidence/M8-report.md`, `docs/06-delivery/06-end-to-end-delivery-plan.md`
- **`docs/MANIFEST.json`, last of all:** `node docs/specifications/tools/regenerate-manifest.mjs`

**Does:**

1. For each route that exists, remove `x-ensemus-status: planned` and its line in the test, and regenerate with `pnpm --filter @ensemus/contracts generate`. Leave anything not built marked planned.
2. Write the M8 slice on real containers, for later: an operator approves a card and plan. A tenant subscribes. Usage comes in through a fixture for the ledger. The cycle invoices it, and the invoice matches. The fake processor is injected into a test-only worker image, **never the shipped one**, and charges once, with a timeout-after-charge variant ending `unknown`. A webhook comes down M3's path and settles it. A top-up at zero credits, with `QA-026` end to end, and `QA-027` for a BYOM tenant. A failed payment follows a published policy to read-only and back, with no row lost. A legal hold stops a deletion. Offboarding reaches `ready_for_erasure`, the operator erases, and the report is true. Support reads no content. Canaries are absent from Temporal, logs and events.
3. Runbook: turning on billing, the three roles and `upgrade-roles-m8.sql`, operator commands, and what stays off until the owner decides.
4. `qa-scenarios.csv` and the backlog move only on evidence. `M8-report.md` says what ran, on what, and what did not. **It claims nothing that nothing has shown.** With no Docker run, most of this stays not verified, and it says so.

**Merge order:** nothing depends on order for compiling, since every signature exists. For tests to pass end to end: catalog, subscriptions, credits, invoicing, payments, retention, offboarding, support, operations, load, then close. If the ownership above held, there are no conflicts to resolve.

## Handoff

Each builder reports: tickets, files, behaviour, commands actually run with results, anything fixed or stubbed left over, what could not run, histories owed, and any report under "If you need a change". Commit with several `-m` flags, the last being `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`. Do not push. Finish with `git checkout --detach`.
