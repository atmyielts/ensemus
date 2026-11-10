# M3 slices

Six builders work in parallel from the foundation commit, and **no file has two owners**. Everything they must agree on is already decided in [ADR-027](../00-foundation/adr/ADR-027-verified-external-actions.md) and already typed in the code. Read that ADR first, because it holds the reasons.

If you need a change to a file you do not own, or to anything in "Fixed" below, stop and report it. Do not work around it, and do not edit the file.

## Fixed: nobody changes these

| What | Where |
|---|---|
| Migrations, RLS, roles and triggers. **No builder adds a migration** | `packages/database/migrations/0012_*`, `0013_*`, `meta/`, `packages/database/src/schema-integrations.ts` |
| Tenant binding for webhooks | `withWebhookEndpointTx` in `packages/database/src/tenant.ts` |
| Statuses, transitions, outcomes, codes | `EXTERNAL_ACTION_*`, `ATTEMPT_OUTCOMES`, `RECEIPT_*`, `RESOLUTIONS`, `EXTERNAL_ACTION_CODES` in `packages/domain/src/external-action.ts` (intents fills in the three stub functions, and does not change these) |
| Event names | `packages/domain/src/integration-events.ts` |
| Temporal input shapes and queue names | `packages/workflows/src/schemas.ts`, `constants.ts`, `connector-deps.ts` |
| Dispatcher, worker and connector-worker wiring | `workers/workflow/src/dispatcher.ts`, `main.ts`, `connector-worker.ts`, `scripts/build.mjs` |
| Wiring into existing files | `packages/workflows/src/workflows.ts` (re-exports), `activities.ts` (`purgeExpiredWebhookDeliveries` in upkeep), `packages/application/src/index.ts`, `integration-ports.ts`, `errors.ts`, `apps/web/src/lib/messages.ts`, `packages/domain/src/policy.ts`, `packages/config/src/index.ts` |
| Import rules | `eslint.config.mjs` |
| Dependencies. **`pnpm-lock.yaml` is frozen, and no builder adds a package.** All the workspace links are in place, and the web tier can already import `@ensemus/connectors/manifest` and `@ensemus/secrets/seal` | every `package.json`, `apps/web/next.config.ts` |
| Shared test helpers | `tests/helpers/integrations.ts`, `tests/helpers/stack.ts`, `tests/replay/capture-support.ts`, `tests/replay/corpus.ts`, `tests/replay/capture.test.ts`, `tests/integration/integrations-schema.test.ts` |
| Decisions | ADR-027, this file |

A bug in any of these is reported, not fixed in passing.

## What runs where

| Rule | Detail |
|---|---|
| Integration tests | With your own `COMPOSE_PROJECT_NAME`, `ENSEMUS_NETWORK_PREFIX` and `ENSEMUS_TEST_PG_PORT`, and run **your own test file**: `pnpm exec vitest run --project integration tests/integration/<yours>.test.ts` |
| **Do not run the whole integration suite in parallel** | `tests/integration/auth.test.ts` publishes `oidc-mock` on the fixed port 58080, so two runs of it collide. That file and that port were left alone on purpose. Whoever runs the full suite, runs it alone |
| Never locally | `docker build`, the app stack, stack tests, browser tests, the upgrade gate, the air-gap gate, any `prune`. These run in CI. Write them, make them typecheck, and say they did not run |
| Replay capture | Needs Temporal, which is not the app stack and builds nothing. In your own project: `docker compose -p <yours> -f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.test.yaml -f infrastructure/compose/compose.capture.yaml up -d --wait temporal-test-port` with `ENSEMUS_TEST_TEMPORAL_PORT` set. Then `ENSEMUS_CAPTURE_REPLAY=1 pnpm exec vitest run --project replay tests/replay/capture-<yours>.test.ts`. Bring it down with `down -v`. If your instructions forbid even this, leave the capture test written and report the histories as owed |
| Disk | Below 4 GB free on C:, stop and report |

## Build order inside the tree

Stubs throw `NOT_IMPLEMENTED`, and each slice can be tested without the others, as follows:

- `tests/helpers/integrations.ts`, `seedExternalAction`, walks an intent to any status through the real triggers. Receipts, stack and anything else needing one uses it. A Work Unit can hold **one open approval**, so seed each `awaiting_approval` on its own Work Unit.
- Intents is tested against a scripted `ExternalActionGateway`, and webhooks against recording `WebhookEffectHandlers`. Neither needs the SDK or the other slice.
- Where your code calls another slice's stub at runtime, your own tests inject a double. The stack slice proves the real parts together.

