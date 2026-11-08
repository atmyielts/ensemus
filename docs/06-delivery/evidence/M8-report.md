# M8 implementation evidence — open

## Source checkpoint: 2026-11-06 20:36 UTC

Recorded on 2026-11-07 at 01:36 Asia/Tashkent, in the isolated M8 worktree `wf_a7be6249-b12-1`, based on `0c71766`. Changes are uncommitted. This checkpoint is source verification, not M8 acceptance or production readiness.

The catalog, subscriptions, prepaid credits, invoicing, payments, retention, and offboarding implementations are present. Support services, desk commands, consent records, account pages and API routes are present; remaining support tests are still being written. Operations and load work remain open. Cross-milestone runtime bindings and integrated database/runtime verification remain open.

### Commands actually run

| Check | Actual result |
|---|---|
| Focused Vitest unit run, `--project unit --maxWorkers 1`, on 23 owned test files | **23 files passed, 228 tests passed**, final run 10.86 seconds |
| Serial typechecks: `@ensemus/saas`, `@ensemus/database`, `@ensemus/application`, `@ensemus/connectors`, `@ensemus/workflows`, `@ensemus/worker` | Passed; application and worker were rerun after the fixes below |
| `pnpm --filter @ensemus/web typecheck` | Passed, including Next route type generation |
| `pnpm --filter @ensemus/tests typecheck` | Passed after correcting a test-only `updateWorkUnit` call signature |
| ESLint, all changed/new TypeScript and TSX paths, `--max-warnings 0` | Passed |
| Prettier `--check`, all changed/new TypeScript and TSX paths | Passed |
| `git diff --check` | Passed |

The focused unit files cover catalog, money, entitlements, credits, invoices, tax, payment decisions, lifecycle cutoff rules, offboarding decisions, support consent/coverage rules, subscription/invoice authorization, usage reading, retention cursor/authority boundaries, payment connector/runtime behavior, billing/payment/offboarding orchestration, tax Activities, and catalog/tenant/erase command validation.

The first run passed 220 tests across 22 files and failed to load the erase command suite because the worker has no direct Zod dependency. The worker typecheck also exposed direct Drizzle imports in the desk command. Schemas and coverage SQL were moved into their owning application modules; no dependency, package manifest or lockfile was changed. The final 23-file run above passed. The final test typecheck also corrected one test-only argument mismatch; scoped lint removed one unused test import.

### Written but not executed

- Actual PostgreSQL role, RLS, immutable-row, cross-tenant, credit correction, late-commit, payment/webhook, collection, hold, retention, erasure and support tests. These were typechecked only.
- Stack API and browser scenarios. Stack scenarios were typechecked only. The separate browser-test project has not been checked for the latest added browser files in this checkpoint.
- Temporal capture/replay scenarios for billing, payment, retention and offboarding. Histories have not been captured; their corpus tests explicitly skip absent histories. The M3 connector conformance integration test also remains owed after composition with the real M3 SDK.
- SQL migrations 0503, 0504 and 0505. No migration was applied and the migration journal was not changed. Security SQL requires human review before application.
- No Docker, image build, full suite, integration, stack, browser execution, provider call, deployment or production acceptance was performed by the M8 author in this checkpoint.

### Integration boundaries still owed

- Bind the trusted existing-person provisioning/bootstrap capability and its hash-only one-time invitation consumer. Missing capability refuses provisioning.
- Bind M4 entitlement, usage/correction, provider-cost currency and halt services. Credit estimates and provider currency must remain explicit; there is no FX or credit-to-money conversion.
- Bind the configured operator payment connection and processor to verified M3 webhook routing. A tenant-created endpoint is not billing processor evidence. Supply the reviewed payment gateway HTTP transport explicitly; no processor or tax provider is selected by this implementation.
- Bind the **offboarding-owned** halt/release capability in worker ports, `runtime.offboardingAgents` on the web side, and the erase command. Cancellation must preserve budget, provider, operator and other halts. Bind trusted M3 connection revocation and all scheduled-work wind-down ports.
- Resume offboarding with safe workflow-ID reuse after a completed waiting run. An effect workflow's permanent start-once policy is unsuitable for `OFFBOARDING_RESUMED`.
- Compose the scoped artifact marking/deletion extraction with newer M4/M5 artifact behavior. Retention requires an exact transaction-local expiry proof; normal manual deletion guards remain. Erasure marks records before restricted-role row deletion and waits for durable ledger and purge receipts.
- Review 0505's narrow secret metadata policy: only `organization_id` is selectable by the application, only under the tenant-bound service marker with no user ID. It grants no secret ID, ciphertext or key columns, and does not depend on surviving memberships or standing. Actual-role tests for these boundaries remain unexecuted.
- Support audits retain their role boundary: desk messages and append-only support journal, operator actions plus support journal, and governance audit plus support journal for customer decisions. No support authorization grants a path to customer content.

