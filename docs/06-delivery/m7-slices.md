# M7 slices

Ten builders work in parallel from the foundation commit and one closes after them. **No file has two owners.** Everything they must agree on is already decided in [ADR-031](../00-foundation/adr/ADR-031-full-product-depth.md) and already typed in the code. Read that ADR first, because it holds the reasons, then your own section and "Every slice".

If you need a change to a file you do not own, or to anything in "Fixed" below, stop and report it. Do not work around it, and do not edit the file.

## Fixed: nobody changes these

| What | Where |
|---|---|
| Migrations, RLS, roles and triggers. **No builder adds a migration** | `packages/database/migrations/0400_*`, `0401_*`, `packages/database/src/schema-product.ts`, `product.ts`, `sso-operator.ts`, `auth.ts`, `schema.ts`, `drizzle.config.ts`. Migration `meta/` and the journal are left for the final merge |
| Capabilities, privileged actions, access rules | `packages/domain/src/product-policy.ts` |
| Event names | `packages/domain/src/product-events.ts` |
| Types and signatures | the exported types in `packages/domain/src/{pulse,outcome-composer,agent-draft,simulation,process-spec,process-run,custom-object,pack,onboarding}.ts`, and every exported signature in `packages/application/src/product/*.ts`. Fill the stubs, and add private helpers and new modules of your own. If a signature is wrong, report it |
| Ports | `packages/application/src/product/ports.ts`, `apps/web/src/server/product-ports.ts`, `workers/workflow/src/product-ports.ts` |
| Recent MFA | `packages/application/src/product/privileged.ts`. `assertTenantSignIn` in `packages/application/src/product/sso.ts` |
| Temporal inputs | `packages/workflows/src/product-schemas.ts`, `workflows.ts` |
| Wiring | `workers/workflow/src/dispatcher.ts`, `main.ts`, `scripts/build.mjs`, `identity-operator.ts`, `apps/web/src/server/tenant.ts`, `api.ts`, `actor.ts`, `apps/web/src/app/o/[organizationId]/layout.tsx`, `apps/web/src/lib/product-nav.ts`, `apps/web/src/lib/step-up.ts`, `apps/web/src/lib/messages.ts`, `packages/application/src/errors.ts`, `packages/application/src/index.ts`, `packages/telemetry/src/index.ts` |
| Contracts | `packages/contracts/src/{studio,custom-objects,packs,experience,identity-admin}.ts` |
| Import rules | `eslint.config.mjs` |
| Dependencies. **`pnpm-lock.yaml` is frozen, and no builder adds a package.** `@better-auth/sso`, and `samlify` and `selfsigned` for tests, are already in. Anything else comes back here | every `package.json`, `apps/web/next.config.ts`, `infrastructure/scripts/check-licenses.mjs` |
| Shared test helpers | `tests/helpers/product.ts`, `tests/integration/product-schema.test.ts`, `tests/unit/web-step-up.test.ts` |
| Styles | `apps/web/src/app/globals.css`. **Use what is there.** Anything new goes in a CSS module beside your component, using the existing tokens, so no two slices touch one file |
| The spec, until close | `docs/specifications/openapi.yaml`, `packages/contracts/generated/**`, `tests/unit/openapi-contract.test.ts` |
| Decisions | ADR-031, this file |

A bug in any of these is reported, not fixed in passing.

## What runs where

**This milestone is code only.** The owner's PC is low on disk, and the owner decides later when to dockerize and test.

| Rule | Detail |
|---|---|
| Allowed | `pnpm exec prettier`, `eslint`, typecheck, `pnpm --filter @ensemus/web exec next typegen`, and unit and replay tests (`vitest run --project unit <paths>`, `pnpm test:replay`). Check only what you changed |
| Never | `docker` or `docker compose` in any form. `pnpm test:integration`, `test:stack`, `test:browser`, `test:upgrade`, or any gate needing a container. Dev servers and watch modes. Do not edit Dockerfiles or compose files: report what they need |
| Memory | Every `pnpm install`, typecheck, eslint, `next typegen`, vitest or other heavy command goes through `node "C:\Users\MUHAMM~1\AppData\Local\Temp\claude\9cec8f68dad5aa23\ee0a16d3-9f5a-455f-8aa4-cabdb46f784b\scratchpad\heavy.mjs" <command>` with a 600000 ms Bash timeout. Exit 75 means no slot yet, so run it again. Write your code first, and check it in as few runs as you can |
| Integration, stack, browser tests | **Still write them, and make them typecheck. They count as unverified. Say so, and never report them as passing.** `0400` and `0401` are not in the journal until the final merge, so they could not pass here anyway |
| Replay histories | New workflows' histories need Temporal running, so they are owed. Write the capture test and the corpus test, make them typecheck, and list the histories as owed |
| The OpenAPI test | Your route exists while the spec still says `planned`, so `tests/unit/openapi-contract.test.ts` fails on a slice branch until close runs. That is expected, and only for your own operations. **Do not edit that file or the spec.** Follow the shapes in the spec's components, with snake_case keys |
| Disk | Below 3 GB free on C:, stop and report. Never prune or delete anything outside your worktree |
| Time | The owner stops at 22:00 local. Run `date`. If it is past 21:15 and you are not done, commit what typechecks and list the rest as not done, rather than leaving work uncommitted |

## Every slice

