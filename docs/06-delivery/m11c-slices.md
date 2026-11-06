# M11C slices

Nine builders work in parallel from the foundation commit, a tenth finishes once they are merged, and **no file has two owners**. Everything they must agree on is already decided in [ADR-035](../00-foundation/adr/ADR-035-cross-org-tenants-regions.md) and already typed in the code. Read that ADR first, because it holds the reasons.

If you need a change to a file you do not own, or to anything in "Fixed" below, stop and report it. Do not work around it, and do not edit the file.

## Fixed: nobody changes these

| What | Where |
|---|---|
| Migrations, RLS, roles and triggers. **No builder adds a migration** | `packages/database/migrations/0700_*` to `0703_*`, `packages/database/src/schema-tenancy.ts`, `schema-federation.ts`. `meta/` and the journal are stitched at the final merge |
| The bridge's connection and binding | `packages/database/src/federation.ts`, `withGrantInvitationTx` in `tenant.ts` |
| Deploy-job writes | `packages/database/src/deployment.ts` |
| Rules, states, transitions, purposes, codes | `packages/domain/src/federation.ts`, `federation-events.ts`, `tenancy.ts`, `residency.ts`, the capabilities in `policy.ts` |
| Contracts and API shapes | `packages/contracts/src/federation.ts`, `tenancy.ts`, `docs/specifications/openapi.yaml` (the api slice removes `x-ensemus-status: planned` from what it builds, and nothing else) |
| Configuration | `packages/config/src/tenancy.ts` |
| Temporal shapes and queue names | `packages/workflows/src/schemas.ts`, `constants.ts`, `federation-deps.ts` |
| Worker wiring | `workers/workflow/src/dispatcher.ts`, `federation-worker.ts`, `apply-deployment-profile.ts`, `scripts/build.mjs`, `packages/workflows/src/workflows.ts`, `packages/database/src/migrate.ts` |
| Ports | `packages/application/src/federation-ports.ts`, `tenancy-ports.ts`, and the exports in `index.ts` and `errors.ts` |
| Import rules | `eslint.config.mjs`. Only three files may use the bridge role, and a test holds that list |
| Dependencies. **`pnpm-lock.yaml` is frozen, and no builder adds a package** | every `package.json` |
| Shared test helpers and rule tests | `tests/helpers/federation.ts`, `tests/integration/federation-schema.test.ts`, `tenancy-schema.test.ts`, `tests/unit/federation-rules.test.ts`, the domain and config tests |
| Decisions | ADR-035, this file, and the `XORG-TS`, `TIER-TS`, `RES-TS` and `TR-M11C` rows in `docs/specifications/` |

A bug in any of these is reported, not fixed in passing.

## What runs where

This milestone is code only. **Nothing here has run against PostgreSQL, Temporal or a container.**

| Rule | Detail |
|---|---|
| Allowed | `pnpm exec prettier`, `eslint`, `typecheck`, `pnpm --filter @ensemus/web exec next typegen`, `vitest run --project unit <paths>`, `pnpm test:replay`, each through the slot wrapper you were given |
| Never | Docker or compose in any form, `test:integration`, `test:stack`, `test:browser`, `test:upgrade`, any gate needing a container, editing a Dockerfile or compose file |
| Integration, stack, browser and replay-capture tests | **Still written and typechecked.** They count as unverified, and you say so. Never report one as passing |
| Migrations | Not in the journal until the final merge, so the tables do not exist for anything until then. Stubs throw `NOT_IMPLEMENTED` |
| Disk | Below 3 GB free on C:, stop and report |

## Build order inside the tree

Stubs throw `NOT_IMPLEMENTED`, and each slice can be tested without the others:

- `tests/helpers/federation.ts` walks a grant to any status through the real triggers. `ensureBridgeRole()` makes the bridge role with a throwaway password, because the test stack does not provision it. `setDeploymentProfile` and `clearDeploymentProfile` change something global, so clear it in `afterAll`.
- The bridge is tested against `FederationFollowUp` doubles, kept with its tests. The items slice does not need the bridge: it can seed an arrival with `ensureBridgeRole` and an exact-copy insert, as `federation-schema.test.ts` does.
- Pages and routes call the services' signatures. They typecheck against the stubs and are proved end to end by the flow slice.

