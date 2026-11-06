# Structured input provenance: source checkpoint

0211 extends 0208's exhaustive artifact and knowledge inventory to the actual structured records read by a compiler or tool: Work, project and client. The trusted `ArtifactInputInventory` now requires `recordInputs: readonly { kind: 'work_unit' | 'project' | 'client'; id: string; sha256: string }[]`. Missing inventory is not an empty list. Target Work is mandatory. The model-selected citation list cannot supply this authority.

## Publication and serving

The bounded inventory contains at most 1,000 distinct record/hash observations. Multiple historical hashes of the same mutable record are retained. Historical hashes describe actual reads; they are never compared to the current title, objective, status or other mutable body when serving a finished file. Transitive artifact inputs copy every inherited structured record/hash and preserve at least its captured classification.

New generated headers explicitly pin `structured_inventory_complete`. Legacy generated headers remain unknown and closed; the migration does not fabricate their missing inputs. SQL guards require the target Work observation, immutable inventory flag, bounded input append, current named-viewer access and classification protection before publication. Deferred checks catch missing structured bindings. App-level validation runs before object put and again during publication.

Every retained record must still exist, be untombstoned and be readable by the actual named viewer. Service inspection cannot substitute for that viewer. Current source classification exceeding the artifact's independently pinned class closes serving. Lowering a Work or other input does not lower the file's pinned protection. The existing exact system-template path is limited to its explicit authoritative target Work inventory; it does not become a generic empty-knowledge or service serving bypass.

Work uses its existing independent owner/assignment/classification semantics. An unread private client/project parent does not implicitly become Work content. If a compiler actually reads a project or client, the trusted ledger must include that record. A project uses its fresh actual client ACL; if the old parent client was also read, its separately retained identity remains protected after reparenting. No parent hash is invented from a metadata-only authorization dependency.

`knowledge.artifact_readable` adds the structured predicate at its final conjunction while retaining its existing source, attachment, token and pinned-file checks. Artifact lists, download rechecks, grounding, acceptance and artifact-input publication consequently use the same fresh decision. The Work DAL's `loadReadable` / `memberCanRead` parent semantics need no change for this design.

## Metadata and locks

`structured_record_catalog` copies only organization/kind/ID, live class, owner, parent ID and existence. `structured_work_assignments` mirrors only assignment IDs. Neither contains names, objectives, document bodies or status text. The app receives tenant-scoped metadata SELECT and no metadata write grant. Fixed source-table triggers maintain the catalogs under exact-tenant FORCE-RLS migrator policies. Their SECURITY DEFINER functions have fixed targets, `search_path=pg_catalog`, fully qualified references and no PUBLIC EXECUTE. The migration's global metadata backfill policies are removed before runtime.

`artifact_lineage_records` retains flattened historical IDs/hashes/classes with tenant-safe catalog/header keys. App INSERT is constrained by pending-header guards; UPDATE/DELETE remain denied. A narrow SECURITY DEFINER lock function locks one tenant-local metadata row, returns only existence, and grants no body access or mutation. Class/owner/assignment/client-reader changes serialize through those metadata rows.

Publication obtains source locks first, then target Work and viewer membership with NOWAIT, then sorted structured metadata locks with NOWAIT. Project client metadata is an additional authorization lock, not another body read. A changed project dependency causes a version conflict instead of a later unknown lock acquisition. Binding append/count serializes on the header with NOWAIT. No source/body lock is acquired after structured metadata locks. Contention is a refusal, not an automatic side-effect replay.

## Erasure

The additive factory result `StructuredRecordPurge extends DerivedArtifactPurge` exposes `purgeRecord(context,{kind,id,limit})` and `confirmRecordInTx(tx,context,{kind,id})`. The existing source port is unchanged. Both use the same blocking, tombstone/outbox, retained writer token, lifecycle callback and independent physical-proof path. Only a deleted catalog record or a durable record tombstone can authorize whole-derived-file erasure; one viewer losing access only closes that viewer's serving.

