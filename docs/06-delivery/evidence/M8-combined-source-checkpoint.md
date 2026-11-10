# Combined source checkpoint

The current source joins are `15c061a` (delegated material authority), `579a1df` (auth restore) and
`be90f8a` (native payment authority), following the separate qualified interface/authentication
checkpoint `d4ac957` and plain-language copy follow-up `6a913c6`.

At `be90f8a`, all workspace type checks passed sequentially. The full unit suite passed **5,742
tests**, with two explicit skips across **259 files**. Logs are
`.local-m8-combined-source-types.log` and `.local-m8-combined-source-units.log`. The worker's existing
auth workspace edge was linked with a filtered offline/frozen/ignore-scripts install; resolution
was skipped and no lockfile change was produced by that local repair.

These are combined source checks, not database, restore, payment-provider or production evidence.
The live disposable database still has the earlier **68 registered migrations /198 installed
tables**. The previous **84-case database** and **57-case production-browser** results belong to the
earlier registered composition; they have not rerun against the new joined schema. Do not start the
new native runtime against that old schema: missing restore admission must refuse rather than act
as a ready default. The completed task-owned UI server/Compose project has been cleaned up.

## SQL qualification work remains

The material authority chain contributes eleven new tables; payment contributes five; auth restore
uses protected native verification state rather than adding a table. Actual installation is expected
to reach214 tables before future raw-object work, but that count is not yet an installed audit.
Active portability inventory and migration journal remain unchanged while registration
is deferred. Each new table needs its exact operational portability disposition, constraints and
reviewed eraser order; exclusion from a portable business archive is not physical erasure approval.

The reviewed candidate dependency order is existing68, early protected material-generation anchor,
0417,0419,0510,0514,0515,0422,0512, and finally reviewed0999 after contributing schemas/grants. Root
extracted the org-only anchor into unregistered `0517_material_restore_anchor.sql`; its journal
position, not numeric filename order, must be early. No registered SQL checksum was changed.
0516 raw-source authority and0513 prepaid admission remain separate unfinished joins.

The pre-SQL role audit found two concrete restore blockers: native auth cannot take a table-level
strong lock on the column-granted setup-token table, and an invoker trigger's cross-schema regclass
constants require schema reach the native auth/eraser roles intentionally lack. A bounded follow-up
adds an exact-generation lock-only helper and metadata tuple target checks. Root commits `0eb649c`
and `8570d6b` include that follow-up. Its isolated source gate passed196 focused tests across11files
and five type scopes; actual-role qualification remains unrun.

## Actual rollback-only SQL trial

The task-owned PostgreSQL17 instance was positively identified by its exclusive Compose project,
container and loopback55437 binding. An actual-migrator transaction executed the candidate files in
the order above and always rolled back. Trial1 reached0512, then failed because the installation
lacked native `public.digest`. Read-only inspection confirmed the pinned image supplies trusted
pgcrypto1.3 and the actual migrator owns database/public creation rights. Unregistered0512 now
installs the real trusted extension and requires exact digest/random functions to be extension
members in `public`; no replacement primitive, runtime role or broader grant was added.

Trial2 compiled all eight candidate migration files through0512. Final0999 then refused with
`EN850/ERASURE_METADATA_INVENTORY_UNREVIEWED`, preserving the closed inventory check. The transaction
rolled back and the installed table count remained198. These trials are not migration registration,
role acceptance, erasure completion or restore evidence. Logs are
`.local-m8-sql-rollback-trial-1.log` and `.local-m8-sql-rollback-trial-2.log`. Trial3 added a bounded
pre-final-projection count:214 actual candidate tables, with198 after rollback, and the same final
closed-inventory refusal. Its log is `.local-m8-sql-rollback-trial-3.log`.

## Truthful schema metadata

Pinned Kit0.31.11 selects its predecessor by lexical snapshot filename, which previously selected
old0511 rather than the actual0421 tip. Fourteen existing snapshot files are renamed to their
originating journal indices; every file content/hash, snapshot ID/parent, all68 registered SQL
hashes and the journal content are preserved. The current tip is therefore `0067_snapshot.json`.
The bounded proof is `.local/m8-snapshot-rename-proof.json`. An isolated generation from the actual
combined model produced212 modeled tables, correctly descended from that tip. Its SQL was not
applied; no generated DROP/RENAME/type-alteration was accepted as custom authority SQL. Registration
and a final actual installed-model audit remain open.

## Operator erasure composition follow-up

The operator command now commits the genuine current-generation0515 material seal before it
deletes any supporting table. A missing/refused seal reports `MATERIAL_PURGE_PENDING` and starts
no row deletion. Thirteen command composition/preflight unit cases across two files pass, including
physical-proof refusal, native-seal refusal and failed seal transaction. The first added test-file
collection failed because its database module double omitted existing schema exports; preserving
actual exports fixed that isolated test harness issue. This is orchestration evidence, not a real
seal/erasure acceptance claim.

The eraser adapter binds its exact native login and canonical service transaction, clearing pooled
private selectors. It deletes delegated refs, all tenant delegated receipts and birth witnesses in
one transaction because their genuine FKs are reciprocal. A23503 failure, including at outer COMMIT,
rolls back the entire group and recounts under fresh erasure authority. It disables no constraint or
proof guard. Database and worker type checks and scoped lint pass. Actual positive native-role
group deletion, dirty-session isolation, holds and crash/resume remain unrun.

The final root full unit run after these source follow-ups passed **5,751 tests with two skips
across261files**,172.49seconds with one worker. Log:
`.local-m8-erasure-followup-full-units.log`. This later result includes the restore privilege fixes
and operator seal composition; it does not turn the rollback-only SQL trial into a role/restore gate.

Review also found retained payment proofs pinning erasable credentials and connection/webhook
content. An explicit historical-reference disposition and fixed closed-inventory extension are
being authored separately in0518; no financial proof was deleted and no credential-retention
exemption was added. New0423 typed-record purge start/recovery and0516 raw-object authority are
separate active source work, not registered or accepted runtime behavior.

Missing raw-object/writer proof, actual typed-record dispatch/restart, SaaS erasure sealing, genuine
restore/cooldown/review/recovery, post-restore payment reconciliation, both prepaid inference paths,
actual Temporal execution, independent reviews and hosted/provider acceptance remain open. Cloud
inference stays refused and provider configuration is not invented.
