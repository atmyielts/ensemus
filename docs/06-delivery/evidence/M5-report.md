# M5 company knowledge integration

**2026-11-07. Active integration, not milestone acceptance.** The knowledge foundation is composed
with the verified M4 source in `codex/m5-integration`. Main `codex/platform-completion` still holds
the M4 checkpoint. The original Claude branches and recovery snapshots are preserved.

## Composed behavior

Source ingestion, revisions, grants, search, facts, graph, answers, verification, purge, provider/MCP
adapters and onboarding services/pages are present. Composition preserves newer M3 receipts and
consent, M4 agent authority and the shared interface. `createWorkUnitInTx` is a narrow extraction of
the current kernel, retaining creator assignment, external-receipt and dependency safeguards.

The real secret scanner now raises detected key material to restricted protection. A separate
knowledge worker has only the app, Temporal and object-store mounts on internal networks; it has no
model key or connector secret mount. Parser activity concurrency is bounded to two. The parser is
emitted as its own JavaScript entry point, required by its worker-thread URL. This source Compose
configuration has not yet been qualified as a built stack.

Knowledge is in shared workspace navigation, company search is reachable from workspace context,
client onboarding belongs under Clients, and data-sharing decisions belong in Administration.
Knowledge uses a shared section-navigation component with native links and current-location
semantics. The added browser journeys are authored, not rendered/accepted.

## Actual checks so far

| Check | Observed result |
|---|---|
| Frozen offline install | Passed, all 21 workspaces; no dependency resolution changes |
| Generated contracts | Regenerated successfully from composed OpenAPI |
| Initial combined types | All reached packages passed after duplicate shared status labels and four old connector stream fixtures were corrected; web route generation, workflows, worker and test types passed |
| Combined units at `1120bdf` | 3,022 passed, one stale test expected knowledge search to remain unimplemented |
| Repaired contract/navigation/scanner batch | 45 passed, including the corrected unknown-method refusal and four new nested navigation cases |
| Worker build | Passed, including the Temporal workflow bundle |
| Actual emitted parser | Success, unsupported-format refusal and deadline termination passed; caller buffer preserved |
| Disposable PostgreSQL migration | M1–M4 plus 0200–0213 applied successfully from empty synthetic data, 31 journal entries; no original deployment database was used |
| Initial schema cases | 27 passed, three failed; after repairing obsolete actor/version fixtures, all original 30 schema cases passed |
| Source/ingestion/company search | 31 passed after fixing upload idempotency and named-owner expectations |
| First broad M5 database run | 185 passed, 74 failed across 22 files; common trigger, lock-policy and fixture failures were investigated rather than treated as acceptance |
| Repaired 12-file real-role batch | **241 passed**, 40.04 seconds: schema, client visibility, generated provenance, verification, facts, onboarding, Google/Microsoft sync, restore, company search, graph and cursor integration |
| Latest focused units | **22 passed** in three files: connector cursor limits, navigation, actual scanner composition |
| Constraint metadata audit | 210 actual constraints inspected; zero naming differences against 0213 snapshot for the selected knowledge/client/onboarding/MCP tables |
| Runtime protocol migration | 0214 applied to the existing disposable database and snapshotted; 32 journal entries now registered |
| Joined runtime/ledger batch | **119 passed** in five files, 31.10 seconds: actual protocol, compiler context, tools, generated provenance and sharing ledger |
| Joined focused units | **129 passed** in four files, including closed-input tool paths, deterministic checklist inventory and actual hypothetical policy binding |
| Full units at `090f098` | **3,055 passed** across 121 files, 73.58 seconds |
| Full real-role regression at `090f098` | **1,442 passed, 15 failed** across 55 files, 240.12 seconds; restore cleanup and older runtime/tenant fixtures required repair |
| Onboarding source checkpoints | `f0e0568` and `de7e806` composed; actual run/outbox binding, complete retained output inventory, retry classification and plain-language recovery state. Their source-only 110-test and 32-test batches are separate from actual-role results |
| Legacy onboarding upgrade refusal | Proposed 0215 refused pre-existing unbound run references with EN215 inside a rolled-back migration transaction; journal, temporary policies and helper function remained unchanged |
| Repaired restore/onboarding gate | **83 passed** in four files, 35.06 seconds, after applying 33 migrations from a fresh disposable PostgreSQL database. Includes direct-role human/service refusal and actual reviewer/publication/service-identity concurrency |
| Full repaired unit suite | **3,084 passed** in 125 files, 73.60 seconds; single worker to bound resource use |
| Full repaired real-role suite | **1,486 passed** in 56 files, 249.80 seconds; all 15 earlier full-regression failures resolved and new actual gateway/private-restore/race cases included |
| Latest schema metadata | 211 selected actual constraints audited against 0215 snapshot; zero naming differences |

