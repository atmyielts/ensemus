# M11A slices

Thirteen builders work in parallel from the foundation commit, and a fourteenth, `stack`, starts once they are merged, because it proves what they built together. **No file has two owners.** Everything they must agree on is already decided in [ADR-033](../00-foundation/adr/ADR-033-expansion-packs-connectors-meetings.md) and already typed in the code. Read that ADR first, because it holds the reasons. Read [ADR-027](../00-foundation/adr/ADR-027-verified-external-actions.md) too if you touch a connector or an effect.

If you need a change to a file you do not own, or to anything in "Fixed" below, stop and report it. Do not work around it, and do not edit the file.

## Fixed: nobody changes these

| What | Where |
|---|---|
| Migrations, RLS, roles and triggers. **No builder adds a migration.** `meta/` and the journal are not edited on this milestone at all: the final merge stitches them | `packages/database/migrations/0600_*`, `0601_*`, `packages/database/src/schema-expansion.ts`, `drizzle.config.ts` |
| Rules and names | `packages/domain/src/business-connector.ts`, `meeting.ts`, `department-pack.ts`, `expansion-events.ts` |
| Shapes on the wire and in an approval | `packages/contracts/src/business-adapter.ts`, `business-records.ts`, `meetings.ts` |
| The adapter kit, and its fake | `packages/connectors/src/business/**`, `manifest-business.ts`, `testing/business-adapter.ts` |
| Ports | `packages/application/src/expansion-ports.ts` |
| Temporal input shapes and workflow IDs | the M11A section of `packages/workflows/src/schemas.ts` |
| Dispatcher and worker wiring | `workers/workflow/src/dispatcher.ts`, `main.ts`, `connector-worker.ts`, `business-connectors.ts`, `packages/workflows/src/workflows.ts`, `activities.ts`, `packages/application/src/index.ts`, `errors.ts`, `apps/web/src/lib/messages.ts` |
| Import rules | `eslint.config.mjs` |
| Dependencies. **`pnpm-lock.yaml` is frozen, and no builder adds a package.** Every export and workspace link is in place | every `package.json` |
| Shared tests and helpers | `tests/helpers/expansion.ts`, `tests/integration/expansion-schema.test.ts`, `tests/unit/expansion-rules.test.ts`, `packages/domain/src/department-pack.test.ts`, `packages/connectors/src/business/kit.test.ts` |
| Decisions | ADR-033, this file |

A bug in any of these is reported, not fixed in passing.

**One exception, in the spec.** `docs/specifications/openapi.yaml`, `packages/contracts/generated/**` and `tests/unit/openapi-contract.test.ts` are shared by the two slices that build routes, `business-records` and `meetings-web`, because each flips its own operations. Each touches only its own lines, and they merge cleanly because the operations are far apart. Flipping `x-ensemus-status` does not change `openapi.d.ts`, so regenerate only if a shape changed, and say so if one did.

## What runs where

**Code only.** The owner's PC is low on disk.

| Rule | Detail |
|---|---|
| Never | `docker` or `docker compose` in any form, `pnpm test:integration`, `test:stack`, `test:browser`, `test:upgrade`, any gate needing a container, a dev server, a watch mode. Do not edit Dockerfiles or compose files: report what they will need |
| Allowed | `pnpm exec prettier`, `eslint`, typecheck, `pnpm --filter @ensemus/web exec next typegen`, `vitest run --project unit <your paths>`, `pnpm test:replay`. Check only what you changed |
| Every heavy command | Through the slot wrapper with a 600000 ms timeout. Exit 75 means no slot yet, so run it again: `node "C:\Users\MUHAMM~1\AppData\Local\Temp\claude\9cec8f68dad5aa23\ee0a16d3-9f5a-455f-8aa4-cabdb46f784b\scratchpad\heavy.mjs" <command>` |
| Still write | Integration, stack and browser tests for what you build, and make them typecheck. They count as **unverified**. Say so, and never report them as passing |
| Disk | Below 3 GB free on C:, stop and report |
| Time | The owner stops at 22:00 local. Past 21:15 and not done, commit what typechecks and list the rest as not done |

**Migrations are not in the journal until the final merge**, so nothing against the new tables can run here. Put every rule you can in a pure module with a unit test, and put the rest in an integration test.

## How M3 reaches you

M3 is merged by the final merge, and this foundation stands on M3's foundation only, so these are still stubs on your branch: `runSend`, `runSyncPass`, `describeConnectorConformance`, `proposeExternalActionInTx` and the rest of the slices in `m3-slices.md`. To read the real ones, use `git show m3-verified-actions:<path>`. **Do not merge it.**

- **A connector's unit test** goes through `createBusinessConnector` and the fake adapter directly, which do not depend on M3's stubs.
- **`describeConnectorConformance`** throws on this branch. Register it the way `connector-crm`'s brief shows: inside a `try`, and if it throws `NOT_IMPLEMENTED`, register `it.todo('M3 conformance, once m3-sdk is merged')`. At the merge the real suite runs by itself. Say in your report that it did not run.
- **Anything needing `proposeExternalActionInTx`-style behaviour** is `proposeBusinessActionInTx`, its twin. `git show m3-verified-actions:packages/application/src/external-actions.ts` is the one to follow, line for line.

## Every slice

- Denied and cross-tenant tests first, then the code. Two tenants, same names, real roles.
- Only IDs, enums and counters cross Temporal. New workflows only import `@temporalio/workflow`, the queue names and types. A workflow's decisions live in a small pure module, as `review-wait.ts` does, so a unit test can reach them.
- A new workflow's histories join `tests/replay/histories/`, and a `tests/replay/<area>-corpus.test.ts` you own lists them. Capturing histories needs Temporal, which is a container, so **write the capture test, leave it uncaptured, and report the histories as owed**.
- Generated test values only: `@example.invalid` addresses, random secrets. No real address, credential, vendor or provider. Fakes live with tests.
- Log codes, never text from a provider, a model, a note or a field. Stored reasons come from `MEETING_STOP_CODES` or `EXTERNAL_ACTION_CODES`.
- No legal terms, prices, SLAs, retention periods or certifications. A notice and a provider's terms are references to documents someone else owns. No claim of compliance.
- Every method here refuses a service context if a person has to be behind it, and refuses a person's context if it is for the worker. Check `context.actorType`.
- Follow the house comment style: say why, in plain sentences. No "Owned by" line stays once the slice is done.