There is no claimed milestone closure. Later source changes need fresh focused verification; this entry records only the checks above.

## Changes between source checkpoints

The following source was added after the first passing checkpoint and is covered by the later source verification recorded below. Actual database/runtime gates remain open.

- Support: remaining desk command, API and no-JavaScript browser tests are written. The two-signature consent timestamps now clamp the second trusted timestamp to the first signature, on both sides; no support-content capability was added.
- Operations (`OPS-04`, `OPS-06`, `OPS-23`, `OPS-25`): status derivation, explicit public database projections, private role-checked incident/drill/disclosure services, strict operator CLI, public dynamic status and security pages, and denied-role/private-column/stack/browser tests are written. Runtime operator attribution is required and never substituted for the effective-role check. Disclosure references stay private; no external contact, legal protection, notification deadline or completed drill is invented.
- Isolated migration `0506_saas_public_projections.sql` narrows application SELECT to public incident-update columns and published coverage fields. Operator and support grants remain unchanged. It was not applied; its actual-role denial tests remain unexecuted. Migrations 0503–0506 and the final eraser reach migration require reviewed integration; no journal was edited here.
- Portable alert/dashboard files, all twelve required runbooks, incident/drill process, disclosure process and unpublished security.txt template are written. Sources distinguish existing safe log events from unavailable projections. Monitoring product, adapters, alert delivery and named human exercises remain owed. Numeric alert boundaries are tuning proposals, not agreed objectives.
- Load (`OPS-01`, `PLAT-17`): dependency-free explicit-target/generated-account harness, parameter profiles, A–L scenario protocol, percentile/failure/fairness tests and portable scaling plans are written. Only baseline business API reads are directly implemented; B–L require reviewed environment-specific controls and actual observations, and refuse without them. No load/fault/scaling run occurred. Server event-loop/queue/ledger-cost exporters and scenario controls remain owed. Harness event-loop delay is explicitly the load process, not the server.
- Scaling lists web, platform worker, isolated M4 agent worker (`ensemus-agent`), connector worker and dispatcher separately. Targets and replica budgets are unconfigured. Agent/connector runtime concurrency bindings are missing and are root integration work; no proposed template value is an enforced cap.
- The erasure CLI now reserves the private report path before database access or irreversible mutation, refuses an existing path, and records pending/failed local evidence without overwriting prior reports. Its focused denied-existing-path unit regression passed in the later checkpoint.

The joined M5 0208 erasure proof regression also remains owed after composition: restricted eraser deletion of lineage/source/package/input/catalog metadata must fail with `EN118` before positive metadata, byte-absence and writer-fence proof, then succeed in FK order after the actual derived-artifact purge. M8's existing eraser never disables triggers or bypasses RLS; the existing 0501 append-only DELETE exception is limited to `ensemus_eraser`, with tenant erasing/no-hold RLS. M5 adds the independent physical-proof guard. This standalone M8 worktree has no M5 knowledge modules/helpers, so the joined regression must be authored or applied after those sources join. Root must include the narrow `knowledge.certify_artifact_erasure(uuid,boolean)` EXECUTE grant for the eraser when role provisioning occurs after 0208; no app/PUBLIC receipt-write grant is authorized.

## Latest source checkpoint: 2026-11-06 21:14 UTC

Recorded on 2026-11-07 at 02:14 Asia/Tashkent in the same uncommitted M8 worktree. This supersedes the earlier source counts, without claiming runtime acceptance.

| Check actually executed | Actual result |
|---|---|
| Focused `pnpm exec vitest run --project unit --maxWorkers 1` on the 30 files listed below | **30 files passed, 270 tests passed**, final fresh run **15.68 seconds** |
| Sequential `pnpm --filter <package> typecheck`: `@ensemus/saas`, `@ensemus/application`, `@ensemus/worker`, `@ensemus/web`, `@ensemus/tests`, `@ensemus/browser-tests` | All passed after the corrections below; web includes Next route type generation |
| Scoped `node node_modules/eslint/bin/eslint.js --max-warnings 0 <changed/new TS/TSX/MJS paths>` | Passed |
| Scoped Prettier `--write` then `--check` on changed/new TS/TSX/MJS/Markdown/YAML/JSON paths | Passed |
| `git diff --check` | Passed |

