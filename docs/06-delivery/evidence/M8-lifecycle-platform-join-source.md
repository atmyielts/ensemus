# M8 lifecycle platform join — source checkpoint

Date: 2026-11-08. This checkpoint composes the preserved SaaS foundation `ca62c8e` onto platform `83258d8` in `codex/m8-lifecycle-platform-join`. It is source implementation, not milestone acceptance. No SQL, unit/type/lint/build/browser/provider commands have been run for this checkpoint while the root's serialized gates are active.

## Composition

All 31 original merge conflicts were resolved semantically. The current native interactive identity, required SSO, restore gate, agent/delegated actor and run bindings, current M3 revoke/receipt behavior, M4/M5 provenance and writer guards, M6 versioned inventories and shared grouped/mobile navigation were retained. SaaS adds account surfaces and standing without reverting those authorities. The worker dispatcher and workflow exports contain both registries; ending tenant schedules also ends the Knowledge sweep.

Workspace manifest/importer additions retain existing pinned resolutions. No external dependency version was changed. OpenAPI source includes the new SaaS paths, while the current root generated contracts were preserved pending the actual generator slot. No migration journal or snapshot was changed. All 050x and0999 SQL remains unregistered/unapplied here.

## Actual lifecycle implementation

- `0508_object_deletion_authority.sql` adds private exact deletion claims. Actual SQL pins object key/hash, writer token/generation and tenant before an object operation. The org row serializes hold placement and deletion admission. Any active organization hold conservatively blocks these deletions; an already-admitted unresolved deletion makes a new hold refuse with a fixed explanation. A new hold never promises to protect bytes already committed to deletion.
- The transport uses a separate S3 client with exactly one DELETE attempt. A fulfilled DELETE is recorded before a separate absence check. A rejected/ambiguous request remains unresolved. Later HEAD, successful retry, elapsed time, cancellation or worker restart cannot erase that debt. A known terminal DELETE may retry only its independent absence check.
- Only settled exact writers can admit generated/archive cleanup. Agent outputs require their matching `ai.run_output_writes` settlement. Unknown/fenced legacy writers are not promoted. Ordinary files require a real retained catalog and completed publication; orphan uploading rows without completion remain unconfirmed.
- Archive and generated positive physical-receipt triggers independently require the actual exact claim. Source-purge completion and the completed-job fast path inspect retained operation/restore debt. M4 input/child/transcript and M5 provenance checks remain independent.
- External restore-writer uncertainty has a separate retained debt. It is not an application writer fence. A generated restore-pending marker or a lost archive physical receipt stays nonqualifying until real restore/provider quiescence authority exists. There is no app/eraser debt-clearing grant.
- The actual Knowledge worker supplies both lifecycle ports to the existing required composite. Its ordinary raw Knowledge `delete` path refuses until its own hold/operation admission joins; it does not bypass the new authority. The admitted generated/archive adapters retain the underlying transport privately.
- The restore command binds actual archive storage auditing and derived-file cleanup. Unknown operation/restore debt remains attention. Missing M4 and raw Knowledge recovery bindings continue to keep the full restore gate closed.

## Native offboarding and restricted erasure

Offboarding birth requires the native in-process session handoff and the current `organization.manage` policy. SQL rechecks native live-session/required-SSO authority and records a private durable admission. The historical session/person IDs have no live-session/member FK and grant no new authority after logout. Old requests without an admission are refused rather than backfilled as trusted.

Each admitted offboarding owns one actual M4 organization stop. Release addresses only that mapping and requires actual cancellation or a reported erasure. It cannot clear operator, budget or customer stop reasons. Manual release through the existing M4 path cannot release a live offboarding stop.

0501's role-name-only append exception was removed.0508 admits restricted eraser DELETE only for an explicit existing table list plus real current tenant/phase and physical receipts. Original row guards still run. Additional row backstops protect archive/catalog/header deletion. The restricted eraser takes the same tenant barrier as hold placement and verifies authority before trusting zero.

0999 remains last. Its migrator-only installer generates a fixed CASE counts projection over the reviewed table inventory. Runtime contains no dynamic SQL or free identifier, gets no app private-body grant, requires an actual native-admitted offboarding/phase, and saves/restores its private metadata scope on success and error. Unknown tables, missing FORCE RLS or incomplete eraser reach refuse installation. Counts are bounded to safe integers. Counts never substitute for physical provider/writer proof.

