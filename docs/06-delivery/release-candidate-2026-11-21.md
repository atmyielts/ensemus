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

## Source and implementation checkpoint

All original local branch heads are now ancestors of the candidate. Sixteen superseded or
patch-equivalent heads were accounted for with a history-only merge after comparing their source:
image scan, release signing, reproducibility, retention, M4/M5/M6 variants and the older M8 implementation.
The current implementations and subsequent security fixes were retained. The source ledger records all
326 original refs: 268 are ancestors and 58 historical variants remain preserved under immutable refs.
It also accounts for every changed path in the 41 dirty snapshots, including renamed files and explicitly
retained scratch material. Presence is recovery evidence, not feature acceptance.

Full workspace typecheck and lint passed at the consolidation checkpoint. The full unit suite then had
9,376 passes, two failures, four expected failures and 43 skips (364 files). The two failures are real
completion gates: 76 planned expansion operations and portability coverage for 30 new tables.

EXP-04 now implements the signed JSON bundle format, canonical domain-separated digests, Ed25519
signatures, strict review attestations, supply-chain checks, bounded schema interpretation, fixtures and
publisher-machine keygen/pack/verify. The CLI does not overwrite keys or output, refuses unsafe paths
and directory symlinks, and emits fixed codes rather than key material. Review verification also binds
the execution kind from the signed manifest, so executable packages cannot skip code review. EXP-05's
policy compiler now refuses invalid resource requests rather than silently narrowing them. These format
and admission checks passed 72 focused tests; the catalog/execution journeys are still incomplete.

Real-role testing found that a recovered marketplace trigger checked only the web login, leaving
separated worker logins outside its decision refusal. Migration 0732 restricts review progression to
ensemus_marketplace explicitly. Four native worker/agent logins are tested and refused; the role/schema
rerun passed 40 tests. This change still carries the human security review flag.

The source ledger recovered the missing 77-test tracing suite. It exposed trace-state leakage,
prototype attribute lookup and exporter error handling regressions in the composed telemetry path.
The common redactor now strips free-text trace state/events/status/link attributes, refuses unexpected
resource fields, sanitizes instrumentation scope and forwards only exporter result codes. SDK loading
remains conditional. Active web/worker/dispatcher processes now use the combined metrics/traces config;
the legacy trace-only entry retains exact endpoint semantics. Focused telemetry and wiring checks passed
128 tests, including actual OTLP HTTP capture and disabled/startup/privacy controls.

## Publisher trust administration

The first catalog vertical now joins live membership and company MFA policy, native PostgreSQL
permissions, application services, API handlers and the Publisher keys settings page. Only an active
owner or administrator on the native web login can add or revoke trust. Members can read the documented
public metadata; raw public-key bytes and all private keys are excluded from that response. Admission
combines the operator switch with current company entitlements. Reading and revoking existing trust do
not depend on admission remaining enabled.

Migration 0733 adds `skill.manage` to the existing interactive policy mapping and guards inserts and
permanent revocation. It preserves the later session, SSO and restore checks. Migration 0734 serializes
trust changes and version transitions per company. A real concurrent transaction test first reproduced
a verified version escaping revocation under MVCC; the serialization now prevents that outcome.
Callers taking explicit version/signer row locks must call `skills.lock_trust()` first. Interactive
policy precedes skill trust, which precedes row locks. Both migrations still require human security
review.

Revocation withdraws this company's verified/published tenant packages signed by the key, with audit,
ID-only outbox events and uploader notifications committed in the same transaction. A key cannot be
trusted again after revocation. Marketplace-origin copies retain their separate review trust. The
publisher CLI also refuses to include its own signing key or recognizable copied private-key material
in the package, including a copy listed under an instruction filename; bounded reads avoid allocating
the whole bundle ceiling for every small file.

Focused real-role signer/schema checks passed the six new administration cases and the existing skills
schema cases. The worker-role suite passed four cases after updating its explicit native-boundary
inventory. Focused feature-gate/native-role unit checks passed 20 tests; CLI/navigation/policy checks
passed 49. Web typecheck, production standalone build and changed-source lint passed. Three actual HTTP
cases against that production build passed with catalog admission enabled: tenant/role/origin refusals,
public metadata, idempotency replay/conflicts, If-Match, permanent revocation and invalid/private-key
input. This local generated-data evidence does not qualify a live provider, marketplace or runner.

The canonical full integration suite runs separately against the frozen candidate at `ba8d03c`; its
result is not yet recorded here. The publisher workflow uses a separate generated-data project,
`ensemus-rc-signer-20261121`, PostgreSQL port 56452 and object-store port 58452. No original application
volume or preview was replaced. Three signer operations now have actual handlers; the remaining 73
planned operations and the new tables' portability coverage still block full-platform completion.

