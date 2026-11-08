# Archive lifecycle composition proposal

2026-11-08. Read-only review of root `148fd8a` plus its current source changes, preserved M8 `ca62c8e`, and0415 `27d754c` plus the separately authored SQL backstop followup. This is a concrete composition plan, not executed runtime evidence. No shared M5 purge, runtime factory, restore registry or M8 erasure file was edited during this review.

## Current seams

`workers/workflow/src/knowledge-worker.ts` constructs `deps` with database, store and ingestion only. `createKnowledgeRuntimePorts` in `knowledge-ports.ts` currently returns ingestion. `KnowledgeWorkerDeps.derivedArtifacts` is optional; `createKnowledgePurgeActivities` forwards it, and `runSourcePurge` correctly refuses completion when it is absent. No production `DerivedArtifactLifecycle` implementation was found in the reviewed root source.

`createDerivedArtifactPurge` in `packages/application/src/knowledge/artifact-provenance.ts` implements source and structured-record cleanup, but only integration tests currently invoke its structured-record port. There is no production `purgeRecord` caller in the reviewed root. Its accepted kinds are Work/project/client; custom-record source selection still needs explicit composition with0407's current metadata authority. Archive cleanup independently supports `object_record` and does not pretend this implements generated-artifact custom-record lineage.

`workers/workflow/src/restore-contributors.ts` exports `createRestoreContributors()` without recovery bindings. This honestly refuses qualification. `restore-reconcile.ts` creates the actual store and Temporal probe but currently passes that unbound registry. `purgeDueBlobs` deliberately excludes generated lineage and never scans `archive-quarantine/`; it must not be reused as proof that private archive bytes are gone.

Preserved M8's implementation is actually `packages/application/src/saas/offboarding.ts`, not an `erasure.ts` module. The restricted deletion loop is `packages/database/src/eraser.ts`, with operator orchestration in `workers/workflow/src/ops-erase.ts`. Its0999 migration calls `lifecycle.extend_eraser_reach()` over the actual final schema. These files are not yet part of the reviewed root composition.

## Required source-purge composition

Add a narrow factory, for example a new `knowledge/purge-composition.ts`, that requires both the actual generated-artifact and archive-file ports. Wire its result into `KnowledgeWorkerDeps.derivedArtifacts` in the knowledge worker. Do not supply an empty-success adapter when either lifecycle authority is absent.

The composite `purgeSource` must run both contributors outside source-locked SQL, validate every nonnegative safe-integer counter and boolean result, and return confirmation only when both explicitly confirmed with zero remaining/held. Their physical namespaces are disjoint, so their durable cumulative removed counts can be summed without retry double counting. Either expose separate archive counters for clearer product reporting, or explicitly document that the existing artifact counter now counts both categories. Do not increment totals from this-call deletion counts.

The composite `confirmInTx` must query both inventories in the caller's actual final source-locked transaction. It must be used both at normal completion and the completed-job fast path in `knowledge/purge.ts`. The new0415 SQL completion backstop independently refuses any private archive header without full physical/closed/quiescent/not-held proof; it does not replace the existing transcript proof, generated-file proof or0414 child-input guard. Normalize its fixed `EN415` denial to `ARTIFACT_PURGE_UNCONFIRMED` in the shared source service when root owns that edit, rather than exposing SQL text.

The current per-contributor limit is25. Calling two contributors at25 means at most50 selected headers, not25 globally. Choose and document that explicit bound or allocate a durable fair budget; silently giving all budget to one held category can starve the other. Final confirmation remains mandatory after every bounded attempt.

## Actual holds and writers

An archive's sourceArtifactId is an archive identity with no live Work/artifact link. Calling `lifecycle.target_is_held(org,'artifact',sourceArtifactId,...)` would miss Work/project/client holds. Unknown possible inputs require conservatively honoring **any active tenant legal hold**. A missing hold authority is unconfirmed, not “no hold.”

The actual adapter must serialize its delete admission with M8's hold-placement authority, bind the exact retained key/token, prove the actual writer stopped, perform the delete outside SQL, and independently verify absence before recording completion. The reviewed source does not yet provide this shared durable hold/delete admission. A check-before-delete followed by an unlocked external call is not an atomic hold fence. Root must resolve that concrete seam with M8, including the behavior of a hold placed during an already-admitted deletion.

For a genuinely awaited and completed put,0415 records settled/closed cleanup evidence even when viewer/source authority later fails. It must remain cleanable without the revoked custodian's grants. For `writing`/`unknown` active puts,0415 has no automatic positive network/worker fence. Cancellation, elapsed time, restarting a worker or one absent HEAD cannot certify quiescence. Leave those files incomplete until an actual fence exists.

## Structured deletion