## Every slice

- Denied and cross-tenant tests first, then the code. Two tenants with the same name, a third who knows the IDs, real roles. A person from another tenant hears what someone with a wrong ID hears.
- Only IDs, enums and counters cross Temporal. New workflows only import `@temporalio/workflow` and types.
- Generated test values only: `@example.invalid` addresses, regions spelled `test-region-a`. **No real region, certification, price, SLA, RTO or RPO, in code, in text or in a test.** Do not draft legal terms. The page never calls the terms an agreement in law.
- Log codes, never text. A title, a body, a note, an organization's name and a token never reach a log or a workflow.
- Wording says what is true: "declared by the operator", not "certified". "Names are not verified." "They may already have read it."
- Follow the house comment style: say why, in plain sentences.

## grants: `EXP-07`

The grant lifecycle as services. `XORG-TS-01`, `XORG-TS-02`, `XORG-TS-06`.

**Owns:** `packages/application/src/federation.ts`, new `tests/integration/federation-grants.test.ts`.

**Implements, with these exact signatures** (all stubbed):

```ts
getFederationSettings(database, context): Promise<FederationSettingsView>
setFederationEnabled(database, context, { enabled, expectedVersion }, entitlement: CrossOrgEntitlement): Promise<FederationSettingsView>
proposeGrant(database, context, input: ProposeGrantInput): Promise<{ grant: FederationGrantView; token: string }>
previewGrantInvitation(database, context, { token }): Promise<FederationInvitationPreview>
acceptGrantInvitation(database, context, { token, termsHash }): Promise<FederationGrantView>
confirmGrant(database, context, { grantId, termsHash, expectedVersion }): Promise<FederationGrantView>
endGrant(database, context, { grantId, reason, expectedVersion }): Promise<FederationGrantView>
endAllGrantsInTx(tx, context): Promise<number>
listGrants(database, context): Promise<readonly FederationGrantView[]>
getGrant(database, context, grantId): Promise<FederationGrantView>
expireDueGrants(database, context): Promise<number>
```

**Calls:** `buildGrantTerms`, `grantTermsHash`, `newFederationToken`, `hashFederationToken`, `organizationFingerprint`, `canTransitionGrant`, `FEDERATION_MAX_*`, the event names in `federation-events.ts`, `emit`, `appendAudit`, `can`, `withTenantTx`, `withGrantInvitationTx`. Maps EN7xx from `pgCode` to `AppError` codes.

**Rules:** `federation.manage` to begin or agree, `federation.end` to end, `federation.view` to read. `available` is `tenancy.deployment_profile.cross_org_enabled`, read as the application role, and false when there is no row. A wrong, used, expired or own token all answer `FEDERATION_INVITATION_INVALID`, with no difference in timing that a test can see. `setFederationEnabled(false)` calls `endAllGrantsInTx` first, in one transaction, each with its own `federation.grant_ended`. Audit in the acting tenant at each step. A notification to the sharing owners on acceptance is what prompts the third step.

**Denied and fault tests:** a member and an admin refused where an owner is needed. An admin can end. Off at the deployment or the tenant. Terms hash from a different proposal. Accepting one's own. A used token. A token from a third tenant finds nothing and changes nothing. Expired invitation. `expectedVersion` stale. Double acceptance by two tenants racing: one wins, and the other sees the invalid-invitation answer. Turning off with grants open ends them all, and each has an event.

## items: `EXP-07`

What is sent and what arrived, as each tenant sees it. `XORG-TS-03`.

**Owns:** `packages/application/src/federation-items.ts`, new `tests/integration/federation-items.test.ts`.

**Implements, with these exact signatures** (all stubbed):