## Merge order

Nothing depends on order for compiling, since every signature exists. For tests to pass end to end, after M3, M4, M5 and M7: `business-records`, the connectors, `meetings-core`, `meetings-proposals`, `meetings-derivation`, `meetings-connector`, `meetings-web`, the packs, then `stack`.

### What the final merge has to do by hand

These cannot be done on this branch, because the lines they touch arrive with M3 or a sibling:

1. Add `0600` and `0601` to `migrations/meta/_journal.json`, in order after every other milestone's, and regenerate the `0600` snapshot.
2. In `packages/connectors/src/manifest.ts`, add `...BUSINESS_CONNECTOR_MANIFESTS` to `CONNECTOR_MANIFESTS`.
3. In `@ensemus/domain/connector`, add the four types to `SHIPPED_CONNECTOR_RULES`, each with `credential: { required: true }`. Their settings hold an array, which `ConfigField` cannot state, so leave `configFields` out, and `isSafeConnectorConfig` still applies. The connector's own schema checks the rest in the worker.
4. In `packages/domain/src/external-action.ts`, add `...BUSINESS_CONNECTOR_TYPES` to `ACTION_CONNECTOR_TYPES`, so that work can ask for a receipt from one of these.
5. In `workers/workflow/src/main.ts`, replace `noMeetingModel` and `denyAllMeetingEgress` with M4's real gateway and gate, once they exist, and implement `DepartmentPackFormat` over M7's installer.
6. Fold `proposeBusinessActionInTx` into `proposeExternalActionInTx` behind a tool registry, and give `createWorkUnit` an `InTx` form that `acceptProposedWork` calls (ADR-033 D3 and D7). Neither is urgent, and both should happen before these drift.
7. In `apps/web`, offer the manifests in `@ensemus/connectors/manifest-business` on the connections page.

## Slices

### pack-marketing: `EXP-01`

Marketing operations: campaign planning and artifact review. Guardrail: claims and sources are reviewed by a person.

**Owns:** `packages/department-packs/src/marketing/**`.

**Implements:** `export const MARKETING_OPERATIONS_PACK: DepartmentPack`, replacing the null. Its `id` is `marketing_operations`, its `department` is `marketing`, and its version is 1.

**Must contain:** a `campaign` and a `claim_source` object with views; a `campaign-planner` and a `claims-checker` agent, each valid against `docs/specifications/schemas/agent-definition.schema.json`, that draft and read and hold no effect; a `source-verification` skill; a `campaign_review` workflow where the claims check and a person's approval both come before any send; full `en` strings; requests for each capability and class it touches, with reasons.

**Tests, new `packages/department-packs/src/marketing/marketing.test.ts`:** `describePackConformance(MARKETING_OPERATIONS_PACK, { forbiddenTools: [...], next })`, with `next` a version 2 of it that adds a field, so the upgrade and rollback rules run on something real. Denied: a workflow reordered so the send comes before the claims check fails conformance. A claim with no source is a `denied` evaluation scenario. It asks for no bulk outreach tool, and a test says so.

**QA:** pack review and rollback, with nothing granted on install.

### pack-hr: `EXP-01`

HR operations: onboarding and internal workflows. Guardrail: strict employment data isolation.

**Owns:** `packages/department-packs/src/hr/**`.

**Implements:** `export const HR_OPERATIONS_PACK: DepartmentPack`, replacing the null. Its `id` is `hr_operations`, its `department` is `hr`.

**Must contain:** an `employee_onboarding` and a `policy_acknowledgement` object, with employment data classified `restricted` and its access request carrying `isolation: 'named_people_only'`; an `onboarding-coordinator` agent that sees checklist items and no employment records; a `new_employee_onboarding` workflow following the catalog's fourth bundled workflow, with access requests going through a person; full `en` strings.

**Tests, `packages/department-packs/src/hr/hr.test.ts`:** `describePackConformance` with `next`. Denied: any change that drops `named_people_only` fails conformance. The agent's `allowed_scopes` hold no employment scope, and its deny list holds `email.send`. A `denied` scenario proves an organization admin who is not named gets nothing from installing. No scoring of people, and a test searches the strings for "score", "rating" and "performance".

**QA:** employment data isolation, pack review and rollback.

### pack-finance: `EXP-01`

Finance operations: reporting and approval preparation. Guardrail: never autonomous transfers.

**Owns:** `packages/department-packs/src/finance/**`.

**Implements:** `export const FINANCE_OPERATIONS_PACK: DepartmentPack`, replacing the null. Its `id` is `finance_operations`, its `department` is `finance`.

**Must contain:** a `close_checklist` and an `invoice_handoff` object; a `reporting-assistant` agent that reads `accounting.invoices`, `accounting.bills` and `accounting.payments` and drafts, and denies every effect; a `project_to_invoice_draft` workflow following the catalog's third bundled workflow, ending in `accounting.invoice_draft.create` behind a person's approval, through `accounting_http`; full `en` strings. Financial data is at least `confidential`.

**Tests, `packages/department-packs/src/finance/finance.test.ts`:** `describePackConformance` with `next`, with `forbiddenTools` holding every money-moving name. Denied: adding `accounting.payment.create` or `bank.transfer` to its tools fails conformance, adding them to a workflow step fails, and removing the approval before the draft fails. The only side effect in the pack is the draft. A `denied` scenario proves it. It works with no accounting connection, with that step unavailable.

**QA:** no autonomous transfers, pack review and rollback.

### pack-learning: `EXP-01`

Learning and knowledge programs: internal skill and policy enablement. Guardrail: consent and privacy.