The full unit rerun with four workers recorded 9,504 passes, two failures, four expected failures and
43 skips across 371 files. The two failures remain the 73 planned operations and the 30-table portability
inventory gap. An earlier high-concurrency run also timed out three source scans and caught two ID-helper
omissions in the new web forms. Those omissions are fixed; the four source-control files passed 120
tests on focused rerun, and the complete bounded run passed those checks too. No acceptance assertion
was removed or relaxed.

The actual browser journey created an account and company, added a generated public key, checked the
fingerprint, opened the permanent-revocation confirmation and revoked the key. It caught and corrected
a JSX date formatting mistake and a stale success notice. The rebuilt production page then passed the
same add/revoke journey at 375px with no horizontal overflow, no object-string date and no stale trusted
notice after revocation. Screenshots and CLI snapshots are local evidence under `output/playwright/`
and the ignored `.local/rc-playwright-*.log`. This is local UI evidence, not full accessibility acceptance.

Compose now forwards the three explicit collector settings to web, platform worker and dispatcher, which
are the instrumented processes. Previously setting them in the operator shell never reached those
containers. Defaults stay empty and all exporters remain off. Agent, connector, Knowledge, mail and
sandbox processes receive none of these settings. The deployment-boundary, native-role wiring and
actual OTLP exporter checks passed 46 focused tests after this correction.

## Full integration baseline and Marketing continuation

The frozen `ba8d03c` full integration run finished: 2,754 passed, 164 failed and 22 skipped across
167 files (28 failed, 138 passed, one skipped), in 5,131.67 seconds. Many failures share the newly
recovered tables' missing portability and erasure treatment. Other groups include restore/refusal
ordering, native provider/checkout expectations, two agent-evaluation fixtures and Knowledge retrieval
timeouts. These results are a baseline for repairs, not a successful release gate. The detailed local
log remains `.local/rc-integration-full.log` in the canonical checkout.

The verified publisher-trust and telemetry commits have been fast-forwarded into the canonical release
candidate. Marketing continues from that same source in the managed working checkout.

EXP-01 now uses M7's actual `PackManifest` types instead of a duplicate contract. Its conformance helper
also runs the real installer validator and upgrade planner. Marketing 1.0.0/1.1.0 are offered through the
existing catalog and review UI: Campaign and Claim source types, Campaign planner and Claims checker
drafts, and a proposed campaign-review workflow with source evidence and a human approval before email.
The next version adds an optional review-note field; it changes no permission or capability.

Three real-role integration cases passed with the actual metadata catalog, including denied members
and cross-tenant IDs, pending-review refusal, materializing the actual drafts/types, optional-field
upgrade, retaining entered review data through rollback, and leaving the process out when email is
declined. All 200 focused pack tests and 32 source-boundary/audit tests passed; department, pack and test
TypeScript checks and changed-source lint passed. Dependency installation used the offline cache and
added only a first-party workspace dependency. The license inventory check passed at 247 components;
its counsel-review status remains a draft.

The production-build browser journey reviewed each capability, declined email, enrolled and confirmed a
generated authenticator through the real UI, and installed two record types and two inactive assistant
drafts. The send process remained in Left out. This used generated local data and made no external call.
The stale workflows/packs guide now describes these actual review and rollback controls, remains
written_untested, and adds the 28th Help page. Its 184 focused guide/help checks passed. HR, finance and
learning packs, and the remaining full-platform operations, are still incomplete.

## Native payment and restore qualification repairs

Migration 0735 fixes an actual checkout integration bug: without a checkout row, the OR expression for
success evidence became SQL NULL and `IF NOT evidence` did not refuse it. The guard now requires
explicitly true evidence. The existing native payment/schema suites reproduced the unauthorized
success transition before the fix and then passed all 24 cases. The migration is flagged for human
security review; no role or grant was widened.

The directory scope-refresh fixture now uses the actual connector login, rather than asking the web
login to impersonate that worker with a service binding. Checkout fixtures generate distinct provider
transaction IDs, so rerunning tests preserves old data without conflicting with global provider-route
uniqueness. Both fixture suites passed 13 cases after those corrections.

Historical restore postconditions compared literal role spellings from before migration 0700's explicit
worker-tier mapping. Their test-only source/policy projections now compare the mapped helpers in the
original spelling while preserving every statement-order, ownership, grant and forced-RLS check. The
actual worker-role suite independently checks that mapping on native logins. The five native proof
files reached 48 passes and one historical-0550 projection failure; after adapting that last legacy
block, its complete 11-case file passed too. No deployed restore function, policy or historical migration
was changed by this qualification correction.

The two Studio evaluation failures are a product integration gap, not merely stale fixtures: Studio
constructs an unsigned v1 simulation report while M4 correctly requires an independently signed v2
report, and the runtime adapter does not pass the deployment's public evaluator trust. That path must
be repaired while retaining M4's signed-report, exact-revision, policy, age and scripted-model gates.

## Studio evaluator integration

Studio no longer manufactures an unsigned v1 rehearsal report. Assistant publication requires a signed
v2 evaluator report, handed unchanged to M4's existing signature, exact-spec, current-policy, age, suite,
threshold and scripted-model gates. Runtime product ports accept deployment-owned public trust as a
composition option; web loads the existing evaluator public-key configuration. The port copies only its
explicit input fields, so a request cannot supply its own evaluator trust. No signing key enters web.