- **Denied and cross-tenant tests first, then the code.** Two tenants with the same names, using `makeTwoTenants` from `tests/helpers/product.ts`, on real roles. Every feature has a test for: a member who may not, an admin who may not when the rule says so, another tenant's ID (not found, never forbidden), and a stale version.
- **All tenant access goes through `withTenantTx`.** A service context never gets a person's powers. `assertRecentMfa(tx, context, action, proof)` goes in the same transaction as the effect, and a web caller passes `{ sessionId: actor.sessionId }` from `requireTenant`, or `{ sessionId: scope.sessionId }` from `apiRoute`, and nothing from a form.
- **Only IDs, enums and counters cross Temporal.** New workflows only import `@temporalio/workflow` and types. A workflow's decisions live in a pure module. Changing the order of steps needs a patch.
- **Events carry IDs and enums only.** `emit(tx, context, ...)` in the same transaction as the write, with names from `product-events.ts`. Text a person wrote never goes in an event, a log, a notification or Temporal.
- **Each write that matters is audited** with `auditAction` from `@ensemus/application` (see `packages/application/src/work.ts`), with codes and no text.
- **Fakes live with tests.** `fakePorts()` from `tests/helpers/product.ts` starts from the honest default. Nothing fake ships as a default code path, and a port that is unavailable is shown as that: `CAPABILITY_UNAVAILABLE` gets its own plain sentence on the page and is never an empty list.
- **No fake controls, no claims without evidence.** No invented prices, SLAs, RTO or RPO numbers, certifications or legal terms. A button does what it says or it is not there. Do not draft legal terms.
- **Pages** follow what exists: `apps/web/src/components/ui.tsx` (`PageHead`, `Empty`, `ErrorNotice`, `StatusBadge`, `ClassificationBadge`), `submit-button.tsx`, `confirm-form.tsx`, `requireTenant` and `orNotFound` from `@/server/tenant`. Each page has empty, error and denied states, and a denied person gets the usual not found. **Forms work without JavaScript,** through Server Actions, as `tests/browser/specs/no-javascript.spec.ts` holds the rest to. Keyboard reachable, with labels and visible focus. On `MFA_REQUIRED`, an action redirects to `stepUpPath(organizationId, returnPath)` from `@/lib/step-up`.
- **API routes** go through `apiRoute` from `@/server/api`, with `readJson`, `readIfMatch` and `etag`. Folder names are the camelCase of the spec's parameter: `{agent_draft_id}` is `[agentDraftId]`. Lists answer `{ items, next }`. Keys are snake_case. **A route's folder is `apps/web/src/app/api/v1/organizations/[organizationId]/...`.**
- **New tests go in your own files.** `tests/integration/<slice>.test.ts`, `tests/stack/<slice>.test.ts` and `tests/browser/specs/<slice>.spec.ts` with axe and keyboard use, as the rest do. Pure domain tests sit beside the code as `*.test.ts`, and those you run.
- Generated test values only: `@example.invalid` addresses, random secrets, keys made at runtime. No real address, credential or provider.
- Follow the house comment style: say why, in plain sentences.
- Use Context7 for anything about a library. Commit with several `-m` flags, the last being `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`, early and often. Do not push. Use the Write tool, not shell heredocs.

## Wave 1: all start at once

### mfa: `ID-05`

Recent MFA for privileged actions. Acceptance: privileged actions require recent MFA, and bypass attempts are denied. `QA-045`, `TR-025`. ADR-031 D8.

**Owns:**