## Every slice

- Denied and cross-tenant tests first, then the code. Two tenants, same names, real roles.
- Only IDs, enums and counters cross Temporal. New workflows only import `@temporalio/workflow` and types. A workflow's decisions live in a small pure module, as `review-wait.ts` does, so a unit test can reach them.
- All three workflows run on `PLATFORM_TASK_QUEUE`, where the dispatcher starts them, and the main worker has their code. Anything holding a credential, or reading what a stranger sent, is an Activity proxied to `CONNECTOR_TASK_QUEUE`, which only the connector worker polls and which runs no workflows.
- A new workflow's histories join `tests/replay/histories/` and a `tests/replay/<area>-corpus.test.ts` you own lists them. Each path gets one. `tests/replay/replay.test.ts` replays every file there by itself.
- Generated test values only: `@example.invalid` addresses, random secrets. No real address, credential or provider, and do not claim anything you did not prove.
- Log codes, never text from a provider or a body. Stored reasons come from `EXTERNAL_ACTION_CODES` or `WEBHOOK_REJECT_CODES`.
- Follow the house comment style: say why, in plain sentences.

## intents: `WORK-08`

The state machine, application service, Activities, workflow, replay corpus and fault tests. `QA-007`, `QA-008`, `AI-TS-01`.

**Owns:**

- `packages/domain/src/external-action.ts` (the three stubs only), and new `packages/domain/src/external-action.test.ts`
- `packages/application/src/external-actions.ts`
- `packages/application/src/approvals.ts`, `packages/application/src/work.ts`
- `packages/workflows/src/external-action-workflow.ts`, `external-action-activities.ts`, new `external-action-step.ts` and `external-action-step.test.ts`
- new `tests/integration/external-actions.test.ts`, `tests/replay/capture-external-action.test.ts`, `tests/replay/external-action-corpus.test.ts`, `tests/replay/histories/external-action-*.json`
- new `tests/integration/fixtures/scripted-gateway.ts`

**Implements, with these exact signatures** (all stubbed already):

```ts
// @ensemus/domain/external-action
checkBeforeSend(facts: SendFacts, now: Date): SendCheck
decideAfterAttempt(result: AttemptResult, attemptNo: number): AttemptDecision
decideAfterReconcile(result: ReconcileResult, lookup: 'none' | 'best_effort' | 'authoritative'): ReconcileDecision

// @ensemus/application
proposeExternalActionInTx(tx, context, input: ProposeExternalActionInput): Promise<ProposedExternalAction>
proposeExternalAction(database, context, input): Promise<ProposedExternalAction>
reviseExternalAction(database, context, { externalActionId, expectedVersion, payload, approverMembershipId }): Promise<ProposedExternalAction>
retryExternalAction(database, context, { externalActionId, approverMembershipId }): Promise<ProposedExternalAction>
onApprovalClosedInTx(tx, context, { approvalId, outcome }): Promise<void>
beginAttempt(database, context, { externalActionId, runId }): Promise<BeginAttemptResult>
finishAttempt(database, context, { attemptId, result }): Promise<AttemptStep>
inspectInterrupted(database, context, { externalActionId }): Promise<InterruptedState>
beginReconcile(database, context, { externalActionId, code }): Promise<ReconcilePreparation>
finishReconcile(database, context, { attemptId, result, lookup }): Promise<ReconcileStep>
failUnsent(database, context, { externalActionId, code }): Promise<void>
countVerifiedReceipts(tx, workUnitId): Promise<number>

// @ensemus/workflows/external-action-activities
createExternalActionPlatformActivities({ database }) -> { inspectInterruptedAction, failUnsentAction }
createExternalActionConnectorActivities(deps: ConnectorActivityDeps) -> { sendExternalAction, reconcileExternalAction }

// packages/workflows/src/external-action-workflow.ts
externalActionWorkflow(input: ExternalActionInput): Promise<ExternalActionResult>
```

**Calls:** `runSend`, `runReconcile` from `@ensemus/connectors/runtime` (sdk), only inside the connector Activities, behind an `ExternalActionGateway` you build there. `emit`, `notify`, `auditAction`, `applyTransition`, `createApprovalInTx`, `recordApprovalClosed` from what exists.

