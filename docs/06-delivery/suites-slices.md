# Workspace suites slices

Decisions are in [ADR-038](../00-foundation/adr/ADR-038-workspace-suites.md). Read it first. Branch `codex/connect-oauth-directory`, from `codex/m7-platform-integration`.

**Code only.** Never run docker or docker compose, `test:integration`, `test:stack`, `test:browser` or `test:upgrade`. Run eslint, prettier, typecheck, and unit and replay tests on what you changed. Write the integration tests anyway and report them as owed. No real Google or Microsoft account, client, token or address: generated values, `@example.invalid`, and local fakes only. Use Context7 for current Google and Microsoft API shapes, and mark wire formats unqualified until the owner runs them live.

If you need a change to a file you do not own, stop and report it. Do not work around it.

## Stage 1a: foundation (one builder, before everything else)

**Owns:** `packages/database/migrations/0560_workspace_suites.sql`, `0561_workspace_suites_security.sql` (header line: `FLAGGED FOR HUMAN SECURITY REVIEW`), the matching Drizzle tables in `packages/database/src/schema-integrations.ts`, the migration journal, `packages/domain/src/workspace-suites.ts`, `packages/contracts/src/workspace-suites.ts`, the credential union in `packages/contracts/src/knowledge.ts`, ports in `packages/connectors/src/suites.ts`, Temporal input shapes and queue names, event names, error codes and their messages, and type stubs for every function stage 1b implements (each throws `NOT_IMPLEMENTED`).

**Tables:**

- `integrations.oauth_authorizations`: one consent attempt. Tenant, ID, connector type, display name, config, `client_kind` (`platform` or `customer`), public `client_id`, `customer_client_secret_id` (sealed `{client_id, client_secret}`, customer only), requested capabilities and scopes, `owner_membership_id` (null for the organization), `started_by_membership_id`, `state_sha256`, `verifier_secret_id`, `code_secret_id`, `status` (`pending`, `code_received`, `exchanging`, `connected`, `denied`, `failed`, `expired`), `error_code`, `connection_id`, `expires_at`, timestamps.
- `integrations.directory_groups`: connection, external ID, team ID (unique per tenant), display name, `seen_generation`.
- `integrations.connections.owner_membership_id`.

**Security SQL:** RLS like every `integrations` table. Column grants, so the identity, state hash, client, scopes requested and secrets cannot be updated. A transition trigger that allows only the arrows in ADR-038 D1. A trigger on `org.team_memberships`, and on deleting or renaming a team, that refuses changes to a directory team unless `current_setting('ensemus.directory_sync', true)` equals that team's connection ID. Denied tests for each.

## Stage 1b: three builders at once, after 1a is committed

### connect-web: `CONNECT-07`, web half

**Owns:** `packages/application/src/oauth-authorizations.ts` and its tests. The routes `apps/web/src/app/api/v1/organizations/[organizationId]/oauth-authorizations/**` and `apps/web/src/app/api/v1/oauth/callback/route.ts`. A "Connect Google Workspace" and "Connect Microsoft 365" flow on the connections page, with capability choice and the customer-app option. `tests/integration/oauth-authorizations.test.ts`.

Start: check the privilege, generate state and the PKCE verifier, seal the verifier (and the customer client), insert `pending`, and return the provider's authorize URL. Callback: same tenant, same signed-in member, constant-time state check, still `pending`, not expired, then seal the code, move to `code_received` and emit the event in one transaction. Every failure is `OAUTH_STATE_INVALID`. A provider `error` becomes `denied` with a fixed code. The page shows progress and the result in plain words, never provider text.

### connect-worker: `CONNECT-07`, worker half, and wiring

**Owns:** `packages/workflows/src/oauth-exchange-*.ts`, the `PlatformOAuthClients` port and the credential union's use in `packages/connectors/src/runtime/provider-oauth.ts`, writing `granted_scopes` on exchange and on any refresh that reports scopes, registering Google and Microsoft in `workers/workflow/src/connector-worker.ts` with one gateway per route, the dispatcher entry, and the Compose services for the per-route gateways (written, not run).

The exchange Activity runs once (`maximumAttempts: 1`). It locks the row, moves to `exchanging`, unseals, posts the token request, checks the response the way `createProviderAuth` does, reads `email` and Microsoft's `tid` from the ID token, keeps `granted ∩ requested`, seals the credential, creates the connection, moves to `connected` and revokes the code and verifier, in one transaction. A failure ends `failed` with a code and revokes them too. Test with a canary that no code, verifier, token or secret reaches a log, an error, a row or Temporal.

### directory: `CONNECT-08`

**Owns:** the `directory_groups` stream in `packages/connectors/src/google/**` and `microsoft/**`, `packages/application/src/directory.ts`, group resolution in `resolveSourcePrincipal`, `tests/integration/directory-sync.test.ts`.

Google: Admin SDK Directory groups and members, full pass with generations. Microsoft: Graph `groups/delta` with members. Google groups are keyed by email, so change the Drive connector's group grants from permission ID to the group's email. Flatten nested groups to five levels, cutting cycles. Each group's membership is replaced in one transaction under `ensemus.directory_sync`. A group gone after a completed full pass loses its members, then its team. Revoking the connection removes its teams.