- `packages/auth/src/mfa.ts`, `packages/auth/src/index.ts` (only `submitCredentials`, its types, and what it needs), new `packages/auth/src/mfa.test.ts`
- `packages/application/src/product/security-policy.ts`
- `apps/web/src/server/actions.ts`, `apps/web/src/app/sign-in/page.tsx`, new `apps/web/src/app/sign-in/two-factor/**`
- new `apps/web/src/app/o/[organizationId]/security/page.tsx`, `security/confirm/**`, `security/two-factor/**`, new `apps/web/src/server/security-actions.ts`, new `apps/web/src/components/security/**`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/security-policy/route.ts`
- new `tests/helpers/totp.ts`, `tests/integration/mfa.test.ts`, `tests/stack/mfa.test.ts`, `tests/browser/specs/mfa.spec.ts`

**Implements:**

```ts
// packages/auth/src/mfa.ts
mfaPlugins(): BetterAuthPlugin[]                      // twoFactor({ issuer: 'Ensemus', ... })
createMfaOperations(deps: MfaDependencies): MfaOperations   // verifyStepUp(input, session, headers)
// @ensemus/application/security-policy
getSecurityPolicy(database, context): Promise<SecurityPolicyView>
updateSecurityPolicy(database, context, proof, input): Promise<SecurityPolicyView>
listMemberSecondFactors(database, context): Promise<readonly MemberSecondFactor[]>
```

**Calls:** `assertRecentMfa` and `hasRecentMfa` from `@ensemus/application/privileged`, `recordSessionAssurance` (already wired into `deps.record`), `stepUpSchema` and `updateSecurityPolicySchema` from `@ensemus/contracts/identity-admin`.

**Things to get right:**

- `verifyStepUp` posts to `/two-factor/verify-totp` or `/two-factor/verify-backup-code` through `deps.handler`, with the incoming cookie and an own-origin header, as `submitCredentials` does, so Better Auth's limits and lockout apply. It records the proof only on a 200, for that session only.
- Sign-in with an enrolled person comes back `twoFactorRedirect: true` with no session. `submitCredentials` gains an outcome for that, and `signInAction` goes to `/sign-in/two-factor`, where a correct code gives a session and records a proof. Check the plugin's actual behaviour and field names on the installed 1.7.17 and through Context7, including what `disabledPaths` covers.
- `/two-factor/view-backup-codes` is server-only in the plugin: never expose it. Backup codes are shown once at enrolment and on regeneration, with `Cache-Control: no-store`. Enrolment confirms a code before it counts (`skipVerificationOnEnable` stays false). The TOTP secret is never logged, or in a URL except the `otpauth` value shown once. No external QR service: show the secret and render the QR locally only if it needs no new package, otherwise show the key to type in.
- `/security/confirm` asks for a code and returns to `safeStepUpReturn(organizationId, next)`. `updateSecurityPolicy` needs `security_policy.manage` and `assertRecentMfa('security_policy.change')`, with `mfaMaxAgeSeconds` in the table's range, and is audited with `SECURITY_POLICY_CHANGED`.
- Keep existing tests true: someone with no second factor signs in exactly as today, and M2's actions do not ask unless the tenant turned that on.

**Denied and fault tests:** no proof, an old proof, a proof from another session, and from another person. A forged `sessionId` field in a form. A wrong code many times is limited, and locks out. A code replayed from the previous step-up. The application role cannot write `session_assurances` (already in `product-schema`, so test it through the service). A service context never passes. A member cannot change the policy. Another tenant's policy is not visible. A session signed out loses its proof, because the row cascades.

### sso: `ID-04`

SAML sign-in and deprovisioning. Acceptance: SSO login and deprovisioning tested; which plans include it follows the owner's decision. `QA-043`, `QA-044`, `TR-023`, `TR-024`. ADR-031 D9.

**Owns:**

- `packages/auth/src/sso.ts`, new `packages/auth/src/sso.test.ts`
- `packages/application/src/product/sso.ts` (everything except `assertTenantSignIn`)
- new `apps/web/src/app/sign-in/sso/**`, `apps/web/src/app/sso/complete/**`, `apps/web/src/app/api/scim/v2/**`, `apps/web/src/server/scim.ts`, `apps/web/src/lib/scim.ts`
- new `apps/web/src/app/o/[organizationId]/security/sso/**`, `apps/web/src/server/sso-actions.ts`, `apps/web/src/components/security-sso/**`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/sso-connections/**`
- new `tests/helpers/saml-idp.ts`, `tests/unit/web-scim.test.ts`, `tests/integration/sso.test.ts`, `tests/stack/sso.test.ts`, `tests/browser/specs/sso.spec.ts`

**Implements:**

```ts
// packages/auth/src/sso.ts
ssoPlugins({ baseURL }): BetterAuthPlugin[]
createSsoOperations(deps): SsoOperations     // storeProvider, removeProvider
SSO_DISABLED_PATHS                           // extend it if the installed plugin has more mutating routes
// @ensemus/application/sso
listSsoConnections, createSsoConnection, updateSsoConnection, issueScimToken, revokeScimToken,
completeSsoSignIn, scimListUsers, scimDeprovisionUser, scimReactivateUser
```

**Calls:** `withScimTokenTx`, `withSsoProviderTx` from `@ensemus/database/product`, `assertRecentMfa`.

**Things to get right:**

- `sso({ domainVerification: { enabled: true }, saml: { enableInResponseToValidation: true, allowIdpInitiated: false }, disableImplicitSignUp: false, trustEmailVerified: false, providersLimit: 0, guardProviderMutation: refuse })`, with the real option names checked on the installed `@better-auth/sso` 1.7.17 and through Context7. `authSchema` already maps `ssoProvider` to `identity.sso_providers`. **The plugin's own routes that change providers must 404: test it.** Check that `resolveUser` and `provisionUser` never link an account by an email outside the verified domain.
- **Metadata is pasted, and never fetched.** `storeProvider` parses it, requires signed assertions and `sha256`, requires an HTTPS entry point, bounds its size, and refuses a DOCTYPE or an entity, before storing. `oidc_config` stays null (the table has a `CHECK`).
- The asserted email has to be inside the connection's verified domain, or `completeSsoSignIn` answers `refused` and no membership, session assurance or account is left. If the plugin has created the user by then, say so in your report.
- `/sso/complete` reads the session, records the `sso_saml` assurance through `sso.recordAssurance`, and calls `completeSsoSignIn`. **Role never comes from an assertion.** `autoJoin` only ever adds `member`. A deprovisioned link or a disabled membership stays out.
- SCIM: `/api/scim/v2/Users` with `Authorization: Bearer`, hashed with SHA-256, through `withScimTokenTx`. Only list, read, and `PATCH active`. `DELETE` means the same as `active: false`. Everything else answers a SCIM `501`. In-memory rate limit per replica, in pure `lib/scim.ts`, before any database use. M3 specifies the same shape for webhooks in ADR-027 D4. No session. A 401 for no token, an unknown one and a revoked one alike. **Never log a token.**
- Deprovision: membership `disabled`, link `deprovisioned`, audit, `MEMBER_DEPROVISIONED`, idempotent. `last_owner` is refused and audited. Reactivate only undoes what SCIM did.
- **Do not edit Caddy.** If the proxy's body limit or routes need changing for the ACS path, report it for `docker_later`.

**Mock provider:** `tests/helpers/saml-idp.ts` signs with `samlify` and a certificate from `selfsigned`, generated at runtime, in-process. Never a real provider.

**Denied and fault tests:** an assertion outside the domain. An assertion for a person in another tenant. An unsigned assertion, a wrong key, a tampered attribute, signature wrapping, a replay, and an assertion answering no request (`InResponseTo`). An unverified connection signs nobody in. Tenant B's provider cannot produce a session usable in tenant A. A tenant cannot verify its own domain through any route. Plugin mutation routes 404. A member cannot manage connections. A SCIM token only reaches its own tenant, and only people linked to its connection. A deprovisioned person's next request is refused, while their other tenant still works. Last owner kept. `sso_enforcement: required` sends a member with a password session to `/sign-in/sso`, leaves the owner in, and an active-connection removal lets everyone back.

### pulse: `WORK-09`

Company Pulse. Acceptance: every risk signal links to source evidence. `QA-029`, `QA-030`. ADR-031 D4.

**Owns:**

- `packages/domain/src/pulse.ts` (the function), new `packages/domain/src/pulse.test.ts`
- `packages/application/src/product/pulse.ts`
- new `apps/web/src/app/o/[organizationId]/pulse/**`, `apps/web/src/server/pulse-actions.ts`, `apps/web/src/components/pulse/**`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/pulse/**`
- new `tests/integration/pulse.test.ts`, `tests/stack/pulse.test.ts`, `tests/browser/specs/pulse.spec.ts`

**Implements:**

```ts
// @ensemus/domain/pulse
deriveSignals(facts: PulseFacts): readonly PulseSignal[]
// @ensemus/application/pulse
getCompanyPulse(database, context, ports, input?): Promise<CompanyPulse>
setPulseSignalState(database, context, ports, input): Promise<void>
```

**Calls:** `visibleTo`-style filtering as `listWorkUnits` does in `packages/application/src/work.ts` (read it, and do not edit it). `AgentRunsPort.listMine`.

**Things to get right:**

- **Every read filters by what the viewer may read, before `deriveSignals` sees anything.** A restricted Work Unit neither appears nor changes a count. Bound every query, and page size is fixed.
- A signal's `key` is stable, such as `work_overdue:{id}`. No per-person number, ranking or trend anywhere. No sentence says why: it says what, and links to the record. A page may word "overdue" and "waiting on a prerequisite" side by side, and never joins them with "because".
- An `agentRuns` port that is unavailable makes that part `partial`, and the page says it could not read it. Evidence for an agent run links to the Work Unit page.
- A snooze is the viewer's own and has an end. `setPulseSignalState` refuses a key the viewer cannot currently see, with `NOT_FOUND`.
- Page: a summary, then signals grouped by severity with evidence links, then dismissed ones behind a link. Empty state says what it looked at, not that everything is fine.

**Denied and fault tests:** two tenants with same-named work. A member cannot see a signal on restricted work, or a count including it. Someone removed from work stops seeing its signal at once. One person cannot dismiss for another. A key for work they cannot read is refused. `deriveSignals` is total over random facts, each signal has evidence, and the same facts give the same order (T0). A response holds no per-person field (asserted on the shape).

### composer-onboarding: `UX-20`, `UX-21`

The outcome composer and Journey A. Acceptance: natural-language objective becomes a previewed Work Unit, and nothing runs until authorized. A new company completes setup and a zero-side-effect simulation of its first workflow. `QA-041`, `QA-042`. ADR-031 D5.

**Owns:**

- `packages/domain/src/outcome-composer.ts`, `onboarding.ts` (the functions), new `outcome-composer.test.ts`, `onboarding.test.ts` beside them
- `packages/application/src/product/outcomes.ts`, `onboarding.ts`
- new `apps/web/src/app/o/[organizationId]/compose/**`, `get-started/**`, `apps/web/src/server/outcome-actions.ts`, `onboarding-actions.ts`, `apps/web/src/components/composer/**`, `onboarding/**`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/outcome-drafts/**`, `onboarding/**`
- new `tests/integration/outcomes.test.ts`, `tests/integration/onboarding.test.ts`, `tests/stack/onboarding.test.ts`, `tests/browser/specs/composer.spec.ts`, `onboarding.spec.ts`

**Implements:**

```ts
// @ensemus/domain/outcome-composer
parseObjective(objective, context: ComposerContext): OutcomePreview
// @ensemus/domain/onboarding
onboardingStatus(facts: OnboardingFacts): OnboardingStatus
// @ensemus/application/outcomes
composeOutcome, getOutcomeDraft, listMyOutcomeDrafts, reviseOutcomeDraft, authorizeOutcome, discardOutcome
// @ensemus/application/onboarding
getOnboarding, decideOnboardingStep, startFirstSimulation
```

**Calls:** `createWorkUnit` from `@ensemus/application` for an authorized outcome, `requestSimulation` from `@ensemus/application/simulations`, `BUNDLED_WORKFLOWS` from `@ensemus/packs/bundled` (keywords for suggestions, and the first one for onboarding). These last two are stubs or empty until the other slices land, so inject or seed in your tests, and handle an empty catalog honestly.

**Things to get right:**

- `parseObjective` is rules, pure, and takes `today` from the person. "by Friday" is their next Friday. It never guesses a date: unclear is null with `due_date_unclear`. It always returns an editable preview. No model, no outbound anything.
- `previewSha256` over canonical JSON (`canonicalJson` from `@ensemus/domain/approval`). `authorizeOutcome` requires the hash the person read, the draft's version, and `work.create`, and makes one Work Unit with the same `requestKey` idempotency. A second call gets the same Work Unit. **It starts no run, no agent and no process, and emits only `OUTCOME_AUTHORIZED`.** `dataAccess` says honestly what a suggestion would reach.
- Drafts are the author's. Anyone else gets not found, whatever their role.
- Objective text stays in the table. It is never in events, logs or Temporal.
- `onboardingStatus`: a step is done because its record exists. `model_provider` and `first_knowledge_source` are optional (Journey A: AI stays optional, and non-AI core stays usable), and a `null` port fact is `unavailable`, not `to_do`. `responsibility_statement` is the one acknowledged by a person: **word it from what `docs/01-product/02-personas-and-journeys.md` Journey A step 1 and ID-01 say, and do not draft legal terms.** Skipping a required step is refused. `ONBOARDING_FINISHED` once.
- `get-started` shows each step with a link to where it is really done, and the state of `first_simulation` reads from the row. The simulation page says plainly that nothing was sent.

**Denied and fault tests:** a member cannot read or change onboarding. Nothing runs before authorization: no event, no run, no Work Unit (row counts, T2). A changed preview is `OUTCOME_CHANGED`. An authorized draft cannot change (trigger). Another tenant's draft and another person's are not found. A due date that does not exist. An injection string in an objective stays text. Provider unavailable: onboarding still finishes, and core work works. The simulation produces no outbox event but `simulation.requested`, and no connector row.

### surfaces: `UX-19`, Knowledge UI

The Assistants area and the Knowledge page. Acceptance: delegated runs and outcomes are visible in plain language, and the user can stop them. `QA-047`. Knowledge: UX-18's page, on M5's port (ADR-031 D2).

**Owns:**

- `packages/application/src/product/assistants.ts`, `knowledge-view.ts`
- new `apps/web/src/app/o/[organizationId]/assistants/**`, `knowledge/**`, `apps/web/src/server/assistant-actions.ts`, `apps/web/src/components/assistants/**`, `knowledge/**`
- new `tests/unit/assistants-wording.test.ts`, `tests/integration/assistants.test.ts`, `tests/browser/specs/assistants.spec.ts`, `knowledge.spec.ts`

**Implements:**

```ts
// @ensemus/application/assistants
listMyDelegatedRuns(context, ports, input?): Promise<AssistantsView>
getDelegatedRun(context, ports, runId): Promise<DelegatedRun>
stopDelegatedRun(context, ports, runId): Promise<void>
describeRunStatus(run): string
// @ensemus/application/knowledge-view
readKnowledgePage(context, ports, input): Promise<KnowledgePage>
```

**Calls:** `webProductPorts()` from `@/server/product-ports`, `AgentRunsPort`, `KnowledgeReadPort`.

**Things to get right:**

- **Everything is on the far side of a port,** so all rules live in M4 and M5. Add no filtering and no widening. Until the merge the real ports are unavailable, and both pages say so plainly in a dedicated state: not empty, and not an error.
- `describeRunStatus` is a fixed sentence per status and stop code from the M4 plan's FD-7 list: `queued, preparing, running, paused, waiting_for_approval, waiting_for_child, verifying, completed, failed, cancelled, budget_exhausted, policy_denied, timed_out, outcome_unverified`, with a generic honest sentence for anything unknown. **No model text and no chain of thought, ever.** Show `label_code`s through your own wording map.
- Stop is a confirm form with no JavaScript. After it, the page reads the run again: **it never says stopped until the run says so.**
- Cost is shown only if present, and labelled an estimate if `costIsEstimate`.
- Knowledge: sources with freshness and access state, a search box, and hits with citation and a path to the original. Never a sentence composing an answer here: cited answers are M5's. Query text is never logged, and it is not put into a URL that would reach logs: use POST through a Server Action and a `no-store` page, or say why not.

**Denied and fault tests (T2, with `fakePorts`):** a port that throws `NOT_FOUND` for another person's run gives a 404. `CAPABILITY_UNAVAILABLE` gets the unavailable state, and never an empty list. Stop fails: the page says it did not stop. All statuses and stop codes get a sentence (T0). A canary string in a fake's step never renders.

### objects: `KNOW-07`

Custom objects. Acceptance: custom types retain validation and policy scope. `QA-037`, `QA-038`. ADR-031 D11.

**Owns:**

- `packages/domain/src/custom-object.ts` (the functions), new `custom-object.test.ts` beside it
- `packages/application/src/product/custom-objects.ts`
- `packages/workflows/src/object-migration-workflow.ts`, `object-migration-activities.ts`, new `object-migration-step.ts` if decisions need a pure home
- new `apps/web/src/app/o/[organizationId]/objects/**`, `apps/web/src/server/object-actions.ts`, `apps/web/src/components/objects/**`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/object-types/**`, `object-records/**`
- new `tests/integration/custom-objects.test.ts`, `tests/stack/custom-objects.test.ts`, `tests/browser/specs/objects.spec.ts`, `tests/replay/capture-object-migration.test.ts`, `tests/replay/object-migration-corpus.test.ts`

**Implements:**

```ts
// @ensemus/domain/custom-object
validateObjectSchema(input), validateRecordAttributes(fields, attributes),
planTypeMigration(from, to), migrateRecordAttributes(plan, attributes)
// @ensemus/application/custom-objects
createObjectType, createObjectTypeInTx, listObjectTypes, getObjectType, addObjectTypeVersion,
raiseObjectTypeClassification, createObjectRecord, listObjectRecords, getObjectRecord, updateObjectRecord,
deleteObjectRecord, linkObjectRecords, unlinkObjectRecords, migrateObjectBatch, failObjectMigration
```

**Calls:** `canReadRecord`, `canChangeRecord`, `canProduct` from `@ensemus/domain/product-policy`.

**Things to get right:**

- Filter by `canReadRecord` in SQL as well as after, so a page size is honest and a restricted record does not even count. Only indexed fields filter, through `record_values`, written in the same transaction as the record.
- Type shapes are immutable rows: `addObjectTypeVersion` writes a new one with `schemaSha256`, and refuses a plan with any `refused` step with `OBJECT_SCHEMA_INVALID`, with the issues on the error for the page. **No force option.**
- `validateRecordAttributes` refuses unknown keys, wrong kinds and over-long text. Treat `email` and `url` as text with a format check only (`http` and `https`), and a page renders a URL as a link only with a safe scheme, so a stored `javascript:` link cannot run. Enforce `maxAttributesBytes`.
- A relation has to be declared on the type's current shape, with both ends in this tenant and readable. Relation to core entities is M5's graph, and out of scope.
- `migrateObjectBatch` is idempotent, ordered by ID, and a bad record counts in `failedCount` and stays where it was. `objectMigrationWorkflow` is already written: keep its shape, or patch and say so.
- Text a person wrote stays in the tables. Events carry IDs.

**Denied and fault tests:** two tenants with the same slug. A member cannot define a type. A record with an undeclared field, the wrong kind, a missing required field, or a class below its type. A reserved slug. Too many fields or indexed fields. A plan removing a field is refused, and records stay. A restricted record is invisible to an organization admin who does not own it, in list, read, filter and relation. Lowering a class is refused. Interrupted migration resumes with no double count. Cross-tenant relation refused. Stale version.

### studio: `AGENT-08`

Guided builder, simulation and publishing review. Acceptance: a nontechnical admin publishes an audited immutable agent version via an evaluated scenario, and it runs. `QA-031`, `QA-032`, `QA-033`, `QA-034`, `TR-026`. ADR-031 D5, D6.

**Owns:**

- `packages/domain/src/agent-draft.ts`, `simulation.ts` (the functions), new tests beside them
- `packages/application/src/product/agent-drafts.ts`, `simulations.ts`, `publish-reviews.ts`
- `packages/workflows/src/simulation-workflow.ts`, `simulation-activities.ts`
- new `apps/web/src/app/o/[organizationId]/studio/page.tsx`, `studio/agents/**`, `studio/reviews/**`, `studio/simulations/**`, `apps/web/src/server/studio-actions.ts`, `apps/web/src/components/studio/**`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/studio/agent-drafts/**`, `studio/simulations/**`, `studio/publish-reviews/**`
- new `tests/integration/studio.test.ts`, `tests/stack/studio.test.ts`, `tests/browser/specs/studio.spec.ts`, `tests/replay/capture-simulation.test.ts`, `tests/replay/simulation-corpus.test.ts`

**Implements:**

```ts
// @ensemus/domain/agent-draft
assessDraft(answers, tools, orgLimits, sha256): DraftAssessment
// @ensemus/domain/simulation
simulateAgent(spec, specSha256, scenario): SimulationReport
// @ensemus/application/agent-drafts
createAgentDraft, createAgentDraftInTx, listAgentDrafts, getAgentDraft, updateAgentDraft, archiveAgentDraft, assessAgentDraft
// @ensemus/application/simulations
requestSimulation, getSimulation, listSimulations, runSimulationStep
// @ensemus/application/publish-reviews
requestPublishReview, listPublishReviews, getPublishReview, decidePublishReview, publishApproved
```

**Calls:** `ToolCatalogPort`, `AgentRegistryPort`, `assertRecentMfa`, `canonicalJson` from `@ensemus/domain/approval`, `simulateProcess` from `@ensemus/domain/process-run`, `compileProcessGraph` from `@ensemus/domain/process-spec`, `publishProcessSpecInTx` from `@ensemus/application/process-specs`, `getProcessDraft`'s row for a process subject, `findBundledWorkflow` from `@ensemus/packs/bundled`. Those are stubs until their slices land, so your tests cover the agent path with `fakePorts`, and a process subject with an injected double or a skipped test that says so.

**Things to get right:**

- **The wizard's steps are the "User model" in `docs/03-intelligence/03-agent-studio-and-skills.md`:** role, outcome, boundaries, knowledge, tools, trigger, spending cap, autonomy, output format, owner. Plain words, with each sensitive tool showing its risk and what approval it needs. Users cannot disable organization policy by choosing a mode, and no mode reads as "autonomous". Multi-step works with no JavaScript, one Server Action a step, saved as a draft.
- **Spec shape:** `docs/specifications/schemas/agent-definition.schema.json` as the M4 plan amends it (section 1.4). `git show m4-foundation:docs/specifications/schemas/agent-definition.schema.json` if that branch has commits by then, and use its real shape. `assessDraft` keeps the answers' free text in `instructions` and nothing else.
- `assessDraft` refuses, never repairs: unknown tool, any `secrets.*`, restricted data, an external write without `act_with_approval`, a limit above org policy, no budget. **`riskLevel` is `elevated` for any external write, delegate tool or confidential data.** A draft with issues saves, with no hash.
- `simulateAgent` imports nothing and has no I/O. Each proposal goes through the same rules the spec states. A scenario that proposes an ungranted tool gets `denied`, and is a failure only if the scenario expected otherwise. Ship at least a `standard` and a `prompt_injection` scenario per tool kind, synthetic. The report says on its face that the model was not called.
- `runSimulationStep` claims `queued` to `running`, computes and stores. Re-running a finished one answers `already_finished`.
- `publishApproved` under `FOR UPDATE` on the draft: hash equal or `SIMULATION_STALE`, review `approved` or `REVIEW_NOT_APPROVED`, recent MFA, then the registry, review, draft, audit and event, in one transaction. A second call changes nothing. Any change to a draft cancels its pending review.
- Page: version history and diff against the published spec through `AgentRegistryPort.list`, a source and permission preview, and a clear statement of what a simulation does not prove. `CAPABILITY_UNAVAILABLE` from the registry leaves the draft as a draft and says publishing needs M4.

**Denied and fault tests:** publish with no simulation, a failed one, one for another hash, or another subject. Edit after simulate, after approval, and between approval and publish. Self-review of elevated, refused by the service and the trigger. A member cannot author. Another tenant's draft, simulation and review. No MFA, old MFA at decide and at publish. Registry failure rolls back the review. Simulation with `email.send` records `would_write_outside`, and no connector, model or outbox event but `simulation.requested` (`QA-034`). Double publish. A report holds no free text from the answers: canary test.

### graph: `AGENT-09`

The visual workflow graph. Acceptance: graphs compile to safe versioned process specs. `QA-035`, `QA-036`, `TR-026`. ADR-031 D7.

**Owns:**

- `packages/domain/src/process-spec.ts` (the function), new `process-spec.test.ts` beside it
- `packages/application/src/product/process-specs.ts`
- new `apps/web/src/app/o/[organizationId]/studio/workflows/**`, `apps/web/src/server/process-draft-actions.ts`, `apps/web/src/components/graph/**`, `apps/web/src/lib/graph-layout.ts`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/studio/process-drafts/**`, `process-specs/**`
- new `tests/unit/web-graph-layout.test.ts`, `tests/integration/process-specs.test.ts`, `tests/browser/specs/graph.spec.ts`

**Implements:**

```ts
// @ensemus/domain/process-spec
compileProcessGraph(graph, context, sha256): CompileResult
// @ensemus/application/process-specs
createProcessDraft, createProcessDraftInTx, listProcessDrafts, getProcessDraft, updateProcessDraft,
publishProcessSpecInTx, listProcessSpecs, getProcessSpec
```

**Calls:** `ToolCatalogPort`, `AgentRegistryPort.list`, `requestSimulation` and the review functions from the studio slice (stubs until it lands), `canonicalJson`.

**Things to get right:**

- `compileProcessGraph` is pure, total and deterministic. **Every path from start to an `external_action` must pass a `human_approval`,** checked by path and not by count, including through branches. It returns every issue it finds, each pointing at a node. Positions never affect the hash: sort before hashing.
- A spec's `label` is a person's text, and it goes no further than the page: never to a prompt, an event or a log. Workflows and Activities use `key`.
- `publishProcessSpecInTx` writes the next `versionNumber` for the key, and a duplicate race is resolved by the unique index, not by reading first. Specs can't be changed: the trigger holds it.
- The editor has **no new dependency**, and works with no JavaScript and a keyboard: a server-rendered SVG from `graph-layout.ts` for the picture, with a list of nodes and connections and ordinary forms to add, connect, configure and remove. The SVG has a text alternative, and the list is the real editor. A small client component may add dragging positions on top. The compile issues sit next to the node they concern and in a summary.
- Show `CAPABILITY_UNAVAILABLE` from the catalog honestly, and keep what can still be drawn.

**Denied and fault tests (T0 as a table, with a property test):** effect with no approval, effect reached by a second path with no approval, cycle, self-edge, two starts, no end, unreachable node, dangling edge, duplicate ID, too many nodes, long label, unknown kind, tool or agent, restricted with an effect, missing setting. Same graph with moved boxes has the same hash. Reordering nodes has the same hash. **T2:** a member cannot author. Another tenant's draft. Stale version. Published spec cannot be updated or deleted by any role. A draft that does not compile cannot reach a review.

### process: `AGENT-13`

The generic process runner and the bundled workflows. Acceptance: each catalog workflow completes with evidence, approvals and measured cost. `QA-046`. ADR-031 D7.

**Owns:**

- `packages/domain/src/process-run.ts`, new `process-run.test.ts` beside it
- `packages/packs/src/bundled/**`
- `packages/application/src/product/process-runs.ts`
- `packages/workflows/src/process-run-workflow.ts`, `process-run-activities.ts`
- new `apps/web/src/app/o/[organizationId]/process-runs/**`, `studio/catalog/**`, `apps/web/src/server/process-run-actions.ts`, `apps/web/src/components/process-runs/**`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/process-runs/**`
- new `tests/integration/process-runs.test.ts`, `tests/integration/bundled-workflows.test.ts`, `tests/stack/bundled-workflows.test.ts`, `tests/browser/specs/process-runs.spec.ts`, `tests/replay/capture-process-run.test.ts`, `tests/replay/process-run-corpus.test.ts`

**Implements:**

```ts
// @ensemus/domain/process-run
nextProcessSteps(spec, statuses): RunDecision
simulateProcess(spec, specSha256, scenario): SimulationReport
// @ensemus/application/process-runs
startProcessRun, installBundledWorkflow, listProcessRuns, getProcessRun, requestStopProcessRun,
advanceProcessRun, finishProcessRun
// @ensemus/packs/bundled
BUNDLED_WORKFLOWS  // the catalog's workflows, as graphs
```

**Calls:** `createWorkUnit`, `proposeExternalActionInTx` from `@ensemus/application`, `AgentRunsPort.startInTx` and `outcome`, `UsageReadPort.costForWorkUnit`, `compileProcessGraph` and `publishProcessSpecInTx` from the graph slice (stubs until it lands, so inject in tests).

**Things to get right:**

- **Catalog workflows** (`docs/01-product/04-capability-catalog.md`): 1. Opportunity won, onboarding plan, approval, project setup, kickoff artifact. 2. Meeting summary, action extraction, owner assignment, due-date tracking, verified completion. 3. Project completion, deliverable review, finance handoff, invoice draft in accounting system. 4. New employee, policy pack, tasks, access request and approval, onboarding checklist. 5. Client status inquiry, evidence gathering, draft update, review and send. Each compiles like a drawn graph. Include number 1 only if `git show m5-foundation` shows no flagship graph by then, and report which. **Number 3's accounting step and number 2's meeting source do not exist: put those in `needs`, the step stops with a code, and the page says what is missing. Nothing pretends they are connected. No invoice is ever finalized.** Number 4 uses no real employment data and no access is actually granted: it files a request and an approval. No catalog workflow gets a special path.
- `advanceProcessRun` under `FOR UPDATE` on the run, and rechecks before each effect that the starter is active, the root is not stopped and the spec hash matches. **Every effect is keyed on (run, step)** so a retried Activity finds what it made: the reference columns are write-once. A step's effect goes through the normal service. An external action still needs M3's approval and shows M3's receipt, which may be `unknown`, and an `unknown` step waits for a person. **An agent task acts as the starter, never as a service,** through the port.
- Keep the workflow's shape: a small loop, `advanceRun`, a signal or timer. Change it only with a patch. `requestStopProcessRun` commits first, then `PROCESS_RUN_STOP_REQUESTED`. Worker dying mid-step repeats and adds no effect.
- `getProcessRun` filters by who can read the root Work Unit. Cost comes from `UsageReadPort`, is null if unavailable, shown as not measured and never as zero, and labelled as an estimate when it is one.
- `CAPABILITY_UNAVAILABLE` from an `agent_task` stops that step with a code. M3 and M4 being unmerged makes `QA-046` provable only at the merge. **Say which parts you proved.**

**Denied and fault tests:** a member cannot start. Someone who cannot read the root gets not found. Another tenant's spec. Starter disabled mid-run stops before the next effect. Stop between steps, and during a wait. Activity repeated at each state adds nothing: row counts. Failed step stops what follows and does not mark the rest done. Restricted spec has no effect step. Simulate each catalog workflow: zero outbox events beyond `simulation.requested`. `nextProcessSteps` tables for every status combination in small specs (T0), plus a property test that it never starts a step before its `after`.

### packs: `AGENT-14`

Pack format and the first department pack. Acceptance: installing a pack grants no permissions automatically; upgrade and rollback tested. `QA-039`, `QA-040`, `TR-026`. ADR-031 D10.

**Owns:**

- `packages/domain/src/pack.ts` (the functions), new `pack.test.ts` beside it
- `packages/packs/src/index.ts`, `packages/packs/src/sales-operations/**`, new `packages/packs/src/sales-operations/index.test.ts`
- `packages/application/src/product/packs.ts`
- new `apps/web/src/app/o/[organizationId]/packs/**`, `apps/web/src/server/pack-actions.ts`, `apps/web/src/components/packs/**`
- new `apps/web/src/app/api/v1/organizations/[organizationId]/packs/**`, `pack-installations/**`
- new `tests/integration/packs.test.ts`, `tests/stack/packs.test.ts`, `tests/browser/specs/packs.spec.ts`

**Implements:**

```ts
// @ensemus/domain/pack
validatePackManifest(manifest), planPackUpgrade(from, to), itemsAllowedBy(manifest, decisions)
// @ensemus/application/packs
listPackCatalog, requestPackInstall, getPackInstallation, decidePackCapability, activatePack, rollbackPack
// @ensemus/packs/sales-operations
salesOperationsPack: readonly PackManifest[]   // version 1.0.0, and a 1.1.0 so upgrade and rollback are real
```

**Calls:** `createObjectTypeInTx` (objects slice), `createAgentDraftInTx` (studio slice), `createProcessDraftInTx` (graph slice), `assertRecentMfa`, `canProduct`. All stubs until they land, so your tests inject doubles, or insert through the tables, and say so.

**Things to get right:**

- **A manifest grants nothing, and no code path reads a capability review to allow anything.** Prove it in a test that activates a pack accepting everything and then shows: no role changed, no agent version exists, no run can start, every agent draft is `editing` with no passed simulation, and no tool can be used. Each capability is decided by name, with no accept-all in code, contract or page.
- `manifestSha256` over the canonical manifest. A catalog version's hash has to match at activation.
- Activate moves `reviewing` to `active` under a lock, with the old one `superseded`, one transaction. A trigger refuses pending decisions, and the service says so first with `PACK_CAPABILITY_UNREVIEWED`. `installed_items` records each item. Repeating activation changes nothing.
- `planPackUpgrade`: a downgrade or a removal is refused, a new capability always comes back for review, whatever was accepted before. A type change goes through `planTypeMigration` rules, and a refused one refuses the upgrade.
- `rollbackPack` is real: reactivates the superseded row, archives unpublished drafts from the newer version, **keeps custom types and their records,** and lists anything already published for a person to decide on. `PACK_NOT_ROLLBACKABLE` with nothing to go back to.
- **The pack:** Sales operations, as the catalog says: pipeline follow-ups, research and client onboarding, with no unsanctioned bulk outreach, so **no bulk tool, and a send only ever through M3's approval.** Synthetic scenarios. Strings make no compliance, legal, price or result claims. Tools it names come through validation like anyone's, and M4 may not have them yet, so a missing tool shows on the review page as unavailable and leaves that item out.
- Page shows each request with its data access and side effects in plain words, as the product doc says extension review must.

**Denied and fault tests:** a member cannot manage packs. Another tenant's installation. Activate with undecided, trigger and service both. No MFA at activate and rollback. An unknown or altered manifest. Upgrade with a new capability comes back. Decline a capability and its items are left out. Rollback keeps records. Crash between steps leaves nothing half-installed, because it is one transaction.

## Wave 2: needs wave 1 merged

### close: `OPS-05`

Sweep and close: accessibility and non-technical UX QA, the spec and contract flip, administration MFA, inbox wording, docs and evidence. Acceptance: role flows keyboard/screenreader tested. `QA-028`. Assistive-technology passes and usability studies are the owner's, and stay open.

**Owns:**

- `docs/specifications/openapi.yaml`, `packages/contracts/generated/**`, `tests/unit/openapi-contract.test.ts`
- new `tests/unit/product-contract.test.ts`, and the M7 stack tests' use of the contract validator
- `apps/web/src/app/o/[organizationId]/inbox/page.tsx`
- Existing Server Actions and routes for `member.manage`, `organization.manage` and `connection.manage`: `apps/web/src/server/work-actions.ts`, `apps/web/src/server/actions.ts` once `mfa` is merged, and the existing `api/v1/**` routes for those actions
- `tests/browser/support/states.ts`, `tests/browser/specs/accessibility.spec.ts`, `keyboard.spec.ts`, `no-javascript.spec.ts`, new `tests/browser/specs/m7-journeys.spec.ts`, new `tests/stack/m7-journeys.test.ts`
- `docs/05-operations/05-container-deployment-runbook.md`, `docs/02-architecture/03-data-model.md`, `docs/06-delivery/06-end-to-end-delivery-plan.md`, new `docs/06-delivery/evidence/M7-report.md`
- `docs/specifications/traceability.csv`, `qa-scenarios.csv`, `implementation-backlog.csv`, `threat-register.csv`
- **`docs/MANIFEST.json`, last of all.** It is regenerated with `node docs/specifications/tools/regenerate-manifest.mjs`

**Things to get right:**

- Remove `x-ensemus-status: planned` from each M7 operation whose route landed, delete its line from the test's list, run `pnpm --filter @ensemus/contracts generate`, and report any operation still planned. Fix mismatches between a route and the spec by asking its slice's owner to change, or by changing the spec if the route is right.
- `assertRecentMfa` on `member.manage`, `organization.manage` and `connection.manage` at the web boundary, which only asks if the tenant turned on `mfa_for_administration`. Existing tests stay true, because that is off by default. Do not edit `tests/integration/*` that were there before M7.
- **Sweep:** every privileged M7 service calls `assertRecentMfa` in the transaction of its effect. Every M7 page has empty, error and denied states and works with no JavaScript. Every M7 route is on the contract validator. Grep for anything fake, invented or claimed without evidence. Report gaps, and fix only what you own.
- `STATES` gains every M7 page for axe. Keyboard paths for each role's main flow: member (outcome, assistants), admin (Studio to publish, packs, objects), owner (onboarding, security). **All written and typechecked, and none run here.**
- **M7-report.md** says what ran, on what, and what did not, and lists the owner-led work plainly. It claims nothing CI has not shown. `qa-scenarios.csv` and the backlog move only on evidence.
- The runbook: the operator commands, SSO setup and its domain check, what the proxy needs for the SAML path, MFA recovery, and a note that restore does not change any of this.

**Report as `docker_later`:** everything in "Docker later" below that is still open.

## Tickets only a person can finish

No slice covers these:

- `UX-24`: usability studies with real participants, covering Home, approvals and non-technical agent setup.
- `OPS-05`, its assistive-technology half: real screen reader passes. The `close` slice writes keyboard and axe coverage only.
- The outside security review of `0401`, D6, D8, D9 and the SAML parser's place in the web tier, before any real provider or second factor is used.

## Docker later

None of this has been built or run. What it will need, for the owner or CI:

- `@ensemus/packs` is a new workspace package, and `@better-auth/sso` a new dependency in the web tier's tree. `Dockerfile.web` and `Dockerfile.worker` copy the whole repo, so they should build unchanged. Check that `next build` bundles `samlify` and `xml-crypto`, and add them to `serverExternalPackages` if not.
- `dist/identity-operator.js` runs from the `migrate` service as the setup code does, with `DATABASE_URL_MIGRATOR`.
- Caddy: the SAML ACS path and `/api/scim/v2/*` go to web. Check body limits against signed assertions.
- `0400` and `0401` join the journal at the final merge, in order, followed by a real run of `tests/integration/product-schema.test.ts` and `tenant-isolation.test.ts`. The upgrade gate needs to pass with them.
- New workflow histories: `simulationWorkflow`, `processRunWorkflow`, `objectMigrationWorkflow`, captured with Temporal running.
- `tests/stack/*` and `tests/browser/specs/*` for every slice. The air-gap gate with an SSO connection present, to show SAML adds no outbound attempt.

## Merge order

Nothing depends on order for compiling, since every signature exists. For tests to pass end to end: mfa, sso, objects, graph, studio, process, packs, composer-onboarding, pulse, surfaces, then close. At the final merge, `apps/web/src/server/product-ports.ts` and `workers/workflow/src/product-ports.ts` get M4's and M5's real ports, and that is the whole join.

## Handoff

Each builder reports: tickets, files, behaviour, commands actually run with results, anything fixed or stubbed left over, what could not run here, and any report under "If you need a change". Finish with `git checkout --detach`.