**Things to get right:**

- Workflow options: `proxyActivities<ExternalActionConnectorActivities>({ taskQueue: CONNECTOR_TASK_QUEUE, startToCloseTimeout: '2 minutes', scheduleToStartTimeout: '1 hour', retry: { maximumAttempts: 1 } })` for the send. Reconcile may retry. A send Activity failing goes to `inspectInterruptedAction`, and never to another send without it saying `nothing_sent`.
- `scheduleToStart` timing out with nothing recorded means the connector worker is not there. That ends in `failUnsentAction` with `CONNECTOR_UNAVAILABLE`.
- `approvals.ts` and `work.ts`: every path closing an approval calls `onApprovalClosedInTx`, including expiry and `recordApprovalClosed`. Replace the `verifiedReceiptCount: 0` line with `countVerifiedReceipts`. `decideApproval` must compare an `email.send` approval's hash with its intent's, as it does for work reviews.
- The workflow must end on `unknown` and take no further step: the person's answer does not need the workflow.
- `work.ts`'s `criteriaSchema` refuses `external_receipt` because nothing could ever satisfy it, and `tests/integration/work.test.ts` and `tests/stack/api.test.ts` hold that. **Do not edit those tests: they stay true.** Accept the criterion only when this tenant has an active connection whose type is in `ACTION_CONNECTOR_TYPES`, and answer `INVALID_INPUT` otherwise, which is what those tests see, with no connection.

**Fault tests the exit depends on** (`tests/integration/external-actions.test.ts`, with the scripted gateway):

- The effect happens and then the call times out: one effect recorded, ends `unknown`, and repeated Activity calls add none. (`QA-008`)
- The worker "dies" after `beginAttempt`, with no outcome recorded: a retried send refuses, `inspectInterrupted` says `attempt_open`, and it ends `unknown`. The gateway was called once. (`AI-TS-01`)
- Replay: `sendExternalAction` called again for the same intent at every state contacts nobody.
- Changed recipients after approval: the approval is void, the old intent is cancelled, nothing goes out, and a tampered row (using the superuser test URL) ends `PAYLOAD_CHANGED`. (`QA-007`)
- `not_sent`, retry, then `accepted`: one receipt, two attempts. Five `not_sent`: `failed`, `ATTEMPTS_EXHAUSTED`.
- Stop, revoked connection, or expired approval between approval and attempt: no contact. (`SEC-06`)
- Restricted work refused, and a proposer naming themselves as approver refused. Another tenant's Work Unit or connection: not found.

## sdk: `CONNECT-01`

SDK runtime, cursor protocol, ACL mapping, conformance suite and fake connector. Acceptance: incremental sync idempotent, source ACL mapped.

**Owns:**

- `packages/connectors/src/index.ts`, `manifest.ts`, `runtime/actions.ts`, `runtime/sync.ts`, `runtime/acl.ts`, `runtime/index.ts`, `runtime/registry.ts`, `runtime/network.ts`, `testing/**`, and new `packages/connectors/src/runtime/*.test.ts`
- `packages/domain/src/connector.ts`
- `packages/application/src/connections.ts`
- `packages/workflows/src/connector-sync-workflow.ts`, `connector-sync-activities.ts`
- new `tests/integration/connections.test.ts`, `tests/integration/connector-sync.test.ts`, `tests/replay/capture-connector-sync.test.ts`, `tests/replay/connector-sync-corpus.test.ts`, `tests/replay/histories/connector-sync-*.json`

**Implements:**

```ts
// @ensemus/connectors/runtime
runSend(call: ConnectorCall): Promise<AttemptResult>
runReconcile(call: ConnectorCall): Promise<ReconcileResult>
runSyncPass(deps: SyncPassDeps): Promise<SyncPassResult>
mapSourceGrants(grants, directory: PrincipalDirectory): Promise<readonly MappedGrant[]>

// @ensemus/connectors/testing
createFakeConnector(script: FakeConnectorScript): Connector<FakeConnectorConfig>
describeConnectorConformance(name, make, fixtures): void

// @ensemus/application
createConnection, listConnections, getConnection, revokeConnection, requestConnectorSync,
loadConnectionForWorker, leaseSyncStream, commitSyncPage, finishSyncStream, resolveSourcePrincipal
// signatures in packages/application/src/connections.ts

// @ensemus/workflows/connector-sync-activities
createConnectorSyncActivities(deps: ConnectorActivityDeps) -> { syncConnection }
// packages/workflows/src/connector-sync-workflow.ts
connectorSyncWorkflow(input: ConnectorSyncInput): Promise<ConnectorSyncOutcome>
```