```ts
publishItem(database, store: ObjectStore, context, { grantId, item: PublishItemBody, requestKey }): Promise<OutboundItemView>
withdrawItem(database, context, { itemId, expectedVersion }): Promise<OutboundItemView>
withdrawItemsForSourceInTx(tx, context, { sourceType, sourceId }): Promise<number>
listOutboundItems(database, context, { grantId }): Promise<readonly OutboundItemView[]>
listInboundItems(database, context, { disposition? }): Promise<readonly InboundItemView[]>
getInboundItem(database, context, itemId): Promise<InboundItemView>
readInboundFile(database, store, context, itemId): Promise<{ body: Buffer; mimeType: string; title: string }>
disposeInboundItem(database, context, { itemId, disposition, linkedWorkUnitId, expectedVersion }): Promise<InboundItemView>
listCrossings(database, context, { grantId?, cursor?, limit }): Promise<{ items; nextCursor }>
settleGrantEndForTenant(database, store, context, { grantId, counterpartyOrganizationId }): Promise<void>
removeWithdrawnItem(database, store, context, { itemId }): Promise<void>
recordItemReceived(database, context, { itemId }): Promise<void>
loadItemGrantForWorker(database, context, itemId): Promise<{ grantId; state } | null>
loadGrantPartiesForWorker(database, context, grantId): Promise<{ sharingOrganizationId; receivingOrganizationId } | null>
```

**Calls:** `itemContentHash`, `outboundObjectKey`, `inboundObjectKey`, `classificationAllowed`, `kindAllowed`, `directionOf`, `isGrantOpen`, `canReadWork` and the artifact read path, the idempotency service, `emit`, `appendAudit`.

**Rules:** `federation.share` to send and withdraw, `federation.view` to read. A person who cannot read the source gets not found. Classification comes from the source row, never from the request, except a `status_update`, which has no row. The file is put at the derived outbound key first, then the row, as artifacts do. A received item cannot be published: only the sender's own rows are looked up. `readInboundFile` rechecks the grant after reading, checks the hash, and writes `federation.file_read` to audit. `settleGrantEndForTenant` withdraws what remains, then deletes its rows and files, then deletes the derived inbound key of each of its file items at the counterparty, which covers a delivery that crashed after copying. Each repeat does nothing new.

**Denied and fault tests:** each kind against each purpose and direction. Above the grant's limit, and restricted always. A source in another tenant, or that this person cannot read. Publishing an inbound item's ID. A grant in `proposed`, `accepted` or `ended`. Listing as a third tenant. Reading a file after revocation, and during it, with a store double that revokes mid-read. A corrupted file hash. A repeat `requestKey`. A member without the capability. Withdrawing twice. A source deleted, then the item withdrawn in the same transaction.

## bridge: `EXP-07`

The crossing itself, and its workflows. `XORG-TS-04`, `XORG-TS-05`, `XORG-TS-07`, `XORG-TS-08`.

**Owns:** `packages/database/src/federation-crossing.ts`, `packages/workflows/src/federation-activities.ts`, `packages/workflows/src/federation-workflow.ts`, new `packages/workflows/src/federation-step.ts` and `federation-step.test.ts`, new `tests/integration/federation-bridge.test.ts`, `tests/integration/fixtures/federation-follow-up.ts`, `tests/replay/capture-federation.test.ts`, `tests/replay/federation-corpus.test.ts`.

**Implements, with these exact signatures** (all stubbed):

```ts
// @ensemus/database/federation, under BridgeDatabase.withGrant
readItemToCross(database: BridgeDatabase, { grantId, senderOrganizationId, itemId }): Promise<ItemToCross | null>
crossItem(database, { grantId, senderOrganizationId, itemId }): Promise<CrossingOutcome>
refuseItem(database, { grantId, senderOrganizationId, itemId, code }): Promise<void>
purgeInboundCopies(database, { grantId, itemId?, limit }): Promise<readonly PurgedItem[]>

// @ensemus/workflows/federation-activities, on FEDERATION_TASK_QUEUE
createFederationActivities(deps: FederationActivityDeps) => {
  deliverFederationItem(input: FederationItemInput): Promise<FederationDeliveryOutcome>
  recordFederationItemReceived(input: FederationItemInput): Promise<void>
  purgeFederationGrantPass(input: FederationGrantEndedInput): Promise<FederationPurgePass>
  purgeFederationItem(input: FederationItemInput): Promise<FederationPurgePass>
  settleFederationGrantEnd(input: FederationGrantEndedInput): Promise<void>
}

// Workflows, on PLATFORM_TASK_QUEUE, whose Activities are proxied to FEDERATION_TASK_QUEUE
federationDeliveryWorkflow(input: FederationItemInput): Promise<FederationDeliveryResult>
federationPurgeWorkflow(input: FederationPurgeInput): Promise<FederationPurgeResult>
```