Source-management follow-up separately passed 80 focused units, scoped lint/format and serial
database/application/tests/web/browser types before composition. Migration 0212 is now applied in
the disposable database; its built browser journeys remain unrun. [Source details](m5/source-management.md)
distinguish the earlier source checks. All current repaired source passed scoped formatting/lint and
serial domain/database/application/connectors/tests types. The full regression found the additional
cross-milestone gaps listed below; its failed result is retained rather than counted as acceptance.

The actual input-runtime and compiler capture checkpoints are now composed. The first four-file
runtime database run passed 103/113 cases; new protocol and generated-provenance suites passed, while
older context/tool assumptions exposed the closed-run handling gap. A metadata-only stop/reconciliation
path now preserves M3's actual outcome after cancellation without loading private arguments or adding
a transcript. Gated SQL effects hold the checkpoint against concurrent fencing. Argument reads require
fresh all-input authority. The app role successfully reads only proposal metadata after fencing, while
its private argument read remains denied. A later five-file run exposed two obsolete fixture assumptions
and one incorrect raw schema reference; after correction, all 119 cases passed. Current scoped lint/format
and sequential domain/database/application/agent-runtime/knowledge/tests/web types passed; broader
regression repairs are in progress.

The first full regression exposed ordinary restore deleting its serving visibility before cleaning
file metadata and invalidating reviews. A service-only, fixed SQL maintenance function now exposes
ordinary file keys and affected Work IDs without exposing names or bytes. Whole surviving private
files still require operator confirmation. Generated or unknown lineage is refused. Positive ordinary
origin survives deletion in the retained catalog; unknown history is never silently promoted. The
existing generated-file lifecycle still requires holds and writer/physical proof. Fresh SQL and
repeat/review/private-serving regressions are being checked before this repair is accepted.

Actual onboarding tests caught a reviewer/contributor assignment mismatch in the new adapter. Admission
and advancement now require the reviewer assignment the workflow actually creates. Publication-set
advisory locking and exclusive Work locks also guard direct SQL binding against concurrent publication
and assignment changes. Work completion and list counts now consult fresh exact human acceptance or
the existing pinned onboarding-adoption bridge before counting a generated output. The latest focused
database round passed 78/79 checks and exposed the missing completion bridge; that repair and new
direct-role concurrency regressions subsequently passed all 83 focused cases. The separate 179-case
Work suite passed after refusing overlapping generated uploads and preserving unconfirmed stopped
output bytes. The complete post-repair database regression subsequently passed all 1,486 cases.

The repair passed scoped format/lint and sequential database/application/tests/workflows/worker/web
types, including actual Next route generation. Commands run:

```powershell
pnpm exec vitest run --project unit --maxWorkers 1
pnpm exec vitest run --project integration tests/integration/client-onboarding.test.ts tests/integration/client-onboarding-gateway.test.ts tests/integration/tombstone-ledger.test.ts tests/integration/knowledge-restore.test.ts
pnpm exec vitest run --project integration
```

All three commands passed in the final repair gate. Local logs retain each failed iteration and rerun;
failed test scaffolding and incorrect array binding were corrected without weakening serving RLS,
input capture, physical erasure proof or M4's Work completion kernel.