**Owns:** `packages/department-packs/src/learning/**`.

**Implements:** `export const LEARNING_PROGRAMS_PACK: DepartmentPack`, replacing the null. Its `id` is `learning_programs`, its `department` is `learning`.

**Must contain:** a `learning_program` and an `enrollment` object; a `program-assistant` agent that drafts material from approved knowledge; an `enablement_program` workflow where taking part is opt-in, with a step for a person agreeing before anything about them is kept; full `en` strings.

**Tests, `packages/department-packs/src/learning/learning.test.ts`:** `describePackConformance` with `next`. An `enrollment`'s access request is scoped to the person, and no view lists one person's progress for their manager. A `denied` scenario proves it. The agent's deny list holds `email.send`. No scoring of people, and a test searches the strings for it, as `pack-hr` does.

**QA:** consent and privacy, pack review and rollback.

### connector-crm: `EXP-02`

**Owns:** `packages/connectors/src/crm/**`, new `tests/integration/crm-connector.test.ts`.

**Implements:**

```ts
// @ensemus/connectors/crm
createCrmConnector(options: BusinessConnectorOptions): Connector<BusinessConnectorConfig>
```

A spec for `createBusinessConnector`, with `CRM_CONNECTOR_MANIFEST` and one tool, `CRM_RECORD_UPDATE_TOOL` version `BUSINESS_TOOL_VERSION`. Its `parsePayload` runs `recordUpdatePayloadSchema`, then requires `connectorTypeOfStream(record.stream) === CRM_CONNECTOR_TYPE` and `checkRecordChange(record.stream, changes).ok`, and throws otherwise.

**Conformance, in `packages/connectors/src/crm/conformance.test.ts`:**

```ts
const adapter = createFakeAdapter({ streams: {...} });
const make = () =>
  routeConnector(createCrmConnector({ tls: 'none', sink: { applyPage: async () => undefined } }), adapter.network);
try {
  describeConnectorConformance('crm_http', make, { config, payload });
} catch (error) {
  if ((error as Error).message !== 'NOT_IMPLEMENTED') throw error;
  it.todo('M3 conformance, once m3-sdk is merged');
}
```

Binding it to the fake is what lets the suite's sync checks read pages, since the suite gives no relay of its own.

**Tests, `packages/connectors/src/crm/crm.test.ts`, on the fake adapter, with no socket:**

- Each of the three streams: listed fields only, grants through, classification floor.
- A connection with no selected streams makes no contact.
- Only writable fields go out: `amount`, `name` and an unknown field are refused before any contact, with `PAYLOAD_CHANGED`.
- A stream of another connector, in the payload, is refused the same way.
- Without `crm_http.write`: no contact.
- `expected_version` reaches the adapter, and a 409 from it is `rejected`.
- **Faults:** `silent_after_effect`, `drop_after_effect`, a 500, unreadable 2xx: `indeterminate`, one effect, then `reconcile` finds it. `silent_without_effect`: `indeterminate`, then `not_found`, which `best_effort` does not believe. `refuse_connection`: `not_sent`, retryable. Nothing a provider said appears in any result or error.
- Sending the same key twice applies one effect at the fake, as the protocol requires.

**Integration, written and not run, `tests/integration/crm-connector.test.ts`:** TLS over a real socket with a generated certificate, as `git show m3-verified-actions:tests/integration/email-connector.test.ts` does, including a wrong name and an untrusted certificate refused before any credential is lent. The sink backed by `applyBusinessRecordPage`, for two tenants with the same external ID.

**QA:** connector lifecycle and reconciliation; `QA-008`, `AI-TS-01` for this tool.

### connector-ticketing: `EXP-02`

**Owns:** `packages/connectors/src/ticketing/**`, new `tests/integration/ticketing-connector.test.ts`.

**Implements:** `createTicketingConnector(options: BusinessConnectorOptions): Connector<BusinessConnectorConfig>`. A spec with `TICKETING_CONNECTOR_MANIFEST` and two tools: `TICKETING_RECORD_UPDATE_TOOL`, parsed as `connector-crm` parses its own, and `TICKETING_COMMENT_ADD_TOOL`, parsed with `ticketCommentAddPayloadSchema`.

**Conformance:** as in `connector-crm`, in `packages/connectors/src/ticketing/conformance.test.ts`.

**Tests, `packages/connectors/src/ticketing/ticketing.test.ts`:** everything `connector-crm` lists, for both streams and both tools, and:

- `visibility: 'public'` is refused before contact. There is no customer-facing form, and a test says so.
- A comment body is in the hash, and a changed body is a different request.
- `ticketing.comments` is read only, and has no writable field.
- A comment repeated with one key is one comment at the fake.
- A comment's `posted_at` that is not a date refuses the page.

**Integration, written and not run:** as in `connector-crm`.

**QA:** connector lifecycle and reconciliation.

### connector-accounting: `EXP-02`

**Owns:** `packages/connectors/src/accounting/**`, new `tests/integration/accounting-connector.test.ts`.

**Implements:** `createAccountingConnector(options: BusinessConnectorOptions): Connector<BusinessConnectorConfig>`. A spec with `ACCOUNTING_CONNECTOR_MANIFEST` and two tools: `ACCOUNTING_RECORD_UPDATE_TOOL`, parsed as `connector-crm` parses its own, and `ACCOUNTING_INVOICE_DRAFT_TOOL`, parsed with `invoiceDraftCreatePayloadSchema`.

**Conformance:** as in `connector-crm`, in `packages/connectors/src/accounting/conformance.test.ts`.

**Tests, `packages/connectors/src/accounting/accounting.test.ts`:** everything `connector-crm` lists, for all three streams and both tools, and:

- Every record is at least `confidential`, whatever the source says.
- `total`, `amount`, `currency`, `status` and every field of `accounting.payments` are refused as a change.
- A draft with `status`, `pay_now`, or a bank field is refused before contact.
- A float for money refuses the page, and a string stays exactly as it was: `'100.10'` is not `100.1`.
- The tool list is exactly these two, and no name matches a payment, a transfer or a posting.