**Calls:** `BridgeDatabase.withGrant`, `FederationFollowUp`, `createServiceContext`, `inboundObjectKey`, `FEDERATION_REFUSE_CODES`, `FEDERATION_MAX_FILE_BYTES`, `ObjectStore`. `withGrant` is the only way in. A transaction never spans bytes: copy, verify the hash, then cross.

**Rules:** `crossItem` locks the outbound row, finds it `delivered` and returns that on a repeat, otherwise writes the exact copy with the derived inbound key, a `delivered` crossing and the new state, in one transaction. A closed grant answers `closed` in every case, and writes nothing. `purgeInboundCopies` commits row and ledger first, then the Activity deletes the bytes, and repeats. A grant's purge ends with `settleGrantEnd` for both parties, using `loadGrantParties` under the event's tenant, which is one of them. Item purge ends with `removeWithdrawnItem` for the sender. The workflow's decisions go in `federation-step.ts`, pure, so a unit test reaches them.

**Denied and fault tests:** kill between copying bytes and crossing, then retry. Kill between purge commit and byte delete, then retry. An item withdrawn while queued is not delivered. A grant revoked between read and cross. Crossing racing revocation with real connections, the advisory lock proving nothing readable is left. Binding grant A and naming an item of grant B finds nothing. The role refused everywhere ADR-035 does not list. Canary in a title, a body and a file: absent from Temporal history, payloads and logs. A malformed grant ID. Replay histories: **capture needs Temporal, so write the capture test and report the histories as owed.** `tests/replay/replay.test.ts` replays what is there by itself.

## api: `EXP-07`, `EXP-08`, `EXP-09`

Every Route Handler for this milestone. Owns the OpenAPI status of each.

**Owns:** new `apps/web/src/app/api/v1/organizations/[organizationId]/federation/**/route.ts` and `tenancy/**/route.ts`, new `apps/web/src/server/federation-dto.ts`, removing `x-ensemus-status: planned` for these paths in `docs/specifications/openapi.yaml`, the M11C block in `tests/unit/openapi-contract.test.ts`, regenerated `packages/contracts/generated/openapi.d.ts`, new `tests/stack/federation-api.test.ts`.

**Routes, as OpenAPI lists them**, each through `apiRoute(organizationParams…, handler)` from `@/server/api`: `GET`/`PUT federation/settings`, `GET`/`POST federation/grants`, `POST federation/invitations/preview`, `POST federation/invitations/acceptance`, `GET federation/grants/{grantId}`, `POST …/confirmation`, `POST …/ending`, `GET`/`POST …/items`, `POST federation/outbound-items/{federationItemId}/withdrawal`, `GET federation/inbound-items`, `GET …/{federationItemId}`, `POST …/disposition`, `GET …/file`, `GET federation/crossings`, `GET tenancy/posture`, `GET`/`PUT tenancy/residency-requirements`. Bodies are parsed with the schemas in `@ensemus/contracts/federation` and `tenancy`.

**Gate:** where `loadTenancyConfig().crossOrgEnabled` is false, every `federation/*` route answers 404 exactly as an unknown path does. `setFederationEnabled` gets `noPlanGate` until M8's checker is wired at the final merge. `tenancy/posture` combines `getDeploymentProfile`, `getIsolationPosture({ releaseVersion })` and `getResidencyPosture` into `TenancyPosture`, with `loadResidencyPolicy()` and no sources until M4 and M5 are wired.

**Rules:** a token only ever in a request body, and never in a log. The created token appears in the one response and nowhere else. A file answers `application/octet-stream` with `content-disposition: attachment` and `x-content-type-options: nosniff`, because it is another company's file and must never render on this origin. DTOs in `federation-dto.ts` are snake_case and match the spec exactly.

**Denied and fault tests:** on `tests/stack`, through `contractProblems` as `tests/stack/api.test.ts` does: signed out, wrong tenant, each role, off at the deployment (404 everywhere), a bad body, a stale version, no token in any logged line. `tests/unit/openapi-contract.test.ts` keeps the routes and the spec honest. Stack tests are unverified.

