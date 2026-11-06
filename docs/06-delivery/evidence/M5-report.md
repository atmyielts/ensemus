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
| Disposable PostgreSQL migration | M1–M4 plus 0200–0210 applied successfully, 28 journal entries; no original deployment database was used |
| Initial schema cases | 27 passed, three failed; after repairing obsolete actor/version fixtures, all original 30 schema cases passed |
| Source/ingestion/company search | 31 passed after fixing upload idempotency and named-owner expectations |
| Other knowledge cases | Retrieval/isolation passed their initial batch; wider graph/fact/verification and final complete suites remain open |

Source-management follow-up separately passed 80 focused units, scoped lint/format and serial
database/application/tests/web/browser types before composition. Its migration 0212 and browser
journeys are still unrun. [Source details](m5/source-management.md) distinguish those checks.

## Failures found in integration

The upload reservation returned its response outside the transaction wrapped by `runIdempotent`.
That made the helper store an undefined response and PostgreSQL refused the non-null column. The
transaction now returns the authoritative IDs itself; real retry/race/access-loss cases passed.

Drizzle emitted schema-qualified `FOR SHARE OF` targets, which PostgreSQL refuses. A small helper
emits the exact existing relation's unqualified name. Human document row locks then exposed another
policy issue: UPDATE visibility was service-only, so readable documents disappeared from lock
queries. Proposed 0213 aligns lock visibility with SELECT and keeps actual mutations service-only.
No additional column grant is proposed. Graph unlink now uses atomic DELETE RETURNING rather than
asking for UPDATE authority on an immutable edge.

The original deferred fact-evidence check could mistake an RLS-hidden parent for a deleted parent.
Proposed 0213 adds readable-subject insertion and a fixed, ID-only trigger control check; existing
orphan claims require explicit repair rather than silent deletion. New direct-role revocation,
forged-scope, transient-deletion and document-mutation refusal cases are authored. **0213 is not yet
journaled or applied.** These findings are not claimed fixed in the database until its fresh run.

## Remaining integration

Complete and apply structured-input lineage 0211, source authority 0212 and evidence integrity 0213;
regenerate final snapshots and test fresh/upgrade databases. Bind the exhaustive actual M4 compiler
and tool-read inventory before generated writes, cited verification and human acceptance. Preserve
fresh named-viewer access and all inherited inputs through serving, revocation and physical erasure.

Real knowledge model/embedding/rerank ports, canonical purpose policy, transcript writer fencing,
object-writer recovery, provider/OAuth/MCP guarded transports, onboarding run/cost/evidence binding
and complete egress read ports still need composition. The current unavailable ports fail closed.
No model or provider result, full built browser journey, replay corpus, measured recall, hosted pilot,
or complete Cloud/BYOM/Sovereign acceptance is claimed. Independent security and accessibility gates
remain separate. Only generated fixtures and throwaway credentials have been used.

## Temporary resources

`ensemus-m5-integration` is this task's new disposable PostgreSQL project on localhost 55436 and
network prefix 172.21. It is kept while these database checks run, then cleaned by exact ownership.
Heavy image/upgrade rehearsals remain held by the 16 GiB preflight; local source checks are serialized.
See [M4 resource evidence](M4-report.md) for completed-image cleanup and preserved original volumes.