The data-sharing page now reads real run decisions with the same millisecond/UUID cursor as knowledge
calls. It lists actual published/live agent versions and uses the shared pure egress policy with the
tenant's active tightening. No credential or provider port is present. Historical provider kind stays
unknown where it was never recorded. The proposal form names its approved use and explains that policy
compatibility still needs actual model, budget and connection approval. This is implemented source and
real-role DAL evidence; the new page has not yet been rendered in a built stack.

## Failures found in integration

The upload reservation returned its response outside the transaction wrapped by `runIdempotent`.
That made the helper store an undefined response and PostgreSQL refused the non-null column. The
transaction now returns the authoritative IDs itself; real retry/race/access-loss cases passed.

Drizzle emitted schema-qualified `FOR SHARE OF` targets, which PostgreSQL refuses. A small helper
emits the exact existing relation's unqualified name. Human document row locks then exposed another
policy issue: UPDATE visibility was service-only, so readable documents disappeared from lock
queries. Applied 0213 aligns lock visibility with SELECT and keeps actual mutations service-only.
No document column grant was added. Graph unlink now uses atomic DELETE RETURNING rather than
asking for UPDATE authority on an immutable edge.

The original deferred fact-evidence check could mistake an RLS-hidden parent for a deleted parent.
Applied 0213 adds readable-subject insertion and a fixed, ID-only trigger control check; existing
orphan claims require explicit repair rather than silent deletion. New direct-role revocation,
forged-scope, transient-deletion and document-mutation refusal cases passed. A synthetic legacy-orphan
upgrade preflight refused with EN213 inside a rolled-back transaction; it changed neither journal
nor runtime policies. This is a focused refusal check, not the complete upgrade rehearsal.

The shared artifact-binding trigger originally referenced fields absent on two of its targets; its
relation-specific branches now compile independently. Citation changes serialize on the ID-only
artifact catalog, preserving immutable file permissions. Maintenance header locks have tenant-scoped
UPDATE visibility with WITH CHECK(false), so the fixed definer can lock without gaining mutation.
Restore receives only the missing guarded marker-column grant and recreates a durable blob-deletion
reservation before its lifecycle runs. Missing, held and unconfirmed lifecycle proof remains closed.

Client INSERT RETURNING now checks the actual new row rather than an AFTER-populated catalog.
Onboarding inserts child parent IDs through the current Work creation kernel, without granting later
reparenting. Its source permissions match the owner/admin-only SQL and model-run authority. Readable
source-bearing files remain hidden from service accounts. Connector resource kinds use the canonical
file slug; larger composite cursors are allowed only for the stored Google/Microsoft connector and
its exact Drive stream. A caller naming that stream on another connector cannot commit any page.

## Remaining integration

Structured-input lineage 0211, source authority 0212, evidence integrity 0213, actual run-input protocol
0214 and onboarding binding/restore guard 0215 are journaled, applied and snapshotted. The full local
unit/database regression passed; built journey, replay, upgrade and runtime transport qualification
remain. The actual compiler/tool inventory is composed and tested before generated writes. Preserve
fresh named-viewer access and all inherited inputs through serving, revocation and physical erasure.

Real knowledge model/embedding/rerank ports, capability-specific qualification, approved standalone
model jobs, object-writer recovery and provider/OAuth/MCP guarded transports still need composition.
Canonical purposes, transcript writer fencing, actual egress readers and onboarding run/cost/output
binding are composed; full runtime/stack/mode acceptance remains open. Remaining
unavailable ports fail closed.
No model or provider result, full built browser journey, replay corpus, measured recall, hosted pilot,
or complete Cloud/BYOM/Sovereign acceptance is claimed. Independent security and accessibility gates
remain separate. Only generated fixtures and throwaway credentials have been used.

## Temporary resources

`ensemus-m5-integration` is this task's new disposable PostgreSQL project on localhost 55436 and
network prefix 172.21. It is kept while these database checks run, then cleaned by exact ownership.
Each fresh reset verified the exact one-container/one-volume Compose ownership and absence of other
volume users before replacing only synthetic data. The owned M4 preview is stopped, with all its
volumes retained. Heavy image/upgrade rehearsals remain held by the 16 GiB preflight; source checks are serialized.
See [M4 resource evidence](M4-report.md) for completed-image cleanup and preserved original volumes.