## Stage 2: suite tools for agents (`CONNECT-09`, after stage 1)

Design: ADR-038 "D6 in detail". Read it first.

### 2a. Foundation (one builder, done before the three below)

Built: the tool manifests as data (`packages/domain/src/suite-tools.ts`, `ai-tools.ts`), strict argument schemas (`packages/contracts/src/suite-tools.ts`), the pure rule `decideConnectionUse` (`packages/policy/src/suite-access.ts`), the gateway's dispatch by class and its suite read halves (`packages/agent-runtime/src/tools/index.ts`), the generalized intent path and `proposeDraftActionInTx` (`packages/application/src/external-actions.ts`), the binder's `recordDraft`, the connector worker's `claimSuiteRead`/`finishSuiteRead` (`packages/application/src/suite-reads.ts`) and `runSuiteRead` (`packages/workflows/src/suite-read-activities.ts`, registered in `connector-worker.ts`), the agent workflow's `patched('agent-suite-read-v1')` branch, the usable-connection list in the model's task, the `google_gmail`, `google_docs` and `google_sheets` routes with their Compose gateways, migration `0563_suite_tools.sql` (FLAGGED FOR HUMAN SECURITY REVIEW), the member consent path in `startAuthorization`, and stubs for every handler.

Owed from 2a, for whichever builder reaches them first, by agreement: an approval-page view per suite payload (`apps/web/src/app/o/[organizationId]/approvals/[approvalId]/agent-action.tsx`), the run-end purge of uncollected `suite_reads` output, MCP through the rule, a replay history that exercises the suite read branch, and `tests/integration/suite-tools.test.ts` run against the stack.

### 2b. Three builders at once, after 2a is committed

Every handler is `(deps, context, args, access) => Promise<SuiteReadResult>` for a read, and `{ send(deps, context, request), reconcile(deps, context, request) }` for a change, over arguments and a payload already re-parsed by the tool's schema (`createSuiteToolDispatch` in `packages/connectors/src/suites.ts`). Reads throw `SuiteReadRefused(code)` for a final answer and `SyncUnavailable(code)` for one worth retrying, never with provider text. Sends follow ActionConnector's rules: `NotSent` only when certain nothing happened. Each read returns the resource IDs of the organization's content it contains; a search through the organization's connection drops what `access.permitted(ids)` leaves out. Each tool has a denied test for: missing scope, another member's connection, restricted class, and a changed payload after approval (the binder's recheck catches the last; add a connector test that a payload not matching the schema is `NotSent('PAYLOAD_CHANGED')`).

#### google-tools

**Owns:** the bodies in `packages/connectors/src/google/tools.ts` and their tests (`packages/connectors/src/google/tools.test.ts`, new), and any Google-only helpers beside it. Nothing else.

Read handlers: `gmailSearch`, `gmailReadThread`, `calendarListEvents`, `driveSearch`, `docsRead`, `sheetsReadRange`. Change handlers: `gmailCreateDraft`, `gmailSend`, `calendarCreateEvent` (event ID derived from `idempotencyKey`, reconcile authoritative: a 404 for that ID is `not_found`), `calendarUpdateEvent`, `driveCreateFile` (app property carrying the intent ID), `docsEdit` (`writeControl.requiredRevisionId` from the payload; Docs refusing it is `rejected`), `sheetsWriteRange` (`valueInputOption` from `value_input`). `GoogleToolDeps` is `{ http, withToken }`. Routes: `google_gmail`, `google_api` (Calendar, Drive), `google_docs`, `google_sheets`.

#### microsoft-tools

**Owns:** the bodies in `packages/connectors/src/microsoft/tools.ts` and their tests (`packages/connectors/src/microsoft/tools.test.ts`, new). Nothing else.

Read handlers: `outlookSearch`, `outlookReadThread`, `calendarListEvents`, `onedriveSearch`, `wordRead`, `excelReadRange`. Change handlers: `outlookCreateDraft`, `outlookSend` (Message-ID header from the intent; reconcile by searching Sent Items), `calendarCreateEvent` (`transactionId` from `idempotencyKey`, reconcile best effort), `calendarUpdateEvent`, `onedriveCreateFile`, `excelWriteRange`, `teamsPostMessage`. `MicrosoftToolDeps` is `{ http, withToken }`. Route: `ms_graph` only.

#### personal-connections

**Owns:** the pages and routes for a member to connect, see and revoke their own account (`apps/web/src/app/o/[organizationId]/settings/connections/**`, new), the admin control for `setMemberCapabilities` on the connections page, `revokeMyConnection` in `packages/application/src/suite-settings.ts` (stub today), its API routes and their `docs/specifications/openapi.yaml` entries, and `tests/integration/personal-connections.test.ts`.

Built for you: `startAuthorization(…, { owner: 'member', … })`, `getMemberCapabilities`, `setMemberCapabilities`, `listMyConnections`, `listMyUsableConnections`, and 0563's checks. A member's consent asks only for `MEMBER_CONNECTABLE_CAPABILITIES` the organization allows; refuse in plain words, never provider text.