Keep immediate serving closure in the existing current metadata/catalog predicates. Add a real durable cleanup caller for closed/tombstoned Work, project, client and custom records, rather than putting object deletion in an HTTP transaction. It should call generated and archive `purgeRecord` outside SQL, then reacquire the exact current closure authority in the established type/record/catalog order and call both `confirmRecordInTx` methods before marking that durable deletion complete. Source or custodian read permission must not gate cleanup of already-closed bytes.

The existing generated structured port only accepts three kinds. Do not cast `object_record` to another kind or claim archive cleanup proves generated-file custom-record cleanup. Preserve unknown/unavailable lineage as incomplete until that actual inventory and lifecycle are implemented.

## Restore composition

Replace the constant unbound registry with an actual factory receiving database/store/agent-role recovery authorities. Bind `m6-archive-quarantine` to `createArchiveQuarantineRecovery(actualStore)` alongside all four existing actual contributors, preserving the agent-only transcript and output-writer authorities. Keep the full inventory check; a fifth zero-count placeholder is not a binding.

The owned archive adapter now explicitly calls service-only `reconcile_archive_source_proofs()` before storage inspection. This catches uncertain headers restored without an update event. Proof loss also locks source jobs before reopening completed state, covering a concurrent completion whose old committed row was not completed. No user actor is reconstructed as a service, and no historical transcript/projection proof is invented or rewritten.

The adapter rechecks live and historically purged headers, hashes actual quarantined bytes, detects reappeared purged objects and scans the actual private prefix for storage newer than the database. Orphans and unknown writers are attention, not deletable leftovers. Preserve root's restore admission gate until every actual contributor passes. Existing general object scanning only recognizes ordinary artifacts/exports for safe key display; the archive contributor supplies the private-prefix inventory. If operator findings need exact opaque archive keys, add only the validated UUID key shape, never arbitrary object names.

## Restricted eraser and0999

Run `lifecycle.extend_eraser_reach()` after0415 and every joined tenant table. It should grant only organization-column counting and DELETE under the existing tenant/erasing/no-hold RLS. The0415 row guard independently refuses deletion without positive byte proof and settled/fenced writers. Preserve that guard; do not disable triggers or use a broad eraser exception.

Delete the archive header before its import/manifests/custodian membership parents. The actual FK-retry loop may derive this order, but it must report unresolved rows rather than force deletion. `beginErasure`/`finishErasure` currently count content tables through app-role direct SQL. The new private table has no app table grant: add a narrow metadata count branch using `archive_file_counts()` (removed+remaining), rather than granting the application the private table. The operator must call the actual archive `purgeTenant` before restricted row deletion and persist its physical counts before deleting the header. Its keys are outside `platform.blob_lifecycle`, so the old blob count alone cannot prove or report their deletion.

Before marking erasure verified, independently require zero actual private-prefix objects/orphans, no unknown writers, no held header and no incomplete archive receipt. A header-free newer-storage orphan after restore cannot be certified from SQL row count zero. Preserve current retained audit/tombstone/financial exceptions. Positive local cleanup never proves the customer's external archive was erased.

0414's `ai.unproven_child_work_inputs` is a separate proof inventory. Its deletion trigger unconditionally refuses (`EN119`), and it blocks source-purge completion plus copied Work-body serving.0999 grants do not supersede it. M8 confirms its first0416 source checkpoint only adds main-input/proposal/fact receipts, leaving that child gate closed. Archive files purged=0 cannot certify Work-title redaction, clear child markers or mint inherited observations. Future0416 must supply its own exact hold-aware child-material disposition before that gate can change.

## Concrete joined tests owed

1. Actual encrypted import → new source closure → real agent-role transcript proof → real combined generated/archive cleanup → actual source completion. Repeat with only archive files, only generated files and both.
2. A deliberately optimistic old adapter reports zero while private archive bytes remain: SQL completion must refuse. Source, transcript and0414 child failures remain independent.
3. Missing lifecycle, active/unknown writer, failed delete, dishonest absence, hold and a hold-placement race keep source/tenant cleanup incomplete; retries preserve cumulative counts. Current-source/viewer grant loss blocks serving but not genuine settled-writer cleanup.
4. Actual structured-record closure/tombstone uses both current inventories, reacquires final closure locks and never returns complete for unknown generated custom-record lineage.
5. Older PostgreSQL/newer storage restore finds pending headers, purged-key reappearance and headerless private-prefix orphans. It reopens source completion and never replays a put. Observe actual PostgreSQL blockers for completion/invalidation races.
6. Restricted eraser denies private header deletion before physical proof and under a hold, then removes proven headers before parent rows. App-role baseline/final counts use metadata functions, with no private-table SELECT grant. A tenant with0414 child markers remains incomplete even after every archive blob is gone.

All these combined runtime gates remain unrun by this reviewer. No new runtime adapter was fabricated because the actual hold/delete/writer authority is the missing prerequisite.
