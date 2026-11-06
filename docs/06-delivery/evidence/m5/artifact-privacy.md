# Derived artifact privacy and grounding, source checkpoint

Migration 0208 closes a serving gap: a generated output may quote an uncited input, so its model-selected citation list cannot define its readers. This checkpoint is source implementation and local static evidence. The migration, real-role suite, runtime adapters and restore rehearsal have **not** been executed or accepted here.

## Serving and publication

The generated writer registers an exhaustive, authoritative run/template artifact inventory before creating its upload row and before putting bytes. The service independently includes every SQL evidence package for the run, copies their source IDs, and flattens transitive artifact/package/source inputs. Missing inventory is a refusal. A deterministic system inventory must explicitly attest no knowledge inputs against the actual work, executor/template and exact output hash.

Pending output is invisible. Publication must bind the same inventory after a fulfilled put, then insert the artifact and work attachment in the same transaction. Deferred SQL checks require the durable upload registration for pending writes or a matching live attachment for published writes. A pending active token cannot start a second put. An unknown failed put stays active even when HEAD is absent; elapsed time is not a fence.

Restrictive SELECT policies apply to both `work.artifacts` and `work.work_artifacts`, including service contexts. They check all source IDs without ACL-filtering away missing inputs, current source grants/state/tombstones/classification, input hashes and live work attachments. Normal downloads recheck after the out-of-transaction object read. Ordinary human uploads remain ordinary; recording citations retains a monotonic source binding for those files too.

ID/hash/class catalogs avoid recursive serving RLS. Only fixed trigger functions write them. They use `SECURITY DEFINER`, `search_path=pg_catalog`, fully qualified tables, explicit target/tenant checks and tenant-scoped migrator policies on FORCE-RLS tables. Applications receive SELECT on these metadata catalogs and no catalog write grant. Metadata is not authorization to serve bytes or names.

## Grounding and workflow evidence

Verification control queries use the metadata catalogs and narrow catalog lock instead of bypassing serving RLS. Before and after object I/O, grounding checks its recorded named viewer, and human acceptance checks the current named reviewer and recorder, all inputs, exact bytes/objective/citation digest and current passages. Accepted decisions require submitted `artifactSha256`, `objectiveSha256`, `citationsSha256` and the actual object store. Citation changes are frozen after a proof.

`knowledge.artifact_acceptance_id(artifact, work)` returns only the current exact-work acceptance: latest nonlegacy human decision accepted, latest grounding passed, exact current hashes, reviewer authority, live provenance and current passages. The human chain is artifact-wide across people and binding changes. A newer rejection/failure cannot be bypassed with an older accepted ID. Onboarding's private adoption bridge separately pins each target's own objective and the named brief reviewer; the central helper does not relax work identity.

## Erasure and crash recovery

Retained lineage survives artifact deletion, keeping source-to-object-key, input/package IDs, hashes and writer tokens until byte erasure is verified. Legacy generated/cited files and unresolved orphan upload rows are unknown input inventories and remain blocked; migration does not invent an empty list.

`DerivedArtifactPurge.purgeSource` runs outside source-locked SQL transactions, blocks the file, records a tombstone/outbox event, and invokes an injected lifecycle adapter. That adapter must atomically honor actual legal holds and positively prove old writes quiescent before erasing metadata/bytes. A narrow metadata-only SQL erasure function does not grant service serving access. The factory additionally requires the matching token/generation, dead catalog row, durable tombstone, purged blob lifecycle and actual object absence before recording physical completion. Missing, held, unknown, partial or false-positive adapters remain incomplete. Removed counts are cumulative across retries.

The final read-only confirmation runs again under the source lock. Ordinary grace-period sweeps skip retained-lineage objects, so they cannot certify a generated writer by timeout. Source closure and input binding use source-before-parent lock order, including direct SQL citation inserts. A new source appearing after enumeration causes a version conflict rather than a reversed lock acquisition.

## Authored coverage and actual commands

`tests/integration/knowledge-artifact-provenance.test.ts` contains 27 real-role cases for pending visibility, uncited package inputs, service denial, explicit no-knowledge output, unavailable/mismatched inventories, idempotency, unknown puts, direct SQL/deferred guards, mid-I/O revocation, grant removal, transitive/cross-tenant/hash inputs, human citations, sweeper exclusion, absent/held/lying lifecycle adapters, retained/cumulative purge proofs, current acceptance, metadata grants, and a restricted file remaining private after its Work is lowered (including fresh assignment/revocation). These cases are **authored, not executed**. The earlier verification suite is extended for the submitted digest and stricter privacy boundary.

In the parent-released single-process light slot:

- Prettier wrote the six owned TypeScript files successfully.
- Focused ESLint passed after fixing one regex escape.
- `pnpm exec tsc --noEmit -p packages/application/tsconfig.json` passed.
- `pnpm exec tsc --noEmit -p tests/tsconfig.json` failed in other owners' files: the purge Activity passed four arguments to a then-three-argument function, and the facts test used the public type-only `AppDatabase` export as a value. No diagnostics pointed at this slice. Parent subsequently fixed the facts import.

After that slot, source changes added ancestor/package classification checks, direct-SQL source-first citation locking, artifact-wide proof retry chaining, stricter verification expectations, and the restricted whole-tenant eraser guards. A second parent-authorized final single-process batch passed owned Prettier, focused ESLint, application noemit and tests noemit. This includes the final TypeScript source. No unit, integration, migration, Docker, provider or browser command was run by this slice in this checkpoint.

The eraser guard adds a trigger-only catalog `physical_purged_at` receipt copied from a proven, settled/fenced header. Header/source/input/package/catalog deletion under the restricted eraser role requires positive proof. Fixed guards on blob-lifecycle and artifact-tombstone deletion can preserve a positive ordinary-human no-lineage receipt before dependency-ordered metadata erasure; missing proof is never success. `knowledge.certify_artifact_erasure(uuid,boolean)` is revoked from PUBLIC and applications. Its conditional eraser EXECUTE grant must also be composed into M8's 0999 migration if that role is provisioned later. M8's real erasure-open fixtures are required for the separate joined eraser denial/allowed-after-proof regression; that execution is outstanding.

## Join gates still required

Parent must review/apply the SQL with real migrator/app/service roles and migration/upgrade tests, register the migration journal and package export, wire M4's durable exhaustive inventory and pre-put tool writer, wire the trusted M2 system template, and compose M8's actual hold/fence/storage lifecycle adapter. Restore reapply must use retained metadata for generated rows hidden by service serving RLS and must not claim physical completion from an absent raw service SELECT. Run the new and existing artifact/verification/purge/onboarding suites, full security/tenant isolation and the real download/HTML/runtime journeys before claiming acceptance.
