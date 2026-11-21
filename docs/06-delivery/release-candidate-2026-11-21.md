# Release candidate: consolidation and end-to-end development

## Authority and current scope

On 2026-11-21 the owner requested that all branches and uncommitted work be preserved and brought into
one release candidate, integration issues fixed, and the full platform developed end to end.
`codex/release-candidate` is the canonical implementation branch for this work. The old milestone
reports remain historical evidence at their recorded revisions, not acceptance of this candidate.

The current implementation phase covers consolidation and qualification across M1–M8 and the recovered
M9P/hardening and M11A–M11C foundations. External security review, real-provider qualification, commercial
decisions and launch sign-off are distinct gates. No prices, jurisdiction, residency commitment,
production signing key or approval is invented.

## Preservation before integration

- All 326 original Git references were recorded and retained under
  `refs/preservation/20261121T125018Z/`.
- All 67 worktrees were inventoried; 41 had staged, unstaged or untracked work. Their HEADs, status,
  original indexes, binary patches and untracked files were preserved without moving or cleaning the
  source worktrees. Dirty trees also have immutable local preservation commits.
- The verified Git bundle, snapshot manifest and SHA-256 inventory are under the main checkout's
  ignored `.local/release-preservation-20261121T125018Z/`. `history.bundle` passed `git bundle verify`.
- The 36 older dirty worktrees match the 2026-11-06 recovery snapshots. They must be compared with later
  implementations; an older file is not copied over a newer fix merely to make the files identical.
- Original branches, tags, working directories, Docker volumes and existing preview data are retained.

## Source composed so far

The candidate includes verified main and the latest suite integration/UI branches; recent AI,
Knowledge, mail, checkout and operations source (including dirty snapshots); M9P guide, help,
inventory and parity work; M11A department-pack/meeting, M11B skill/sandbox/marketplace and M11C
federation/tenancy foundations; hardening foundations, proxy warnings, tracing and atomic SSE polling.

The newer combined telemetry implementation is retained behind both recovered entry points. Role
grants are merged per role rather than by concatenating a conflict that crosses a role boundary.
Restore admission, tenant standing, native login restrictions and newer payment guards are retained.
Generated contracts, help and dependency locks are regenerated from the composed source.

This is a source integration checkpoint. Many expansion functions still explicitly throw
`NOT_IMPLEMENTED`; they are not finished journeys and their routes remain planned.

## Verification and discovered integration issues

The first recent-source unit run had 8,219 passes and 18 failures. Follow-ups corrected invalid Compose
composition, telemetry view ordering (the catch-all DROP view suppressed named metrics), telemetry test
types, the assistant's missing context-limit explanation, Windows backup-shell selection, migration
ordering expectations and CI job assertions. A focused rerun of backup, role-journal and CI regressions
passed 90 tests.

Fresh real-role database setup exposed invalid PL/pgSQL syntax in migration 0710. The CASE expression is
now parenthesized. The subsequent database run reached the tests: Knowledge domain-grant checks passed;
mail/checkout fixtures and a native-role audit needed corrections. The next attempted rerun overlapped
source merging and did not execute tests; it is not passing evidence. Those suites still need a clean
rerun on the stable candidate.

After recovering expansion and hardening source, the full unit run had 9,282 passes, 93 failures, four
expected failures and 43 skips across 366 files. Failures include missing busy-response declarations on
planned expansion operations, unreconciled guide/license/CI assertions, and explicit portability
inventory gaps for the newly recovered tables. These failures must be resolved without removing the
security or acceptance requirements. Workspace type checks are also being repaired; no full green
candidate build or release is claimed yet.

Local command output is under the candidate's ignored `.local/rc-*.log`. The test Compose project is
`ensemus-rc-20261121`, network prefix `172.46`, PostgreSQL port `56451`; it contains generated data only.
It is separate from the retained `ensemus-ui`, `ensemus-local` and unrelated application resources.

## Development sequence

1. Finish source lineage review and reconcile generated contracts, migrations, role boundaries,
   portability/lifecycle inventory and release tooling. Reach reproducible source gates.
2. Qualify the joined mail/recovery, checkout, Knowledge, provider routing, budgets, workflows and
   offboarding paths against actual PostgreSQL roles, Temporal and built web/worker images.
3. Complete recovered expansion slices as vertical journeys: domain/contract, permission enforcement,
   persistence, durable execution, UI, receipts and denied/failure tests. Keep unimplemented operations
   planned until the actual handlers and services exist.
4. Run browser/accessibility, provider-fake/fault, replay, load, backup/restore, upgrade, offline and
   Cloud/BYOM/Sovereign parity gates on the same final revision and images.
5. Present the concrete candidate for the named external security, live-provider, commercial and
   release decisions. Automated checks do not constitute those approvals.

## Integration qualification update

The stable real-role mail, checkout and live-status rerun passed 45 tests in three files. The invitation
queue now inserts only its permitted columns, instead of Drizzle-generated DEFAULT columns that also
require privileges. Migration 0730 lets the support notification trigger handle duplicate keys without
reading other mail rows; grants and RLS are unchanged. A recovered membership fixture now proves email
verification in the auth table rather than trusting its request flag.

All eight recovered expansion migrations are registered after the already applied candidate migrations.
The federation CASE guards needed parentheses before PostgreSQL could compile them. Tenancy and
federation schema suites passed. The meetings schema suite then passed 58 tests, and the skills schema
suite passed 35 after migration 0731 repaired an unassigned PL/pgSQL record and fixtures followed the real
review state machine. These are database boundary tests, not completed product journeys.

The guides and license checks were reconciled with current source: Compose aliases and inline services,
first-party image substitutions, the bundled Instrument Serif font and existing reviewed license
exceptions. Updated suite/agent/data-class guides describe implemented paths while retaining their
written-but-untested status. The help module is rebuilt. Focused guide/help tests passed 184 tests;
license tests passed 137, and busy-refusal/notification tests passed with all implemented API operations.
Planned operations remain excluded from runtime response validation and still fail the separate
zero-planned-operations completion gate.

Two never-committed parity scratch suites are preserved under the candidate's ignored
`.local/recovered-scratch/`, as well as in the immutable original snapshots and source worktrees. They
are not promoted to product acceptance tests. The actual parity scenarios and gates remain in the tree.

Outstanding source gates include the new expansion tables' portability/lifecycle treatment and the
unimplemented expansion services, workflows and interfaces. Full workspace checks, migration upgrade,
built-image stack/browser/fault and mode qualification must be recorded on the resulting revision.