The same reviewed installation adds a tenant-erasure INSERT fence: after zero counts, a late worker cannot recreate a private content row. New upload admission is separately blocked once a tenant is closed. Existing UPDATE cannot resurrect an already removed row; actual byte writers retain their separate pre-put authority.

The operator runs bounded generated/ordinary and inert-archive cleanup, then audits the actual tenant storage prefix before row erasure. `finishErasure` requires the concrete object proof port outside its SQL transaction and rechecks receipts/counts inside. A reported-job retry revalidates current data rather than trusting the stored report alone.

## Deliberate refusals still open

These are incomplete product paths, not accepted limitations of a finished platform:

- Raw Knowledge object deletion still needs exact actual hold/transport admission. The Knowledge worker refuses the unqualified deletion path; source purge may therefore remain incomplete. Whole-tenant positive readiness conservatively refuses a remaining Knowledge source inventory until that lifecycle joins.
- Existing M6 export writers/deletes have no matching new exact operation certificate. Export header inventory conservatively refuses positive tenant erasure, even if an old purge timestamp exists. Export expiry timestamps or successful later HEAD cannot qualify unknown older operations.
- Unknown application writers, ambiguous DELETE and uncertain external restore writers have no implemented provider/transport fence port. They stay unconfirmed; no fake reset button or age-based cleanup exists.
- M4 private transcript and0414/0417 child Work/title proof remains owned by its actual runtime; no archive count clears it. New0417/0418 tables are explicit operational exclusions, not portable execution authority.
- M3 connection wind-down, non-offboarding standing stops, billing usage/provider bindings and all other previously refusing foundation ports need their exact current implementations. This checkpoint does not claim those sibling paths are complete.
- Current retained manual M4 switches may reference membership FKs; actual tenant-erasure ordering/retained identity disposition requires joined real-role review. The offboarding-owned stop itself uses no fake human identity or live membership FK.

## Root join seams

New private retained lifecycle tables: `object_deletion_claims`, `object_restore_debts`, `offboarding_admissions`, `offboarding_agent_stops`. All have forced tenant RLS, no app body/table grant, and no eraser mutation grant. New schema fields are limited to the new SaaS tables; existing M5 schema was preserved.

New transaction default-clear keys: `app.payment_customer_hash`, `lifecycle.erasure_count_org`. The latter is additionally restored inside the fixed SQL count function. The root transaction facade must union these with all current keys, including its newer `objects.soft_delete_record_id`. No current root native/restore/agent bindings should be replaced with an older file.

The unpublished /3 inventory adds explicit SaaS lifecycle/financial/support/operational exclusions and reserves `ai.run_authority_checkpoints`, `ai.run_read_authorities`, `studio.process_run_intents`, `studio.process_step_births`. Published /1 and/2 meanings were not changed.

0508 requires current0208/0210/0214, native0404/0410/0412, archive0415 and0500-0507 source. The root must union newer0417/0418 authority independently and register0999 after every actual contributing schema. No migrations/snapshots should be copied from the older foundation wholesale.

## Pending validation checklist

1. If needed, cached-only `pnpm install --offline --frozen-lockfile --ignore-scripts`; no resolution updates.
2. Actual contracts generator, then explicit owned-file formatting and lint. Do not format unrelated root WIP.
3. Single-worker focused unit batch: `packages/application/src/saas/object-deletion.test.ts`, `tests/unit/knowledge-purge-ports.test.ts`, existing relevant SaaS foundation/standing/retention/offboarding and storage tests. These have not run here.
4. Sequential database, storage, contracts, domain, SaaS, application, tests, actual worker and web types. These have not run here.
5. Independent SQL/source review, then actual fresh migration/grant/constraint inventory through0508 and0999. Unknown inventory must fail visibly before any acceptance case.
6. Real app/auth/restricted-role tests: hold-before-claim, admitted/unknown claim-before-hold, genuine pg lock waiter, foreign tenant, no private SELECT, native admission/legacy refusal, duplicate/replayed transport, known terminal HEAD outage, source-purge stale completion, restore debt, eraser pre/post-proof denial and stale-body rebirth refusal. New `saas-object-deletion.test.ts` is authored and UNRUN; memory storage is an explicit test double.
7. Actual storage/Temporal/HTTP/browser/offline/upgrade/restore gates and independent provider quiescence proof. No current source test or fake storage result proves external physical deletion or production readiness.