**Things to get right:**

- `runSend`: `NotSent` becomes `not_sent` with its code. Any other throw, and the deadline, become `indeterminate` with `TIMEOUT_AFTER_COMMIT` or `CONNECTION_LOST_AFTER_COMMIT`. Error text never comes out. Unit-test each.
- `createConnection` needs `connection.manage`, and refuses anything but a lowercase type from the manifests its caller passes. `revokeConnection` emits `CONNECTION_REVOKED`. `syncConnection` finds a revoked connection and calls `deps.secrets.revoke` instead of syncing.
- Applying the same page twice leaves every row and `updated_at` alone. A lost compare-and-swap returns null and stops the pass, and nothing partial commits.
- Two tenants with the same `external_id` get separate rows. Another tenant's connection: not found.
- A grant that maps to nobody keeps its row and gives nothing, and `aclState` comes from `aclStateOf`. `domain` and `anyone` map to nothing.
- Connector config and `lastErrorCode` are shown to admins, so test that no credential or provider text can get in.

**Conformance suite:** manifest shape and type format, `parseConfig` refuses what it should, `send` honours abort, errors carry no provider text, and a declared capability exists while an undeclared one is absent. The email and inbound connectors each run it in their own test file.

## webhooks: `CONNECT-02`

Web route, worker verification, dedupe, `QA-019`. Acceptance: replayed or malicious callback rejected.

**Owns:**

- new `apps/web/src/app/api/webhooks/[token]/route.ts`, new `apps/web/src/server/webhook-ingress.ts`, new `apps/web/src/lib/webhook-limiter.ts`
- `packages/application/src/webhooks.ts`
- `packages/domain/src/webhook.ts`, new `packages/domain/src/webhook.test.ts`
- `packages/connectors/src/runtime/webhook-signature.ts` and its test, `packages/connectors/src/inbound/**`
- `packages/workflows/src/webhook-workflow.ts`, `webhook-activities.ts`
- `infrastructure/compose/proxy/Caddyfile`, `Caddyfile.test`
- new `tests/integration/webhooks.test.ts`, `tests/unit/webhook-limiter.test.ts`, `tests/stack/webhook-route.test.ts`, `tests/replay/capture-webhook.test.ts`, `tests/replay/webhook-corpus.test.ts`, `tests/replay/histories/webhook-*.json`

**Implements:**

```ts
// @ensemus/application
ingestWebhookDelivery(database, { token, body, headers }, { assertServing }?): Promise<WebhookIngressOutcome>
createWebhookEndpoint(database, context, { connectionId, signingSecretId, signatureScheme }): Promise<CreatedWebhookEndpoint>
disableWebhookEndpoint(database, context, { endpointId }): Promise<void>
loadStoredDelivery(database, context, { deliveryId }): Promise<StoredDelivery | null>
rejectDelivery(database, context, { deliveryId, code }): Promise<DeliveryStep>
applyVerifiedDelivery(database, context, { deliveryId, providerEventId, effects }, handlers: WebhookEffectHandlers): Promise<DeliveryStep>
purgeExpiredWebhookDeliveries(database, context, now): Promise<number>

// @ensemus/connectors/runtime
verifyWebhookSignature(secret: Buffer, input: WebhookVerifyInput): WebhookVerification
signWebhook(secret: Buffer, { timestampSeconds, eventId, body }): string

// @ensemus/connectors/inbound
createInboundConnector(): Connector<InboundConfig>

// @ensemus/workflows/webhook-activities
createWebhookActivities(deps: ConnectorActivityDeps) -> { processWebhookDelivery }
// packages/workflows/src/webhook-workflow.ts
webhookDeliveryWorkflow(input: WebhookDeliveryInput): Promise<WebhookDeliveryOutcome>
```