The approved assistant-review page now has a bounded report field. The publication API accepts the same
optional JSON body; assistant publication requires its evidence, while process publication keeps its
bodyless contract. A real Next production empty POST arrives as an empty stream, so the optional JSON
reader counts actual bytes and handles that case. Its regression cases retain the required-body,
non-JSON, malformed/invalid UTF-8 and size refusals, including a false zero Content-Length.

The real-role Studio suite passed all nine cases, including missing, unsigned, changed and untrusted
report refusal without publication, and atomic genuine-report publication with its immutable receipt.
The production standalone build then passed two actual HTTP cases, covering the rendered report field,
outsider/missing/malformed/tampered refusal, genuine signed publication and idempotent receipt replay.
These reports use a generated test evaluator and model facts; they qualify the protocol, not a provider
or model's quality. Focused evaluation/contract checks passed 288 tests, the optional-body regression
passed three, and guide/source checks passed 195. Web and test TypeScript checks and changed-source lint
passed. The newly written Agent Studio guide stays written_untested; Help now contains 29 pages.

The isolated HNSW regression did not reproduce the baseline timeout: it passed with the original large
authorized set and hidden nearest-neighbor source in 70.852 seconds (78.89 seconds including setup).
Only that one case was selected; five others were skipped by the filter. Neither its ACL checks nor its
dataset/timeout were weakened. The original whole-run timeout remains a final-suite qualification item.
PostgreSQL statement statistics were enabled in the generated test database to profile that case.

## Conservative portability compatibility

The frozen `ensemus.m3-m7/3` archive remains unchanged. Previously the presence of M11 tables refused
all companies, including those with no M11 data. Migration 0736 adds a fixed-owner, forced-RLS boolean
probe for the 28 new company-data tables, including nonstandard marketplace and both-party federation
references. It exposes no records or counts and adds no caller SELECT/DELETE grants. The two global
tenancy deployment/evidence tables are recognized as deployment state. Unknown tables still refuse.

An unchanged /3 export is admitted only when that native probe proves the company has no new-module
data. A caller-visible zero is insufficient. Every new-module mutation advances all affected companies'
existing export epochs in stable order. Downloads also check native emptiness, so matching old/restored
epochs cannot make a pre-existing unsupported snapshot complete. The fixed trigger updates existing
epochs: INSERT ON CONFLICT would invoke a tenant-birth fence before discovering a peer's existing row.
A missing epoch refuses rather than silently recreating one.

Export startup now persists `RECORD_REFUSED` as a terminal failure with its existing audit, event and
notification path, rather than retrying an unsupported schema as an activity error for up to a day.
Refused requests can be replayed without restarting them. No M11 customer data is silently omitted,
classified as retained, or made portable by adding names to the old inventory. Companies with any such
data remain blocked until a reviewed new archive profile and actual lifecycle treatment exist.

The first compatibility regression passed all 83 legacy export/import cases; its new fixture suite had
three remaining failures. After correcting fixture result/error assertions and the peer-epoch write,
all six new native cases passed, covering hidden rows, another company, unknown tables, actual epoch
invalidation, pre-existing data with a matching old epoch, and no new eraser grants. The scripted hostile
archive parser fixture now answers the new metadata probe without simulating its native authorization;
121 focused parser/inventory/epoch/source checks passed.

A newly provisioned generated database applied all 146 migrations as the ordinary migrator. Its 59 new
functions, policies and triggers exactly match the qualification database (catalog SHA-256
`4356097c471a7c8aac01a8ca50e35cd5478a9e71e532a064eef3a0a06f386f6a`). Initial fresh-database attempts
omitted the installation's superuser-created vector extension and were refused; the successful attempt
used that documented prerequisite and the ordinary connection/schema restrictions. No original database
or volume was removed. Security review of the new SQL remains pending.

The full bounded unit run after the parser-fixture correction reached 9,520 passes, two failures, four
expected failures and 43 skips across 373 files (370 passed, two failed, one skipped), in 98.83 seconds.
The two release gates remain explicit: 73 planned API operations and 30 tables missing from the complete
portability inventory. Lifecycle treatment also remains incomplete. Application/test TypeScript checks
and changed-source lint passed. The final six-file native export/import, race, signer and worker-role
regression passed all 101 cases in 527.92 seconds.

A follow-up denied case reproduced a generic exception at interactive import admission when new-module
data exists. Admission now names that condition `IMPORT_TARGET_NOT_EMPTY`, creates no import intent, and
leaves unknown/missing schema refusal distinct. The import and seven-case native compatibility suites
then passed all 26 cases; the 121 focused unit checks and application/test types and changed-source lint
passed again. The broad unit count above predates this final admission mapping. This repair does not
complete M11 portability or erasure; neither release gate was relaxed.