## collaboration-ui: `EXP-07`

An owner's and an admin's pages. `XORG-TS-01`, `XORG-TS-02` from a person's side.

**Owns:** new `apps/web/src/app/o/[organizationId]/collaboration/**`, new `apps/web/src/server/federation-actions.ts`, new `apps/web/src/components/federation/**`, new `tests/browser/specs/collaboration.spec.ts`.

**Calls:** the services in `@ensemus/application`, `requireTenant`, `can`, `organizationFingerprint`, the components in `@/components/ui`, and the pattern in `apps/web/src/server/work-actions.ts`.

**Pages:** the switch, which offers nothing where the deployment has it off. Propose, showing the token once with a way to copy it and no way to see it again. An invitation page taking a token in a form field, never a URL parameter. The grant page showing the terms, the other side's name with "names are not verified", and the fingerprint to compare by another route, with **confirm** as its own deliberate step that says what will start. Sending, withdrawing and ending, each saying "they may already have read it". Arrivals, marked plainly as from another company, with accept and reject, where accepting says it starts nothing. The crossings list. Nothing here is called a contract or an agreement in law. Add the navigation entry in this slice's own layout, and report if it needs the shared one.

**Denied and fault tests:** in Playwright, written and typechecked, and unverified: a member sees none of it, the deployment off shows nothing, a token never appears in a URL or in history, a revoked arrival disappears on the next request, keyboard and accessibility as `tests/browser/specs/accessibility.spec.ts` does. An inbound file is never rendered in the page.

## tier: `EXP-08`

A dedicated deployment holds one organization. `TIER-TS-01`.