The focused file set was:

```text
packages/saas/src/{catalog,money,entitlements,credits,invoice,tax,payment,lifecycle,offboarding,support,operations}.test.ts
packages/application/src/saas/{subscriptions,usage-reader,invoices,retention,operator-incidents,status}.test.ts
packages/connectors/src/payment/{index,runtime}.test.ts
packages/workflows/src/{billing-cycle-step,tax-activities,payment-step,offboarding-step}.test.ts
workers/workflow/src/ops-{catalog,tenant,erase,desk,incident}.test.ts
tests/unit/{observability-rules,load-harness}.test.ts
```

The first unit run in this slot passed 269 tests and failed one test that assumed `apps/web/public` existed. The test now checks the exact security.txt/route paths without assuming a directory, and the final full focused run passed. Typechecking caught an incompatible refined-schema wire-date replacement and exact-optional-property joins in the incident CLI. Date parsing now reuses the shared completion refinement on the explicit wire shape; CLI inputs project only present optional fields. Application/worker and all remaining named typechecks then passed. Scoped lint/format also passed.

The new loopback-only fixture seeder is source-only. It creates generated actors/memberships and Work Units through existing forms/API when explicitly invoked, reserves a private fixture path, records partial state on refusal and does not seed documents/clients/projects by assertion. This slot imported its parser only for denied-input unit cases. **No fixture seeding, load request, controlled fault, autoscaling, provider call, Docker command, build/install, database migration, integration/stack/browser execution or Temporal capture occurred.** Browser and database tests were typechecked only. Previously named source packages not rerun in this slot retain their earlier checkpoint evidence, not a new result.

Additional composition review: the final deletion proof independently counts all current rows, but `rowsRemoved` currently reports durable baseline deltas. Account support writes can still arrive between baseline and restricted deletion while standing is offboarding. Root must either fence new nonretained account content once erasing starts or add durable deletion-progress evidence before describing that number as an exact lifetime count. Final zero-row proof and retained exceptions remain mandatory. This review concern did not change the checked source.

## Erasure write-fence follow-up: 2026-11-06 21:25 UTC

Root selected a write fence. Customer support open/reply/close now refuses after erasing starts, while holding the existing organization lock. Account pages retain readable conversations and show an explicit read-only state. Retained billing, lifecycle, consent and operator audit records were not blanket-blocked. Root still owns the joined M5 writer fence and appropriate suppression/fencing of shared nonretained notification/idempotency writes; `rowsRemoved` is described as baseline deltas, not exact lifetime removals.

Approved isolated `0507_saas_support_erasure_fence.sql` adds a fixed-target trigger on support tickets/messages INSERT/UPDATE. It changes no app/desk grants. The actual `ensemus_migrator` is LOGIN/NOBYPASSRLS, so its control policies are restricted to trigger depth plus the exact temporary organization GUC; org UPDATE has `WITH CHECK(false)` and exists only to make row-lock visibility possible. The function checks its actual effective owner, relation/schema/op whitelist and exact row tenant, reads only organization lifecycle and actual offboarding states, refuses unknown/deleted/erasing authority, restores the private GUC, and leaves app tenant/user bindings untouched. PUBLIC has no EXECUTE. There is no pre-lock helper, global owner-read policy or new desk content-read authority.

The trigger locks org with `NOWAIT`, avoiding a wait cycle when a desk UPDATE already holds the ticket row and erasure owns org. Only explicit fence contention `EN807` maps to `SupportContentBusy` with a safe retryable message; desk CLI returns 1, with no automatic replay. Other PostgreSQL errors are preserved. Actual-role erasing denial, direct SQL, cross-org FK, contention and GUC-restoration tests are written but **unexecuted**.

Follow-up checks actually run: focused unit `packages/application/src/saas/support-desk.test.ts` plus `workers/workflow/src/ops-desk.test.ts`, **2 files / 14 tests passed in 1.94 seconds**; sequential application, worker, web (including Next typegen), and tests typechecks passed; scoped lint/format and `git diff --check` passed. These are follow-up results, not an additive claim of another full 30-file run. No database, load, seeding, Docker, provider or browser execution occurred. Migration 0507 is unjournaled and unapplied, pending reviewed integrated database acceptance.