**The route, in order:** `connectorsEnabled` false is 404. Per-replica limits are next, in memory, in the pure `webhook-limiter.ts`, with no database touched. A route file imports `server-only`, so its HTTP answers are tested in `tests/stack/webhook-route.test.ts`, which CI runs, and the limiter and the service are what you test here. Then declared length, then the bytes counted against the 1 MiB ceiling with a read deadline. Then `ingestWebhookDelivery` on a database handle with its own small pool (`openAppDatabase(url, { max: 2 })`). Answers: 202, 404, 413, 429 with `Retry-After`, 503 during a restore. **No body, and no difference between an unknown and a disabled token.** It uses no `apiRoute`, because it has no session. The token never goes in a log.

**`ingestWebhookDelivery`, in one transaction through `withWebhookEndpointTx`:** the endpoint's `maxBodyBytes`, then the allowlisted headers, each cut at `WEBHOOK_MAX_HEADER_BYTES`, then insert with `onConflictDoNothing` on the digest. If no row, an exact repeat: answer `accepted`, admit nothing. If a row, call `integrations.admit_webhook_delivery`, and if it says no, roll back and answer `rate_limited`. Then `emit` `WEBHOOK_RECEIVED` with the aggregate `AGGREGATE_WEBHOOK_DELIVERY`.