Missing/held/unconfirmed/lying lifecycle adapters do not complete erasure. The factory independently checks actual object absence, matching token/generation, dead file metadata, purged blob lifecycle and settled/fenced writer state before writing physical completion. Unknown legacy structured inventories remain in the conservative affected set. Record purges use the non-content reason code `STRUCTURED_INPUT_PURGED`.

The new retained edges use 0208's `certify_artifact_erasure` positive receipt and restricted eraser row guard. Catalog rows cannot be deleted while their record is still live (`23503`, permitting FK-order retry), or while retained lineage still references them. Ordinary runtime callers cannot erase these rows. Parent must compose the new relations into 0999's existing restricted eraser discovery and append-only accommodation, with the existing exact `certify_artifact_erasure(uuid,boolean)` EXECUTE grant if that role is provisioned after 0208. No trigger disabling, BYPASSRLS or broad reader authority is added here.

## Authored coverage and actual validation

`structured-inputs.test.ts` covers absent/invalid/unbounded inventories, target Work requirements, exact deduplication and legitimate rereads. Fourteen additional real-role cases in `knowledge-artifact-provenance.test.ts` cover mandatory inventories, historical hashes with mutable bodies, OTHER Work stale assignment and service inspection, post-get and mid-put revocation, class elevation, retained actual private parents, unread-parent independence, transitive records, foreign IDs, malformed hashes, deferred SQL omission, metadata/lineage mutation denial, lock contention, record deletion, held/lying/missing lifecycle adapters and positive physical proof. The existing restricted Work-lowering regression remains.

These integration cases and migration are authored, **not executed**. In the parent-released serialized light slot, the following commands passed:

- Owned TypeScript Prettier write and `eslint --max-warnings 0` across the provenance implementation, inventory unit, schema and two integration fixtures.
- `pnpm exec vitest run --project unit packages/application/src/knowledge/structured-inputs.test.ts --maxWorkers=1`: **1 file / 6 tests passed**, 1.03 seconds.
- `pnpm exec tsc --noEmit -p packages/database/tsconfig.json`, then `packages/application/tsconfig.json`, then `tests/tsconfig.json`: **all passed**, sequentially.
- `git diff --check`: **passed**.

No Docker, database, provider, browser or load command has been run for this change. Markdown evidence is excluded by this repository's Prettier ignore configuration; no SQL formatter/parser result is claimed.

## Required join gates

- Root owns durable actual M4 compiler/tool read-ledger collection (including `CompiledContext.sources` Work IDs and OTHER Work reads), exact run/template/output validation and runtime adapter binding. These are unbound here. Parent/client records belong in that ledger only when actually read/output. Existing callers missing the required list must fail closed.
- Root must register/review/apply 0211 with the actual migrator/app/agent roles, generate schema snapshots and compose explicit narrow agent metadata/EXECUTE grants if needed. No role grants for an absent branch-specific agent role are invented here.
- Run all artifact/provenance/verification/purge/onboarding/restore cases with real roles. Include upgrade from legacy incomplete generated rows, current client/project RLS nonrecursion, concurrent membership revocation, metadata deletion and contention ordering.
- Joined restricted eraser regression requires the real M8 `readyToErase` / `beginErasure` helpers absent from this M5 branch. With erasure open, DELETE of `artifact_lineage_records` before positive proof must reject with `EN118`; ordinary app DELETE remains `42501`. After the actual lifecycle metadata deletion, explicit test-double byte/fence proof, object absence, purged lifecycle and factory physical receipt, restricted eraser DELETE may remove record edges before header/catalog, followed by dead structured metadata. Test held/active/unknown inputs and cross-tenant canaries. No invented erasure-open policy or fixture bypass substitutes for those helpers.

This is a privacy implementation checkpoint, not a milestone, runtime or production acceptance claim.