**Integration, written and not run:** as in `connector-crm`.

**QA:** connector lifecycle and reconciliation; no autonomous transfers.

### business-records: `EXP-02`

Storing what connectors read, reading it through the source's permissions, and proposing effects on it. API and UI.

**Owns:**

- `packages/application/src/business-records.ts`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/business-records/**`, `invoice-drafts/**`, `business-actions/**`
- new `apps/web/src/server/business-record-actions.ts`, `apps/web/src/app/o/[organizationId]/records/**`, `apps/web/src/components/record-*.tsx`
- its own operations in `docs/specifications/openapi.yaml`, `packages/contracts/generated/**`, and its own lines in `tests/unit/openapi-contract.test.ts`
- new `tests/integration/business-records.test.ts`, `tests/stack/business-records-api.test.ts`, `tests/browser/specs/business-records.spec.ts`
- new `packages/application/src/business-records.test.ts` for what needs no database

**Implements, all stubbed already:**

```ts
applyBusinessRecordPage(database, context, page: BusinessRecordPage): Promise<void>
listBusinessRecords(database, context, { connectionId?, stream?, after?, limit? }): Promise<BusinessRecordList>
getBusinessRecord(database, context, recordId): Promise<BusinessRecordView>
proposeBusinessActionInTx(tx, context, { workUnitId, connectionId, toolName, toolVersion, payload, approverMembershipId, expiresAt?, supersedesId?, retryOfId?, businessRecordId? }): Promise<ProposedBusinessAction>
proposeRecordUpdate(database, context, { recordId, workUnitId, expectedVersion, changes, approverMembershipId }): Promise<ProposedBusinessAction>
proposeTicketComment(database, context, { recordId, workUnitId, body, approverMembershipId }): Promise<ProposedBusinessAction>
proposeInvoiceDraft(database, context, { workUnitId, connectionId, invoice, approverMembershipId }): Promise<ProposedBusinessAction>
reviseBusinessAction(database, context, { externalActionId, expectedVersion, payload, approverMembershipId }): Promise<ProposedBusinessAction>
retryBusinessAction(database, context, { externalActionId, approverMembershipId }): Promise<ProposedBusinessAction>
purgeRevokedBusinessRecords(database, context): Promise<number>
```

**Calls:** `createApprovalInTx`, `loadChangeable`, `emit`, `auditAction`, `recordApprovalClosed`, `proposedActionFor`, `idempotencyKeyFor`, `connectionRef`, `apiRoute`. `BUSINESS_RECORD_ACTION_PROPOSED` with `AGGREGATE_BUSINESS_RECORD`, carrying IDs only.

**Things to get right:**

- Reading is a join: `business_records` to `external_resources` on the source key, to `external_resource_acl` on this person's membership or a team they are on, to `connections` with `state = 'active'`. Anything else is not found, and an admin gets no way in. `canReadBusinessRecord` is the rule, so feed it the facts rather than rewriting it in SQL. Pagination is keyset, on `updated_at` and `id`.
- `applyBusinessRecordPage` requires a service context, a connection of `connectorType`, and `selectRecordFields` passing again on every record. Applying the same page twice leaves every row and `updated_at` alone. `deletedExternalIds` clears `fields` to `{}` and sets `deleted_at`. Fields are never logged.
- `proposeBusinessActionInTx` follows `git show m3-verified-actions:packages/application/src/external-actions.ts`, `proposeExternalActionInTx`, with these differences: `isToolOf(connection.connectorType, toolName)`, `hasWriteScope(type, connection.grantedScopes)` or `CONNECTION_SCOPE_MISSING`, and the tool's parser. Restricted work is `RESTRICTED_NOT_ALLOWED`. The approver is never the proposer.
- `proposeRecordUpdate` builds the payload from the stored record, never from the request: `{ record: { stream, external_id, expected_version }, changes }`. `expectedVersion` differing from what is stored is `RECORD_VERSION_STALE`. A record the person cannot read is not found, and that includes one they hold a Work Unit for.
- `reviseBusinessAction` follows M3's `reviseExternalAction`: refused once any attempt exists, the old intent ends `SUPERSEDED`, and its approval is cancelled even if approved. `retryBusinessAction` follows M3's `retryExternalAction`, for a `failed` one, with `retry_of_id`.
- A person's `granted_scopes` come from the connection's row, and the connector checks its config's scopes again before sending.
- Every route goes through `apiRoute`. Flip `x-ensemus-status: planned` off and remove the line from `tests/unit/openapi-contract.test.ts` as each one lands, and regenerate with `pnpm --filter @ensemus/contracts generate`.

**The UI,** following what exists (`components/ui.tsx`, `globals.css`): `records/page.tsx` lists what this person can read, by connection and stream, with empty, error and denied states. `records/[recordId]/page.tsx` shows its fields, marked as last read from the source with the time, with a form proposing a change, which offers only writable fields, and the record's actions with their receipts. **An accounting record has no field a person can use to pay anything,** and the page says that a draft is only a draft. The approver's page shows exactly what will change, from what, on which record. Forms work without JavaScript.

**Tests:** two tenants with the same external ID: separate rows. A member with no grant, an admin with no grant, a grant from a team, a grant removed by the next sync, a resource row not there yet, a revoked connection, a deleted record. Proposing with a stale version, a read-only field, a read-only connection, restricted work, another tenant's work or connection, and naming yourself as approver. **Faults, against M3's tables, through `seedExternalAction`-style walks:** a changed payload after approval is void (`QA-007`). A service context cannot call a person's method, and the reverse. Written and not run: the stack API test through the OpenAPI validator, and the browser spec with axe.

**QA:** `QA-001`, `QA-002`, `QA-007` for these tools; source ACL mapping; connector lifecycle.

### meetings-core: `EXP-03`

Settings, meetings, who was there, consent, provider approvals, imported notes and the purge. Consent and provider approval are enforced, and this is where.

**Owns:**

- `packages/application/src/meetings.ts`, and new `packages/application/src/meetings.test.ts` for what needs no database
- `packages/application/src/tombstone-ledger.ts`, for the `meeting` target
- new `tests/integration/meetings.test.ts`, `tests/integration/meeting-consent.test.ts`, and additions to `tests/stack/restore.test.ts` for a purged meeting after a restore

**Implements, all stubbed already:**

```ts
getMeetingSettings(database, context): Promise<MeetingSettingsView>
updateMeetingSettings(database, context, { expectedVersion, enabled, noticeRef }): Promise<MeetingSettingsView>
createMeeting(database, context, { title, occurredAt, classification? }): Promise<MeetingDetailView>
createMeetingFromResource(database, context, { resourceId, title, occurredAt, classification? }): Promise<MeetingDetailView>
listMeetings(database, context, { after?, limit? }): Promise<{ items; nextCursor }>
getMeeting(database, context, meetingId): Promise<MeetingDetailView>
addMeetingParticipant(database, context, { meetingId, expectedVersion, participant }): Promise<MeetingParticipantView>
removeMeetingParticipant(database, context, { meetingId, participantId, expectedVersion }): Promise<void>
recordMeetingConsent(database, context, { meetingId, participantId, decision, noticeRef }): Promise<{ consent; status }>
importMeetingNotes(database, context, { meetingId, text }): Promise<{ notesId; version }>
approveMeetingProvider(database, context, input): Promise<ProviderApprovalView>
revokeMeetingProvider(database, context, { providerApprovalId }): Promise<void>
listMeetingProviderApprovals(database, context): Promise<readonly ProviderApprovalView[]>
reassignMeetingOrganizer(database, context, { meetingId, expectedVersion, organizerMembershipId }): Promise<void>
purgeMeetingContentInTx(tx, context, { meetingId, reasonCode }): Promise<void>
```

**Calls:** the pure rules in `@ensemus/domain/meeting` (`consentStateOf`, `consentBasisFor`, `canReadMeetingContent`, `canSeeMeeting`, `canManageMeeting`, `canAdministerMeetings`, `canReassignOrganizer`); `emit`, `auditAction`, `notify`, the events in `@ensemus/domain/expansion-events`; `TOMBSTONE_RECORDED` as `artifacts.ts` emits it, with `targetType: 'meeting'`.

**Things to get right:**

- `pgCode` on `EN110`, `EN111` and `EN112`, mapped to `AppError`, so a trigger's refusal reads as the right thing. A person is told the rule first by the service, and the trigger is what holds if the service is wrong.
- `createMeeting` lists the organizer in the same transaction. `MEETINGS_NOT_ENABLED` when off. Default class `confidential`.
- `getMeeting` for an owner or admin who is not in it: `title: null`, `currentNotes: null`, `participants` empty. Anyone else who cannot see it: not found. **A test asserts that the JSON of an admin's view has no canary title or note.**
- `recordMeetingConsent`: `consentBasisFor` null is `CONSENT_NOT_YOURS`. `withdrawn` runs `purgeMeetingContentInTx` in the same transaction, and the deferred trigger refuses the commit otherwise. A service context is refused.
- `purgeMeetingContentInTx`, under the meeting's lock, in this order: open runs to `refused` with `CONSENT_WITHDRAWN`; open items to `withdrawn` with text null; decided items' text and reason null; notes and summaries' text null; the meeting to `purged`; the tombstone; `TOMBSTONE_RECORDED`; `MEETING_CONTENT_PURGED`; `NOTIFY_MEETING_CONTENT_PURGED` to the people listed. A Work Unit someone made stays.
- `tombstone-ledger.ts`: re-applying a `meeting` entry after a restore runs the purge again, idempotently, and a test proves that a meeting restored from before its withdrawal has no text afterwards. `countMissing` already works by target type: check it does for this one.
- `updateMeetingSettings`: only `canAdministerMeetings`. Turning on needs a `noticeRef`. Changing the notice does not undo what was already recorded, and new answers need the new one.
- Provider approvals: only `canAdministerMeetings`, a `source` approval's connection has to be `meeting_notes_http`, and an expiry in the future. Listing is for those people too, since a member has no use for it.
- No legal text anywhere. The notice is a reference. The page's words about it are in `meetings-web`.

**Denied tests:** another tenant's meeting, participant, approval and notes: not found. A member who is not in it. An admin reading content. An organizer recording a member's consent. A member attesting for someone outside. A stale notice. Notes before consent. Notes after one no. A participant added after notes. A provider approval by a member, or for another tenant's connection, or for restricted. Withdrawal by someone else. A service context on every person's method.

**Fault tests:** a withdrawal that throws halfway through commits nothing, and the text is still there. Two withdrawals at once. Withdrawal while a run is `running`, tested with `seedDerivationRun`: the run ends `refused`, and nothing it later tries to store sticks.

**QA:** consent enforced; `QA-001`, `QA-002`; deletion and restore.

### meetings-proposals: `EXP-03`

The only path from a proposal to anything. Derived work is proposed, never applied.

**Owns:**

- `packages/application/src/meeting-proposals.ts`, and new `packages/application/src/meeting-proposals.test.ts` for what needs no database
- new `tests/integration/meeting-proposals.test.ts`

**Implements, all stubbed already:**

```ts
listProposedItems(database, context, meetingId): Promise<readonly ProposedItemView[]>
listMeetingSummaries(database, context, meetingId): Promise<readonly MeetingSummaryTextView[]>
acceptProposedWork(database, context, { itemId, expectedVersion, title, objective?, ownerMembershipId, dueAt }): Promise<{ workUnitId; version }>
acceptProposedDecision(database, context, { itemId, expectedVersion, reason? }): Promise<{ version }>
rejectProposedItem(database, context, { itemId, expectedVersion, reason? }): Promise<{ version }>
```

**Calls:** `canDecideProposedItem`, `assertActiveMember`, `emit`, `auditAction`, `notify`, `appendAudit`. Seeds from `tests/helpers/expansion.ts`.

**Things to get right:**

- `acceptProposedWork` writes the Work Unit itself, in the same transaction as the item's status (ADR-033 D7). **Copy the rows `createWorkUnit` writes, in `packages/application/src/work.ts`: the work unit, the assignment, `work.created`, and the audit entry. Do not edit `work.ts`.** The classification is the meeting's, with no way to send another. `can(role, 'work.create')` first. Lock order: meeting, then item. A test holds what this writes equal to what `createWorkUnit` writes, field by field, so the two cannot drift unseen.
- Everything on the Work Unit comes from the request. A model's suggested owner and date are shown on the form and are never read here.
- `acceptProposedDecision` is for `decision` items, and `acceptProposedWork` for `work` items. Each refuses the other with `INVALID_INPUT`.
- A stale `expectedVersion` is `VERSION_CONFLICT`. Anything but `proposed` is `PROPOSAL_ALREADY_DECIDED`. A purged meeting is `MEETING_PURGED`.
- Every method here refuses a service context. **That is the rule, and a test proves that a service context cannot accept, whatever it holds.**
- Reading is for `canReadMeetingContent`. A summary's `trust` is always `model_generated`.
- `EN113` from the trigger maps to `AppError`.

**Denied tests:** another tenant's item. A member who was not there. An owner or admin who was not there. A service context on each method. Two people accepting at once: one Work Unit, and the other hears `PROPOSAL_ALREADY_DECIDED`. Accepting a withdrawn item, and an item after its meeting is purged. An owner in another tenant, for `ownerMembershipId`.

**Fault tests:** a failure after the Work Unit's insert commits neither. **No Work Unit, event or notification exists for an item until a person accepts it: count them before and after a whole run.** A Work Unit made from a proposal survives a later withdrawal, while the proposal's text does not.

**QA:** derived work proposed, not assumed; the catalog's second bundled workflow up to owner assignment and due date.

### meetings-derivation: `EXP-03`

One run: recheck, ask the gate, call the model once, store what it said as a proposal.

**Owns:**

- `packages/application/src/meeting-derivation.ts`, and new `packages/application/src/meeting-derivation.test.ts`
- `packages/workflows/src/meeting-derivation-workflow.ts`, `meeting-derivation-activities.ts`, new `meeting-derivation-step.ts` and `meeting-derivation-step.test.ts`
- new `tests/integration/meeting-derivation.test.ts`, `tests/integration/fixtures/scripted-meeting-model.ts`, `tests/replay/capture-meeting-derivation.test.ts`, `tests/replay/meeting-derivation-corpus.test.ts`

**Implements, all stubbed already:**

```ts
// @ensemus/application
requestMeetingDerivation(database, context, { meetingId, purpose, providerApprovalId }): Promise<DerivationRunView>
listMeetingDerivations(database, context, meetingId): Promise<readonly DerivationRunView[]>
beginMeetingDerivation(database, context, { derivationRunId, temporalRunId }): Promise<BeginDerivation>
finishMeetingDerivation(database, context, { derivationRunId, answer }): Promise<{ status | 'dropped'; items }>
stopMeetingDerivation(database, context, { derivationRunId, code, to }): Promise<void>

// @ensemus/workflows/meeting-derivation-activities
createMeetingDerivationActivities({ database, model, egress }) -> { runMeetingDerivation, stopInterruptedDerivation }

// packages/workflows/src/meeting-derivation-workflow.ts
meetingDerivationWorkflow(input: MeetingDerivationInput): Promise<MeetingDerivationOutcome>
```

**Calls:** `checkBeforeDerivation`, `checkProviderApproval`, `consentStateOf`; the ports `MeetingModelGateway` and `MeetingEgressGate`, with `MeetingModelUnavailable`; `meetingSummaryOutputSchema`, `meetingItemsOutputSchema`; `emit` with `MEETING_DERIVATION_REQUESTED`, `MEETING_DERIVATION_COMPLETED`, `MEETING_DERIVATION_STOPPED`, and `notify` with `NOTIFY_MEETING_ITEMS_PROPOSED`, `NOTIFY_MEETING_DERIVATION_STOPPED`.

**Things to get right:**

- `requestMeetingDerivation`: the organizer, and a person. The notes are the newest version. Refuses with the right `AppError` before the trigger would. The event's aggregate is the run, with `AGGREGATE_MEETING_DERIVATION`, and it carries IDs and the purpose only.
- `runMeetingDerivation`, in one Activity, on `PLATFORM_TASK_QUEUE`, in this order: `beginMeetingDerivation`, then `egress.decide`, then `model.derive` under an `AbortSignal` with a deadline well inside the Activity's limit, then `finishMeetingDerivation`. The deny is `EGRESS_DENIED` and `refused`. `MeetingModelUnavailable` is `failed` with its code. **Nothing the model said, and none of the notes, reaches a log, an event or Temporal.**
- `beginMeetingDerivation`: lock the meeting, then the run. A run already `running` from an earlier try of this Activity goes again: it costs money and shows the same notes to the same approved provider, and that is accepted (ADR-033 D6). A run already finished is `done`. If `checkBeforeDerivation` fails, the run ends `refused` with its code and this returns `stopped`.
- `finishMeetingDerivation`: parse the output, or `refused` with `MODEL_OUTPUT_INVALID`, storing nothing. Under the meeting's lock: if the run is no longer `running`, return `dropped`. Summary or items go in at the meeting's class. `suggested_participant` maps by position to a member's membership, and an outsider or a bad number maps to null. `suggested_due_on` that is not a real date maps to null. Over `MAX_ITEMS_PER_RUN` is refused by the schema. Then `completed`. **Repeating it after a crash finds the run finished and stores nothing twice.**
- The workflow: one Activity with `startToCloseTimeout` of a few minutes, a `scheduleToStartTimeout`, and `maximumAttempts: 2`. If it fails, `stopInterruptedDerivation`, which ends a run still open as `failed` with `MODEL_UNAVAILABLE`, and a person is told. It starts nothing else, and has no timer. Its decisions are in `meeting-derivation-step.ts`, so a unit test reaches them.
- The fake model is `tests/integration/fixtures/scripted-meeting-model.ts`, and it never ships. **The default in `main.ts` is `noMeetingModel`, so a test proves a run with that default ends `failed` with `MODEL_UNAVAILABLE`, and that a run with `denyAllMeetingEgress` never reaches the model.**

**Denied tests:** the model is never called if consent went, the approval was revoked or expired, the class is over the approval's, the notes are not the newest, the egress gate says no, or the meeting is restricted. Another tenant's run. A service context asking for a run. A member who is not the organizer asking for one.

**Fault tests:** consent withdrawn while the model is thinking: `dropped`, nothing stored, and no notification. Revoked while thinking: its answer may still be stored, since the provider had already been shown it, and a test records that as the rule. Output with extra fields, huge text, an unknown kind, or a participant out of range. A prompt-injected note whose scripted answer tries to name an ID or a status: refused by the schema. The Activity retried at every step: one summary or one set of items. A worker dying mid-call: `failed`, and a person is told.

**Replay:** written, uncaptured, and reported as owed.

**QA:** consent and provider approval enforced; `SEC-006` analogue for model egress; `AI-TS-01` analogue.

### meetings-connector: `EXP-03`

Reading notes from a source, after consent. Titles and permissions by sync, and text only on request.

**Owns:**

- `packages/connectors/src/meetings/**`
- `packages/application/src/meeting-import.ts`
- `packages/workflows/src/meeting-import-workflow.ts`, `meeting-import-activities.ts`
- new `tests/integration/meeting-import.test.ts`, `tests/replay/capture-meeting-import.test.ts`, `tests/replay/meeting-import-corpus.test.ts`

**Implements, all stubbed already:**

```ts
// @ensemus/connectors/meetings
createMeetingNotesConnector({ tls, ca?, beforeCommitMs?, answerMs? }): MeetingNotesConnector

// @ensemus/application
requestMeetingNotesImport(database, context, { meetingId, providerApprovalId }): Promise<ImportRequestView>
beginMeetingImport(database, context, { importRequestId, temporalRunId }): Promise<BeginImport>
finishMeetingImport(database, context, { importRequestId, text, externalVersion }): Promise<{ notesId; version } | { stopped }>
stopMeetingImport(database, context, { importRequestId, code, to }): Promise<void>

// @ensemus/workflows/meeting-import-activities
createMeetingImportConnectorActivities(deps: ConnectorActivityDeps) -> { readMeetingNotes }
createMeetingImportPlatformActivities({ database }) -> { stopUnreadImport }

// packages/workflows/src/meeting-import-workflow.ts
meetingImportWorkflow(input: MeetingImportInput): Promise<MeetingImportOutcome>
```

**Calls:** `adapterExchange`, `transportFor`, `AdapterNotContacted`, `AdapterNoAnswer` from `@ensemus/connectors/business`; `adapterPageSchema`, `adapterNotesSchema`, `ADAPTER_BASE_PATH`; `MEETING_NOTES_CONNECTOR_MANIFEST`; `loadConnectionForWorker` (M3).

**Things to get right:**

- `sync.readPage` for `MEETING_NOTES_STREAM` asks for records and **keeps no fields at all**. Its `SyncedResource` holds an ID, a version, a title for `displayName` if the source gives one, grants, and `classification: 'confidential'` unless the source says higher. **The test puts a canary in a record's fields and proves it reaches nothing.**
- `manifest.capabilities.actions` is empty, so `actions` is absent, and `webhooks` is absent. Conformance: as in `connector-crm`, with `network: 'egress_gateway'`.
- `parseConfig`: `tlsServerName` only, strict, and `CONFIG_INVALID` for anything else. There is no scope setting, and no selected streams, since it has one.
- `notes.read`: `GET {base}/notes/{external_id}`, parsed with `adapterNotesSchema`. 404 is `SOURCE_NOT_FOUND`. A body over `MAX_NOTES_BYTES` is `SOURCE_TOO_LARGE`. Anything else is `CONNECTOR_UNAVAILABLE`, and reading it twice is harmless.
- `readMeetingNotes`, on `CONNECTOR_TASK_QUEUE`: `beginMeetingImport` rechecks consent, the approval and an active connection under the meeting's lock, then it reads the text in this worker's memory and calls `finishMeetingImport`, whose insert goes through the trigger again. **A withdrawal between the read and the store stores nothing.** No text goes in a log, an event or Temporal.
- `meetingImportWorkflow` follows M3's connector sync: the connector queue, `scheduleToStartTimeout` of an hour, and if no worker came, `stopUnreadImport` on the platform queue with `CONNECTOR_UNAVAILABLE`. Retry is safe, because the read has no effect.
- `requestMeetingNotesImport`: the organizer, a person, and a `connector` meeting.

**Tests, on the fake adapter:** sync with no text kept; a canary in a field; two tenants; read with each fault; a read refused when consent has gone; a read refused when the approval was revoked or names another connection. **Denied:** a member who is not the organizer, a service context asking, another tenant's meeting, a request before consent. Integration, written and not run: the whole path with real triggers. Replay: written, uncaptured, reported as owed.

**QA:** consent and provider approval enforced; connector lifecycle.

### meetings-web: `EXP-03`

API routes, and the meeting pages, on the existing design system, with empty, error and denied states, and browser specs.

**Owns:**

- new `apps/web/src/app/api/v1/organizations/[organizationId]/meeting-settings/**`, `meeting-provider-approvals/**`, `meetings/**`, `meeting-items/**`
- new `apps/web/src/server/meeting-actions.ts`, `apps/web/src/app/o/[organizationId]/meetings/**`, `apps/web/src/app/o/[organizationId]/settings/meetings/**`, `apps/web/src/components/meeting-*.tsx`
- `apps/web/src/app/o/[organizationId]/inbox/page.tsx`
- its own operations in `docs/specifications/openapi.yaml`, `packages/contracts/generated/**`, and its own lines in `tests/unit/openapi-contract.test.ts`
- new `tests/stack/meetings-api.test.ts`, `tests/browser/specs/meetings.spec.ts`

**Calls** (stubs until the others land, so your own tests stop at the HTTP layer and the components): every service in `meetings.ts`, `meeting-derivation.ts`, `meeting-proposals.ts` and `meeting-import.ts`; schemas from `@ensemus/contracts/meetings`; `apiRoute`.

**Things to get right:**

- Each route goes through `apiRoute`. Flip `x-ensemus-status: planned` off and remove the line as each one lands. Regenerate with `pnpm --filter @ensemus/contracts generate`.
- `meetings/page.tsx`: this person's, and for an owner or admin, the others' metadata, marked plainly as what they can and cannot see. Empty, error and denied states.
- `meetings/[meetingId]/page.tsx`: who was there, each person's answer on whose word, what is holding things up, the notes form once consent is complete, the runs and how they ended, summaries labelled as a model's words, and proposals. **Nothing proposed looks done.** A proposal is never shown as a task, and accepting one is a form with its fields filled in from the suggestion, that a person can change.
- Asking someone for consent shows the organization's notice reference and says who holds its text. **Ensemus writes no legal text here, and states nothing about what the law requires.** A test searches the page's strings for "comply", "compliant", "lawful" and "GDPR".
- Withdrawing says, before it happens, exactly what ADR-033 D5 says it takes and does not take: a Work Unit stays, a backup holds it until it expires, and a provider keeps what its terms say.
- An owner or admin who was not there sees no title and no notes, and the page says why.
- `settings/meetings/page.tsx`: turning on, the notice reference, provider approvals with their expiry and revoke. For owners and admins, and not found for others.
- Inbox: add `meeting.consent_requested`, `meeting.items_proposed`, `meeting.derivation_stopped` and `meeting.content_purged` to `KIND_WORDS`, and `meeting` to `targetPath`.
- Forms work without JavaScript. A status is never only a colour.

**Tests:** unit-test what is pure. Written and not run: the stack API test through the OpenAPI validator, including another tenant and a person with no access on every route, and the browser specs with axe and keyboard use.

**QA:** consent visible and enforced; derived work proposed, not assumed.

### stack: `EXP-01` `EXP-02` `EXP-03` (second wave)

Starts once the first wave is merged. End-to-end tests on real containers, operator docs, and traceability. **None of this runs locally: it runs when the owner decides to dockerize.** Make it typecheck and lint, and say so.

**Owns:**

- new `tests/stack/expansion.test.ts`, new `tests/helpers/fake-adapter-server.ts`, `tests/helpers/fixtures/fake-adapter-server.mjs`
- new `packages/department-packs/src/catalog.test.ts`
- new `tests/unit/expansion-wiring.test.ts`
- `apps/web/src/components/main-nav.tsx`, for the links to records and meetings
- `docs/00-foundation/03-decisions-and-adrs.md`, `docs/05-operations/05-container-deployment-runbook.md`, `docs/03-intelligence/06-integrations-and-tools.md`, `docs/02-architecture/03-data-model.md`
- `docs/specifications/traceability.csv`, `qa-scenarios.csv`, `implementation-backlog.csv`, `threat-register.csv`
- new `docs/06-delivery/evidence/M11A-report.md`
- **`docs/MANIFEST.json`, last of all.** Everyone else who changes a doc leaves it alone. It is regenerated at the end: `node docs/specifications/tools/regenerate-manifest.mjs`

**The stack test, as this milestone defines it:**

1. An admin makes a `crm_http` connection through the API, with generated values, and the fake adapter behind its gateway instance.
2. A sync brings records. A member with a source grant reads one, and an admin with no grant cannot.
3. A Work Unit proposes a change. The approver sees exactly what will change, approves it, and the adapter gets **one** operation with our key. A `sent` receipt shows.
4. The adapter applies and goes silent: `QA-008` for this tool. One effect, then `reconcile` finds it. Kill the connector worker during it: `AI-TS-01`.
5. An admin turns meetings on with a notice reference. Notes are refused until everyone agrees.
6. Everyone agrees, notes go in, and a run with a scripted model behind a test-only gateway proposes items. **No Work Unit exists.** A person accepts one, and one does.
7. Someone withdraws. Notes, summaries and open proposals have no text, the Work Unit stays, and a canary from the notes is absent from Temporal's persistence, logs and events, as `temporal-confidentiality.test.ts` proves today.
8. **Denied:** another tenant's token and pages, on every step.

**Also:**

- `catalog.test.ts`: every pack is built, none is null, all pass conformance, IDs are unique, and together they cover marketing, HR, finance and learning.
- `expansion-wiring.test.ts`: `businessConnectorsFrom` with no routes set gives none, and `main.ts` defaults to `noMeetingModel` and `denyAllMeetingEgress` until M4 replaces them, by reading the source.
- The runbook: one gateway instance per kind, each with its own target; `ENSEMUS_EGRESS_GATEWAY_CRM` and its siblings, `ENSEMUS_BUSINESS_TLS`, `ENSEMUS_BUSINESS_CA_PEM`; that an air-gapped install sets none and makes no attempt; what a withdrawal does and does not take; the restore rule.
- `06-integrations-and-tools.md`: add the adapter protocol and the gateway-per-kind rule, as built. `03-data-model.md`: "as built" notes for `meetings` and `business_records`. `03-decisions-and-adrs.md`: a line for ADR-033.
- `qa-scenarios.csv` and the backlog move only on evidence. `M11A-report.md` says what ran, on what, and what did not. **It claims nothing that CI has not shown.**

**Docker later, for the report:** the compose changes are listed in the foundation's handoff and are not made here.

## Handoff

Each builder reports: tickets, files, behaviour, commands actually run with results, anything fixed or stubbed left over, what could not run locally, and any report under "If you need a change". Commit messages end with the attribution line. Do not push. Finish with `git checkout --detach`.