**`processWebhookDelivery`, on the connector queue:** `loadStoredDelivery`, null means finished. Lease the secret with `SECRET_PURPOSE_WEBHOOK_SIGNING`, and try the previous one only while valid. `verifyWebhookSignature`. On failure, `rejectDelivery`. On success, `interpret`, and `MalformedWebhook` is a rejection too. Then `applyVerifiedDelivery`, with handlers that call `proposeExternalActionInTx` (approver: the Work Unit's owner, with no requester) and `emit(CONNECTOR_SYNC_REQUESTED)`.

**Things to get right:**

- `applyVerifiedDelivery`: the inbox insert is first, and effects share its transaction. A refused effect (work not in this tenant, restricted) makes the delivery `rejected`, with no retry loop. Bytes are dropped and `release_webhook_bytes` called in every ending.
- A secret that cannot be opened is not the sender's fault: rejected with `SECRET_UNAVAILABLE`, once, audited.
- The inbound connector declares `network: 'none'`, `credential.required: false`, and passes the conformance suite.
- Caddy: `request_body { max_size 1MB }` on `/api/webhooks/*`, in both files. Everything else stays.

**`QA-019` tests:** the three rows in ADR-027 D4's replay table, plus a bad signature, a missing signature, a signature for another endpoint, an altered body, a timestamp altered on a valid signature, a body over the limit, the rate limit, the backlog limit, a disabled endpoint, a token from another tenant, an unknown caller who then tries a real event ID (it still applies when the real one arrives, which proves nothing got in first), and a tenant's deliveries invisible to another.

## email

The email connector over SMTP using the SDK, a test SMTP sink with a mode that accepts the message and then never replies, compose and network changes, and air-gap rule changes.

**Owns:**

- `packages/connectors/src/email/**`, including its tests and conformance run
- `workers/workflow/src/egress-gateway.ts`, new `egress-gateway.test.ts`
- `infrastructure/compose/compose.yaml`, `compose.test.yaml`, `compose.airgap.yaml`
- `infrastructure/containers/Dockerfile.worker`, if the gateway's health check needs it
- `infrastructure/scripts/air-gap-gate.mjs`
- `tests/stack/platform.test.ts`
- new `tests/helpers/smtp-sink.ts`, `tests/helpers/fixtures/smtp-sink.mjs`, `tests/integration/email-connector.test.ts`

**Implements:**

```ts
// @ensemus/connectors/email
createEmailConnector({ tls, messageIdDomain }): Connector<EmailConfig>
// manifest: type EMAIL_CONNECTOR_TYPE, reconcile 'none', nativeIdempotency false, sync null,
// webhooks null, network 'egress_gateway', actions [EMAIL_SEND_TOOL], credential required

// tests/helpers/smtp-sink.ts
startSmtpSink(options: { mode: SinkMode }): Promise<{ port: number; messages(): SinkMessage[]; setMode(mode: SinkMode): void; close(): Promise<void> }>
type SinkMode = 'accept' | 'accept_then_silent' | 'refuse_recipient' | 'refuse_after_data' | 'busy' | 'silent_on_connect' | 'drop_after_data'
```

**The commit point is the first byte of the final `CRLF.CRLF`.** Everything before it that goes wrong is `NotSent`, with `retryable` true for connection trouble and 4xx, and false for 5xx. Anything after it with no reply is `indeterminate`: `TIMEOUT_AFTER_COMMIT` or `CONNECTION_LOST_AFTER_COMMIT`. A 5xx after the terminator is `rejected`, and a 250 is `accepted` with `ACCEPTED_BY_RELAY`. `reconcile` always returns `cannot_answer`. **Nothing here ever reads a message back, retries a send, or looks anything up.**

**The client:** `node:tls` over the `Duplex` from `ConnectorNetwork.openRelay`, and no `node:net` (lint enforces this). EHLO, STARTTLS when `tls` is `required` (and `TLS_REQUIRED` if not offered, so no silent downgrade), AUTH with the leased credential inside `withCredential`, then MAIL, RCPT, DATA. Test dot-stuffing, line length, 8-bit bodies, RFC 2047 subjects, and that a line break in any header field cannot get through, even past the contract schema. The `Message-ID` is `<{externalActionId}@{messageIdDomain}>`. `Bcc` never reaches a header. A payload's `from.address` that is not the connection's `fromAddress` is refused before contact, with `NotSent`, not retryable. **Check TLS certificates:** `rejectUnauthorized` is never false, and `tlsServerName` comes from the config.

**The gateway:** forwards bytes between one listening port and one `ENSEMUS_EGRESS_TARGET` (`host:port`), and refuses to start without it. It holds no secret, logs a code and no addresses of who connected, and bounds connections and idle time. Beat `/tmp/worker-alive` so the image's health check works, or override it.

**Compose, as ADR-027 D5 says:**

- `connector-worker`: `profiles: ['connectors']`, `command: ['node', 'dist/connector-worker.js']`, networks `connectors` only, `read_only`, pinned `postgres` and `temporal` through `extra_hosts`, secrets `db_app_url`, `db_secrets_url`, `sealing_private_key.pem`, `temporal_codec_key`, env `ENSEMUS_EGRESS_GATEWAY=egress-gateway:2525`, `ENSEMUS_SMTP_TLS`, `ENSEMUS_SMTP_MESSAGE_ID_DOMAIN`.
- `egress-gateway`: `profiles: ['connectors']`, `command: ['node', 'dist/egress-gateway.js']`, networks `connectors` and `outbound`, no secrets at all.
- New network `connectors`, `internal: true`, subnet `${ENSEMUS_NETWORK_PREFIX:-172.30}.5.0/24` with the same `ip_range` rule. New network `outbound`, subnet `.6.0/24`.
- `postgres` and `temporal` join `connectors` with pinned addresses (`.5.10`, `.5.11`), and the gateway is `.5.12`. Nothing else joins. **`web` stays off it.**
- `web` gets `ENSEMUS_CONNECTORS_ENABLED: ${ENSEMUS_CONNECTORS_ENABLED:-false}`.

**`compose.test.yaml`:** `web-2` the same; `smtp-sink` under the `connectors` profile, on `outbound` at `.6.20`, with its control port published to a test-only local port (as `temporal-test-port` does). `ENSEMUS_EGRESS_TARGET` points at it, and `ENSEMUS_SMTP_TLS=none` is set only here. **Add nothing else.** The Postgres port line is `ENSEMUS_TEST_PG_PORT`.

**Tests:** `tests/stack/platform.test.ts` keeps every existing assertion, and adds a check with `--profile connectors`: pins for the new services, `connector-worker` on `connectors` alone, `egress-gateway` holding no secret, `connectors` being internal, `web` off it. Without the profile the service list is what it was.

**Air-gap gate:** the existing rounds stay exactly as they are, without the profile. A new `--connectors` round runs the stack with the profile, sends through the sink, and fails if any packet leaves `172.30.0.0/16`. `compose.airgap.yaml` gets the new services. Do not run it locally.

**Integration tests (no containers beyond Postgres):** every sink mode against the real client and a real connector, including `accept_then_silent`: the sink has one message and the result is `indeterminate`, after the deadline, with no second connection. A credential never in a thrown error, a log or a result.

## receipts: `CONNECT-06`

API routes, and the receipt and manual-review UI on the existing design system, with empty, error and denied states, and browser specs. Acceptance: unknown external state visible for manual review.

**Owns:**

- `packages/application/src/receipts.ts`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/work-units/[workUnitId]/external-actions/route.ts`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/external-actions/**`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/connections/**`
- `apps/web/src/server/api.ts`, new `apps/web/src/server/external-action-actions.ts`
- new `apps/web/src/app/o/[organizationId]/external-actions/**`, `connections/**`
- `apps/web/src/app/o/[organizationId]/work/[workUnitId]/page.tsx`, `.../approvals/[approvalId]/page.tsx`, `.../inbox/page.tsx`, `apps/web/src/components/main-nav.tsx`, `apps/web/src/app/globals.css`, new `apps/web/src/components/receipt-*.tsx`, `new-email-form.tsx`, `resolve-form.tsx`
- `docs/specifications/openapi.yaml`, `packages/contracts/generated/**`, `tests/unit/openapi-contract.test.ts`
- new `tests/integration/receipts.test.ts`, `tests/stack/external-actions-api.test.ts`, `tests/browser/specs/external-actions.spec.ts`

**Implements:**

```ts
// @ensemus/application
listExternalActions(database, context, { workUnitId?, status?, after?, limit? }): Promise<ExternalActionPage>
getExternalActionDetail(database, context, externalActionId): Promise<ExternalActionDetail>
listExternalActionsNeedingReview(database, context): Promise<readonly ExternalActionSummary[]>
resolveUnknownExternalAction(database, context, { externalActionId, expectedVersion, resolution, reason }): Promise<{ status; version }>
```

**Calls** (stubs until intents and sdk land, so your own tests seed with `seedExternalAction` and never go through them): `proposeExternalAction`, `reviseExternalAction`, `retryExternalAction`, `createConnection`, `listConnections`, `getConnection`, `revokeConnection`, `requestConnectorSync`, `createWebhookEndpoint`, `storeSecret` from `@ensemus/secrets/seal`, schemas from `@ensemus/contracts/external-actions`.

**Things to get right:**

- `resolveUnknownExternalAction`: refuses a service context and anyone who cannot `canManageWork`, and answers `EXTERNAL_ACTION_NOT_RESOLVABLE` from any status but `unknown` and `VERSION_CONFLICT` on a stale version. Writes the status with `resolvedByMembershipId`, `resolution` and `resolutionReason`, a `person` receipt, `auditAction`, and `emit(EXTERNAL_ACTION_RESOLVED)`. **It sends nothing, and there is no send button on an unknown action.**
- API: each route goes through `apiRoute`. Flip `x-ensemus-status: planned` off and remove the line from `tests/unit/openapi-contract.test.ts` as each one lands, and regenerate with `pnpm --filter @ensemus/contracts generate`. The spec lists every response.
- A connection's credential: `storeSecret` with `SECRET_PURPOSE_CONNECTOR_CREDENTIAL`, and it is never returned, logged or echoed in a form. `connectorsEnabled` false answers `CONNECTOR_NOT_AVAILABLE`. Webhook creation generates the signing secret with `randomBytes` on the server, seals it, and shows it once with the URL and `Cache-Control: no-store`.
- Manifests come from `@ensemus/connectors/manifest` only.
- A Work Unit asks for a receipt through `completion_criteria.external_receipt`: add it to `CreateWorkUnit` in the spec, `apps/web/src/app/api/v1/organizations/[organizationId]/work-units/route.ts`, `apps/web/src/server/work-actions.ts` and `apps/web/src/components/new-work-form.tsx` (all owned here). Offer it only when the tenant has a connection that can act. The service refuses it otherwise, and `tests/stack/api.test.ts` holds that for an organization with none.

**The UI,** following what exists (`components/ui.tsx`, `globals.css`, `work/[workUnitId]/page.tsx`):

- Work page: a section listing this work's actions, and a form for proposing an email (recipients, subject, body, approver). The approver's page shows the exact email: `approvals/[approvalId]/page.tsx` is owned here too.
- `external-actions/page.tsx`: everything readable, with `Needs a decision` first. Empty, error and denied states, and a denied person gets the usual not found.
- `external-actions/[externalActionId]/page.tsx`: the exact payload and every receipt, on whose word it rests.
- Words: ADR-027 D6's table, exactly in meaning. **Unknown never looks like failed or like sent,** is never only a colour, and says what to do next, with the Message-ID to search for.
- The forms work without JavaScript, as the rest do (`tests/browser/specs/no-javascript.spec.ts`).
- Inbox: add `external_action.unknown`, `.failed`, `.sent` to `KIND_WORDS`, and `external_action` to `targetPath`.

**Tests, with no stack:** `tests/integration/receipts.test.ts` for reading and resolving: another tenant, someone with no access, a member only assigned, an admin who cannot read restricted work, a stale version, the wrong status, and a service context. **Written and typechecked, and not run locally:** the browser specs, with axe and keyboard use as the rest do, and the stack API test putting real responses through the OpenAPI validator.

## stack

`tests/stack` Slice 2 end to end on real containers, operator docs, and traceability entries for the new tests. **None of this runs locally: it runs in CI.** Make it typecheck and lint, and say so.

**Owns:**

- new `tests/stack/slice-2.test.ts`, new `tests/helpers/slice-2.ts`
- `package.json` (`stack:*` scripts), `.github/workflows/ci.yml`
- `docs/05-operations/05-container-deployment-runbook.md`, `docs/05-operations/02-deployment-and-recovery.md`
- `docs/02-architecture/03-data-model.md`, `docs/02-architecture/04-work-kernel.md`
- `docs/specifications/traceability.csv`, `qa-scenarios.csv`, `implementation-backlog.csv`, `threat-register.csv`
- new `docs/06-delivery/evidence/M3-report.md`, `docs/06-delivery/06-end-to-end-delivery-plan.md`
- **`docs/MANIFEST.json`, last of all.** Everyone else who changes a doc leaves it alone. It is regenerated at the end: `node docs/specifications/tools/regenerate-manifest.mjs`

**Slice 2, as this plan defines it** (from the build plan: connector webhook, signed Route Handler, outbox, Temporal, idempotent side effect, verification):

1. An admin makes an `email_smtp` connection and an `inbound_webhook` connection with an endpoint, through the API, with generated values.
2. A Work Unit has an `external_receipt` criterion.
3. A signed `external_action.proposed` is posted to the endpoint: 202.
4. The worker verifies it, an intent waits for approval, and the owner approves exactly what is shown.
5. The dispatcher starts the workflow, an attempt is recorded, and the sink receives **one** message with the exact recipients.
6. A `sent` receipt is on the page, the criterion is met, and the owner completes the work.

**And the rest of the exit, each on real containers:**

- **`QA-008`, timeout after send:** the sink in `accept_then_silent`. The message arrives once, the intent ends `unknown`, the owner is told, the page says so, and a long wait adds no second message. They resolve it, and the record names them.
- **`AI-TS-01`, a worker dying during it:** kill `connector-worker` while the sink is silent, and restart it. One message, ending `unknown`.
- **`QA-007`:** approve, then revise the recipients: the old one can never send, and only the new approval's recipients ever get anything.
- **`QA-019`:** replay the signed request, replay a valid old one, and repeat an event ID. No second intent.
- **Denied:** another tenant's token and page, a member who may not resolve, and an unsigned post.
- **A canary** in a recipient, a subject and a body: absent from Temporal's persistence, logs and events, as `temporal-confidentiality.test.ts` proves today.

**CI:** the existing jobs stay as they are. Add `COMPOSE_PROFILES=connectors` and `ENSEMUS_CONNECTORS_ENABLED=true` to a new stack step for this file, and the gate's `--connectors` round. Do not loosen anything.

**Docs:**

- The runbook: turning on the profile, the gateway's target, `ENSEMUS_SMTP_TLS`, the `unknown` queue and who watches it, and webhook poison events. **Correct "Email arrives with M3"**: this milestone adds outbound actions, and notification email is still not built.
- A restore keeps the connector worker stopped until unsettled intents are reviewed (ADR-027 D2). Say plainly that the code does not enforce this.
- `04-work-kernel.md` section 7 and `03-data-model.md`: "as built" notes, with `external_actions` in `integrations`.
- `qa-scenarios.csv` and the backlog move only on evidence. `M3-report.md` says what ran, on what, and what did not. **It claims nothing that CI has not shown.**

## Merge order

Nothing depends on order for compiling, since every signature exists. For tests to pass end to end: sdk, intents, webhooks, email, receipts, then stack. If the ownership above held, there are no conflicts to resolve.

## Handoff

Each builder reports: tickets, files, behaviour, commands actually run with results, anything fixed or stubbed left over, what could not run locally, and any report under "If you need a change". Commit messages end with the attribution line. Do not push. Finish with `git checkout --detach`.
