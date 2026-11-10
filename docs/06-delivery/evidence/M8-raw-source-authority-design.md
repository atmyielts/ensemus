# Raw Knowledge object authority: unfinished join

This is a design/ownership checkpoint, not implemented or verified acceptance. Root owns reserved
`0516_raw_source_object_authority.sql`; no such migration has been registered or applied.

## Confirmed gap and current refusal

`knowledge/purge.ts` still calls ordinary `store.delete()` after setting `objectPurgeObserved`.
`knowledge/object-writes.ts` also has a recovery delete after a writer-fence result. Neither call
independently retains a hold-serialized, single-attempt raw-object operation. The current production
composition deliberately wraps ordinary raw storage with `refuseUnadmittedDeletes`, so those paths
cannot obtain a successful deletion default. Derived files and inert archive files already use
separate admitted lifecycle adapters; their receipts cannot certify raw documents.

Two more raw DELETE entrypoints need the same authority or continued refusal: failed-publication
cleanup in `knowledge/sources.ts` and late/closed PUT cleanup in `knowledge/ingest.ts`. The current
S3 PUT also uses the general client's default retries. A fulfilled final retry does not prove an
earlier ambiguous PUT quiescent. Future positive raw writers need actual single-attempt native PUT
admission/observed outcome and guarded settlement; existing app-writable `settled` flags are not
backfilled certificates. Derived/archive PUT settlement has the same separate transport dependency.

The S3 implementation has real single-attempt DELETE and unversioned-bucket/physical-absence
operations. A current-key HEAD, an expired writer lease, cancellation, missing document row or old
purge count is insufficient. Existing unknown/lost-ack operations must remain unresolved.

## Required join

Extend the existing admitted object lifecycle with a distinct raw Knowledge target. Pin the actual
tenant, closed source/version, native purge job, document/key/hash and settled writer token/generation
before provider I/O. Bind its retained operation to the actual protected material restore generation;
the auth restore admission barrier must also be ready. A browser or ordinary app caller must not
choose a source authority, mark a writer settled, relabel a raw object as an ordinary artifact or
mint a physical result. The trusted native storage executor remains an explicit trust boundary;
SQL does not independently inspect the provider. This follows the existing `0508` trusted native
executor boundary; direct app-role SQL is not a separately attested storage principal. Do not give
the Knowledge worker the broad secrets role, invent a GUC proof factory or claim that a process-local
receipt alone prevents someone holding the native app database credentials from making its calls.

Admission and current hold checks run under the same organization/source/job locks as the approved
source material barrier. Hold placement must see an already admitted/unknown deletion and must not
promise preservation after irreversible transport admission. The source-purge and writer-recovery
paths both use this authority. Ordinary raw storage retains its refusing wrapper.

Only a known completed native DELETE followed by actual physical-absence capability checks may
reach proof. Recheck source/job/writer identity and restore generation afterward. Unknown transport,
unsupported versioning, lost acknowledgment, stale generation, active writer or missing positive
fence cannot become success or authorize another DELETE. A generation UUID is not remote-I/O
quiescence; restore still requires actual stop/drain and explicit uncertain-effect review.

Durable raw inventory must survive removal of the document/source header. Native future job birth
and pre-deletion inventory capture must retain the complete actual document/writer set. Existing
partly/completely purged jobs have legacy debt, not a backfilled positive receipt. Zero remaining
rows or historical counters cannot erase that debt. Any external requalification must be based on
an actual complete current provider inventory and positive writer/operation quiescence, not a
caller-supplied count or readiness flag.

The agreed metadata-only confirmation seam is:

```sql
lifecycle.raw_source_material_complete(
  p_source uuid,
  p_source_version bigint,
  p_purge_job uuid,
  p_material_restore_generation uuid
) returns boolean
```

It validates the actual current source/job/version/generation and exhaustive retained raw-object,
writer and restore debt. Missing, held, legacy, unknown or stale proof returns false. The caller gets
no body/table grant. Native app-service source completion and fixed erasure-owner admission may use
it only under their existing authority. The `0515` delegated erasure witness requires this positive
seam in addition to its own current Work/transcript/file/hold proofs. A per-existing-source loop may
not hide independent retained raw debt when a header is absent.

Any added private inventory must join the exact installed-table inventory and reviewed eraser order
at actual registration. Unpublished operational portability exclusions are separate from physical
erasure approval. No `0999` exemption, invented retention rule, historical authority promotion or
automatic Cloud activation is authorized by this design.

The read-only design review proposes separate retained source/job inventories and exact object-write
generations, plus a distinct raw target in existing deletion claims. Do not cascade those inventories
away with live headers. The raw confirmation accepts an otherwise authorized pending/running/failed
job before its completed transition; requiring completion there would be circular. Cached completed
fast paths, transcript skips, worker state, human status and `fail()` must also requalify raw proof.
The existing `fail()` completed-job exception recognizes only artifact errors and cannot leave a new
raw-proof failure green. SQL must recheck completed updates and invalidate stale cache on new debt or
restore; `tenant_object_proofs_complete` must retain independent organization-wide raw debt checks.

## Qualification still owed

Actual-role/provider fixtures must cover native uploaded documents and a positive settled writer,
current holds and hold races, closed/mismatched source/job versions, cross-tenant/key swaps, direct
old-context DELETE denial, unknown/lost-ack transport, repeated physical checks without redelivery,
unsupported/versioned storage, restored proofs and legacy orphan debt. Both source purge and writer
recovery require production composition and restart/resume evidence. None of these `0516` checks has
run, and this design does not close M6/M8 lifecycle acceptance.