**Owns:** `packages/application/src/tenancy.ts`, `packages/database/src/organizations.ts` (only `createOrganization`'s new optional `organizationId`), `apps/web/src/server/actions.ts` (only `createOrganizationAction`), new `tests/integration/tenancy-profile.test.ts`, new `packages/application/src/tenancy.test.ts` if it has pure parts, new `workers/workflow/src/apply-deployment-profile.test.ts`.

**Implements, with these exact signatures** (stubbed):

```ts
getDeploymentProfile(database, context): Promise<DeploymentProfileView>
getIsolationPosture(database, context, { releaseVersion }): Promise<IsolationPosture>
// and in createOrganization's input
{ userId, name, commercialMode, requestKey?, organizationId?: string }
```

**Calls:** `isolationPosture`, `can(role, 'tenancy.view')`, `withTenantTx`, `applyDeploymentProfile` and `recordIsolationEvidence` from `@ensemus/database/deployment`, `loadTenancyConfig`.

**Rules:** with no row, `getDeploymentProfile` answers shared, no region, off, `profiled: false`, and does not throw. On a dedicated deployment the first owner's organization takes the pinned ID, read from `loadTenancyConfig().pinnedOrganizationId` in `createOrganizationAction` in `apps/web/src/server/actions.ts`, which this slice also owns, for that function only. EN701 maps to `TENANCY_SINGLE_ORGANIZATION`. **Watch one thing:** `createOrganization` has `onConflictDoNothing`, so a second person on a dedicated deployment would find the pinned row already there and be handed a membership ID that does not exist. When `organizationId` is passed and the row exists with no membership for this user, it must refuse with `TENANCY_SINGLE_ORGANIZATION`, and never join them to it.

**Denied and fault tests:** a second organization refused by the database for any caller. A second person passing the pinned ID gets no membership and the refusal. A tenant cannot write the profile or the evidence. `applyDeploymentProfile` refuses to change a pin, and a repeat changes nothing. A member gets `FORBIDDEN` for the posture. Every existing path is unchanged with no profile row. Integration tests are unverified.

## isolation: `EXP-08`

Real probes, recorded. `TIER-TS-02`, `TIER-TS-03`.

**Owns:** `workers/workflow/src/isolation-report.ts`, new `workers/workflow/src/isolation-probes.ts` and `isolation-probes.test.ts`, new `tests/stack/dedicated-isolation.test.ts`.

**Implements:** the job's `main`, and in `isolation-probes.ts`:

```ts
probeDatabase(listOrganizationIds: () => Promise<readonly string[]>, pinned: string): Promise<ProbeResult>
probeUnreachable(endpoints: readonly { host: string; port: number }[], connect: Connect, timeoutMs: number): Promise<ProbeResult>
probeNamespace(own: string, foreign: readonly string[]): ProbeResult
probeBucket(own: string, foreign: readonly string[]): ProbeResult
declared(aspect, declaration: { evidenceRef: string } | undefined): ProbeResult
type ProbeResult = { aspect: IsolationAspect; result: IsolationResult; code: IsolationCode | null }
```

**Calls:** `listOrganizationIds` and `openDispatcherDatabase` from `@ensemus/database/dispatcher`, `recordIsolationEvidence`, `loadTenancyConfig`, `node:net` in the real `connect`, and `isolationPosture` in tests. Reads `ENSEMUS_ISOLATION_FOREIGN_ENDPOINTS`, `ENSEMUS_ISOLATION_FOREIGN_NAMESPACES`, `ENSEMUS_ISOLATION_FOREIGN_BUCKETS` and `ENSEMUS_RELEASE_VERSION`. Hosts and names go only to the probe: the record holds an aspect, a result and a code.

**Rules:** an empty foreign list fails with `NO_FOREIGN_ENDPOINTS_GIVEN`, because it proved nothing. A connection that succeeds fails with `FOREIGN_ENDPOINT_REACHABLE`, and a timeout or refusal passes. A probe that errors records `failed` with `PROBE_FAILED`, never `passed`. `backups`, `embeddings`, `telemetry` and `key_encryption_key` record `declared` from the operator's statement, or `failed` with `NOT_DECLARED`. The job exits non-zero if anything failed.

**Denied and fault tests:** each probe's pass and fail with an injected connect, in unit tests that run. The stack test brings up two named projects and proves neither reaches the other: written and typechecked, unverified, and needing what is listed for this under docker in the [runbook](../05-operations/07-cross-org-tiers-regions-runbook.md).

## residency: `EXP-09`

Requirements, the gate and the posture. `RES-TS-01`, `RES-TS-02`, `RES-TS-03`.

**Owns:** `packages/application/src/residency.ts`, new `tests/integration/residency.test.ts`, new `tests/unit/residency-gate.test.ts`.

**Implements, with these exact signatures** (stubbed):

```ts
listResidencyRequirements(database, context): Promise<readonly ResidencyRequirementView[]>
setResidencyRequirement(database, context, { scope, region, expectedVersion }): Promise<readonly ResidencyRequirementView[]>
createResidencyGate({ database, policy }): ResidencyGate
getResidencyPosture(database, context, { policy, sources }): Promise<ResidencyPosture>
```

**Calls:** `checkResidency`, `residencyPosture`, `withTenantTx`, `appendAudit`, `AUDIT_RESIDENCY_*`, `loadResidencyPolicy`, `ResidencyGate`, `ProcessingLocationSource`.

**Rules:** an owner sets a requirement, using `organization.manage`. A read failure inside the gate is a denial with no requirement guessed. A denial writes one audit row, with a code and no data, de-duplicated like refusals. `ResidencyDecision` is what a caller acts on, and the gate never throws for a denial. A source that throws makes its surface show as seen elsewhere, unknown, and so withholds `allInRegion`.

**Denied and fault tests:** each of the six surfaces, undeclared and elsewhere. A target elsewhere, and one that cannot say. A member refused. A region not offered, and any region with none claimed. Two tenants with different requirements on one deployment, with the gate answering each by its own. The database failing while the gate reads. A connected profile in another region withholding the statement. Integration tests are unverified, and `tests/unit/residency-gate.test.ts` runs.

## posture-ui: `EXP-08`, `EXP-09`

An owner's and an admin's page saying what is known. `TIER-TS-03` and `RES-TS-02` from a person's side.

**Owns:** new `apps/web/src/app/o/[organizationId]/deployment/**`, new `apps/web/src/server/posture-actions.ts`, new `tests/browser/specs/deployment-posture.spec.ts`, new `tests/unit/posture-wording.test.ts`.

**Calls:** `getDeploymentProfile`, `getIsolationPosture`, `getResidencyPosture`, `listResidencyRequirements`, `setResidencyRequirement`, `loadTenancyConfig`, `loadResidencyPolicy`, `requireTenant`, `can`.

**Rules:** the page repeats each line: an aspect and whether it passed on this release, was declared by the operator, is stale or is unchecked. A surface and what was declared, with the operator's reference shown as their words. The summary "isolated" or "all in region" appears only when the domain function says so. Otherwise it says what is missing. **Words never used here: certified, compliant, guaranteed, SLA, or any standard's name**, and `tests/unit/posture-wording.test.ts` fails on them in this folder.

**Denied and fault tests:** a member gets not found. A requirement for a region not offered shows the refusal. With nothing configured, the page says nothing is claimed. Playwright is written and typechecked, and unverified.

## runbook: `EXP-07`, `EXP-08`, `EXP-09`

What an operator does, and what a person is told. Docs only.

**Owns:** new `docs/05-operations/07-cross-org-tiers-regions-runbook.md`, `docs/02-architecture/08-deployment-topologies.md`, `docs/07-commercial/04-deployment-and-support-matrix.md` (a row saying what exists and what is undecided, with no commitment), `docs/02-architecture/02-domain-model.md`, `docs/02-architecture/03-data-model.md`, `docs/04-security/03-threat-model.md`.

**Covers, in order:** turning cross-org on, as creating the role as a superuser, running migrate, setting `ENSEMUS_CROSS_ORG_ENABLED`, applying the profile and starting the worker. Turning it off, and what that does at once: every grant closes on commit, and copies stay unreadable, and stay stored, until the worker runs to purge them, so it keeps running until the backlog is gone. Standing up a dedicated deployment, including pinning and running `isolation-report`. Writing a residency statement, with the file's shape, and that a reference is not evidence this product checked. What a revocation can and cannot promise. Under a heading for docker, exactly what is in ["What compose and images need"](#what-compose-and-images-need) below. **Nothing here names a real region, price, service level or standard, and nothing here is legal wording.** Marked as unverified until the stack has run it.

**Denied and fault tests:** none: it has no code. `node docs/specifications/tools/check-backlog.mjs` still passes. Do not regenerate `docs/MANIFEST.json`, which the final merge does once.

## flow: `EXP-07`, `EXP-08`, `EXP-09` (second wave)

Runs only after the slices above are merged, because it wires them into paths that would break against a stub.

**Owns:** `packages/workflows/src/activities.ts` (a call to `expireDueGrants` beside `purgeExpiredWebhookDeliveries` in tenant upkeep), `packages/application/src/artifacts.ts` and `work.ts` (a call to `withdrawItemsForSourceInTx` on their tombstone paths), `apps/web/src/server/runtime.ts` (`loadTenancyConfig`), new `tests/stack/federation-flow.test.ts`, new `tests/browser/specs/federation-flow.spec.ts`, new `tests/unit/federation-wiring.test.ts`. Also lists, in its report, each sibling call site for the final merge to make, in [the merge list](#the-final-merge).

**Proves:** the whole thing through web and worker, as two companies with the same name: propose, accept, confirm, send a summary and a file, read it, reply, revoke, see it gone, see the ledger. `XORG-TS-07` with a canary through Temporal. All stack and browser tests are written and typechecked, and unverified.

**Denied and fault tests:** the worker stopped: the item waits and nothing crosses. The worker stopped at revocation: unreadable anyway, purged when it returns. A deleted source withdrawn in the same transaction. A grant past its date closed before upkeep, and purged after it.

## What compose and images need

Nobody edits these in this milestone. They are written up here, and done when the owner decides to run containers. Until then, `tests/stack/federation-*`, `tests/stack/dedicated-isolation.test.ts` and the browser specs cannot run.

| Where | What |
|---|---|
| `compose.yaml` | A `federation-worker` service under a `federation` profile, from the worker image, running `node dist/federation-worker.js`, on an internal network holding PostgreSQL, Temporal and the object store, with no route out. Secrets: `DATABASE_URL_FEDERATION`, `DATABASE_URL_APP`, the object store's keys and `TEMPORAL_CODEC_KEY`. It gets no connector or sealing secret. Env: `ENSEMUS_CROSS_ORG_ENABLED=true` |
| Provisioning | Leave `provision.sql` as it is, so nothing exists by default. Under the profile, one superuser step: `CREATE ROLE ensemus_federation LOGIN PASSWORD ... NOSUPERUSER NOCREATEROLE NOBYPASSRLS`, then the migrate job, which applies its grants. Grants fail if the role is stronger than that |
| `generate-test-secrets.mjs` and mounts | `db_federation_password` and `db_federation_url`, for that profile only |
| The `migrate` job | Runs `node dist/apply-deployment-profile.js` after `dist/migrate.js`, with `ENSEMUS_TENANCY_TIER`, `ENSEMUS_DEDICATED_ORGANIZATION_ID`, `ENSEMUS_HOME_REGION` and `ENSEMUS_CROSS_ORG_ENABLED`, and the migrator's URL |
| The `web` and worker services | `ENSEMUS_CROSS_ORG_ENABLED`, `ENSEMUS_TENANCY_TIER`, `ENSEMUS_HOME_REGION`, and `ENSEMUS_RESIDENCY_POLICY_FILE` with that file mounted read-only |
| A new `compose.dedicated.yaml` | Two stacks under two project names, sharing nothing, for `TIER-TS-02`. An `isolation-report` one-shot, `node dist/isolation-report.js`, with `DATABASE_URL_DISPATCHER`, `DATABASE_URL_MIGRATOR`, `ENSEMUS_RELEASE_VERSION` and `ENSEMUS_ISOLATION_FOREIGN_ENDPOINTS`, `_NAMESPACES` and `_BUCKETS` |
| The air-gap gate | Run it once with the `federation` profile on, because the new worker must make no outbound attempt |
| The upgrade gate | Must pass from a release with no `ensemus_federation` role. `apply_bridge_grants` is built to do nothing then, and that has not been run |
| Images | `Dockerfile.worker` copies `dist`, and `scripts/build.mjs` now names the three new entry points. No Dockerfile change is expected. Confirm it |

## The final merge

Not a slice. These join this milestone to its siblings, whose foundations were read with `git show`, and they have not been made.

| Where | What |
|---|---|
| Journal | Stitch `0700`-`0703`, in that order, after the siblings' files. `0700` needs `org.*` and `0703` needs `work.work_units`, `app.reject_change` and `0700` |
| `eslint.config.mjs`, `packages/application/src/errors.ts`, `policy.ts`, `index.ts`, dispatcher, `build.mjs`, `tests/unit/openapi-contract.test.ts` | Several milestones add to these. Keep all additions |
| M4 `Entitlements`, M8 `createEntitlementChecker` | Implement `CrossOrgEntitlement` for feature `FEATURE_CROSS_ORG` where billing is on |
| M4 model gateway | Call `ResidencyGate.check(context, { surface: 'inference', classification, targetRegion: profile.region })` before routing. A denial needs a reason code in M4's `AiReasonCode`, and a row in its egress log |
| M4 `listModelProfiles` | Implement `ProcessingLocationSource` for `inference` |
| M5 embedder, `KnowledgeModelPort` | The same for `embeddings`, using the proposal's `region` |
| M8 `OffboardingPorts.windDowns` | Add `federationWindDown` |
| M8 support and break-glass | Call the gate with `surface: 'support'` |
| M8 `setTenantStandingInTx` | Decide what `suspended` means for a grant. The safe default is to call `endAllGrantsInTx` on `offboarding`, and for `suspended` to stop new sends in `publishItem` |
| M6 `CORE_PORTABILITY_SECTIONS` | Leave inbound items out, as they are. A restore has to be read against ADR-026 for `federation.*` |
| M5 retrieval | Must not index `federation.inbound_items`. Nothing does today |
| Any new role that inserts into `org.organizations` | Needs `USAGE` on schema `tenancy` and `SELECT` on `deployment_profile`, or the trigger refuses it with a permission error, which is the safe way round |

## Owner-led, with no slice

Only a person can finish these. No code stands in for them, and none is drafted here.

- A contract between two collaborating organizations, and the data roles under it.
- Which dedicated tiers are sold, their price, service levels and any RTO or RPO.
- Whether any region is offered, the provider contracts behind it, and the subprocessor list that follows.
- Outside security review of migration `0703`, the bridge role and the isolation probes.
