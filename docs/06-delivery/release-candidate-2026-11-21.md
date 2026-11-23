# Release candidate: consolidation and end-to-end development

## Authority and current scope

On 2026-11-21 the owner requested that all branches and uncommitted work be preserved and brought into
one release candidate, integration issues fixed, and the full platform developed end to end.
`codex/release-candidate` is the canonical implementation branch for this work. The old milestone
reports remain historical evidence at their recorded revisions, not acceptance of this candidate.

The current implementation phase covers consolidation and qualification across M1ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“M8 and the recovered
M9P/hardening and M11AÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“M11C foundations. External security review, real-provider qualification, commercial
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

## HR pack and native private-record authority

EXP-01 now offers HR operations 1.0.0/1.1.0 through the actual catalog and installer. Employee onboarding,
Employment record and Policy acknowledgement are all restricted manual record types. The Onboarding
coordinator drafts only from separately permitted public/internal work, and the checklist workflow puts
an actual human decision before fulfilment. No employment record tool, permission grant, external action
or field that rates a person is proposed. The later version adds an optional private custody note.

M7's restricted-data capability is now accepted only for elevated review of actual restricted manual
record types. It still refuses assistant/process references, mixed references and low-risk requests;
every restricted type must be explicitly covered. Declining it leaves all three personal types out.
This is an installer disclosure and dependency decision, never a data-access grant.

The native denied tests found a real underlying privacy issue: an agent login could supply user-shaped
bindings and SET ROLE ensemus_app, then pass objects.active_person and read an owner's restricted row.
Migration 0737 makes that human path native-web-only. It also confines a pending migration's service
path and progress writes to the native platform worker. Agents, connector/knowledge workers and web
service bindings cannot borrow that authority while a migration is queued. The real platform worker
still migrates the admitted private type and loses that record-read path once the migration closes.
Private indexed values have the same human boundary. No table read/write grant was added, and these
helpers remain invokers with a fixed search path; human security review remains pending.

The native HR/custom-object/worker-role regression passed 21 cases. A subsequent complete native-actor
case also checked the actual derived private index after migration and passed. These exercise other
companies, ordinary members and administrators, native agent/worker impersonation, classification
floor refusal, declined review, actual record migration, upgrade and non-destructive rollback. Legacy
migration fixtures now use the real worker login instead of treating the web login as a service worker.
All 259 focused pack/role/security-source checks passed. Domain, department and test TypeScript checks,
changed-source lint and the production standalone web build passed. A fresh generated database applied
all 147 migrations and verified the three native-actor helpers' ownership, invoker status, fixed search
path and revoked public execution.

The production browser journey reviewed each capability, observed all three personal types left out
when restricted data was declined, then accepted it explicitly. It enrolled a generated authenticator
through the actual UI, installed 1.0.0, reviewed and upgraded to 1.1.0, created a restricted employment
reference with a private custody note, rolled back, and reopened that same protected record with its
note retained. At 375 pixels the review and record pages had no horizontal overflow. Local screenshots
are in output/playwright/hr-*.png; authentication state, setup keys and recovery material stay ignored.
No real HR data, external effect, model call or production deployment was used. The browser's generated
upgrade migration remained queued because this browser harness runs web, PostgreSQL and object storage;
the actual batch implementation was qualified separately on the native platform-worker connection.
Temporal dispatch and replay remain wider-platform gates.

Pack record-type links now go directly to the type. Catalog and confirmation copy distinguish usable
manual record types from inactive assistant/workflow drafts. The existing workflows/packs guide includes
HR, remains written_untested, and Help still has 29 pages. Finance and learning packs are not offered yet.

Full repository lint and 184 guide/help checks also passed. The license inventory check still accounts
for 247 components; its review remains draft_not_reviewed_by_counsel.

The full bounded unit run on this source reached 9,534 passes, two failures, four expected failures and
43 skips in 133.59 seconds across 374 files (371 passed, two failed, one skipped). The remaining source
release failures still name 73 planned API operations and the same 30-table portability inventory gap.
The previous full joined integration baseline has not been rerun, and M11 services, complete lifecycle
handling, built-worker/Temporal, hosted/provider and human acceptance remain open.

## Native human readers and rehearsal execution

Migration 0738 closes the same native-login impersonation issue in Studio and personal outcomes. The
new regression reproduced private process and personal outcome reads through user-shaped bindings and
SET ROLE on all four native worker logins. A separate case reproduced an agent borrowing the actual
queued simulation selector to read its immutable input. Human reader predicates now require the web
login as well as the existing active-person and ownership checks. Simulation service access requires
the native platform worker, no membership binding and the existing exact durable request/outbox scope.
The shared web-login helper answers only the native login and grants no person or tenant authority.
These helpers remain invokers, fixed-path and unavailable to PUBLIC; human security review is pending.

The first six-file native regression passed all 31 cases. A further workflow run passed 41 and failed
two legacy fixtures that still used web credentials for service execution. Those fixtures and the
shared genuine-publication helper now use the native worker. All 43 cases in the product schema, Pulse
and runtime-adapter follow-up passed; onboarding and process-run authority passed in the earlier run.
The actual production-web signed-evaluation publication test passed both HTTP cases again. Generated
evaluator facts qualify the signature protocol, not live model quality or a provider's approval.
A fresh generated database applied all 148 migrations as the ordinary migrator and checked all five
changed functions' ownership, invoker status, fixed search paths and revoked PUBLIC execution.

The full unit run reached 9,534 passes, two failures, four expected failures and 43 skips across 374
files in 76.90 seconds. The failures still name the 73 planned API operations and 30-table portability
inventory gap. This source-wide run preceded the final test-helper correction, which was checked by
the native follow-up. No broader joined integration, Temporal, hosted or human acceptance is claimed.

## Source-record storage and read journey (EXP-02)

Business records now have a native connector sink, source-granted list/detail reads, two actual GET
routes and Source records pages in the workspace. The sink checks the selected stream, connection,
read scope, allowlisted field types, classification floor and canonical content hash. Duplicate source
IDs within a page and conflicting stream identities refuse atomically. An identical page leaves both
the row and its timestamp unchanged. Deleted and revoked content is cleared through the native sink or
platform upkeep; the latter can only clear content on revoked connections and repeat without effects.

Migrations 0739/0740 add restrictive policies alongside existing tenant isolation. The denied fixture
reproduced raw reads without source grants, including an administrator. Native worker logins cannot
borrow a person's bindings or SET ROLE to read the fields. The human path requires the current active
person and their actual direct/team source grant, an active selected connection and source snapshot.
A readable record must match the source row's stream, version, hash and classification: new fields
therefore remain hidden between the sink commit and the corresponding source-permission commit.
Partial mapping admits only actual mapped grants; unmapped principals add no access. Revocation also
closes the connector's own scoped read path, which a separate denied test reproduced before 0740.
No DELETE, worker bypass, security-definer read or broader table grant was added. Human security review
remains pending. The existing M11 portability refusal and incomplete lifecycle gates remain intact.

The three-file native record/expansion/worker-role regression passed all 67 cases after the revocation
fix. The final five-case record file also included the knowledge login, covering all four native worker
logins, and passed again. Historical schema fixtures now use the connector login with an exact source
scope; native authority refuses a foreign connection before the old FK check can disclose its existence.
A fresh generated database applied all 150 migrations as the ordinary migrator and checked the four
new functions' owner, invoker status, fixed search path and revoked PUBLIC execution.

The production standalone build passed both actual HTTP cases: anonymous/foreign/ungranted-admin
refusal, granted read and rendered snapshot, invalid filters/cursor, and immediate API/page refusal
after removing the actual source grant. The first HTTP run caught a new route-level loading boundary
returning a streamed 200 denial; the repository's no-JavaScript gate also refused it. That newly added
file was removed, retaining strict page 404 checks and whole-page rendering. A real browser then read a
generated source fixture, filtered it and navigated the form by keyboard. At 320, 768, 1024 and 1440
pixels there was no horizontal overflow. Literal script-shaped source text remained text and executed
nothing. The same list/filter/record journey worked with JavaScript disabled at 320 pixels. Browser
console checks reported zero errors/warnings. An axe bundle was not available through the browser test
workspace; no independent accessibility acceptance is claimed. These fixtures qualify storage and
reading, not provider connectivity, live synchronization or a commercial integration.

The new Help page remains written_untested; Help contains 30 pages, with no new CI/human acceptance
status. The two implemented read operations are no longer marked planned; the remaining 71 operations
stay planned. Record-change, ticket-comment and invoice-draft proposals, revision/retry, business
connector lifecycle and provider-backed sync remain unfinished and are not represented as usable.
The source pages expose no edit effect. Finance/learning, meetings and the wider M11 services remain
open. No real credential, provider, source data or model was used.

The first full unit run had 9,531 passes and eight failures: two known release gates, three cases in an
upkeep test double that still called the former no-op cleanup, the loading-boundary gate, a guide-check
timeout and one fake Bedrock redirect extra-hit assertion. The test double now mocks the unrelated real
cleanup. All 512 focused cases passed after those corrections; the timeout and extra hit did not recur,
and their assertions were not weakened. The final full run reached 9,537 passes, two failures, four
expected failures and 43 skips across 374 files in 62.30 seconds. Only the 71 planned operations and
30-table portability inventory failed that run. Full repository lint and the production build passed.
The full joined integration baseline and built-worker/Temporal, hosted/provider and human gates have
not been repeated or accepted by this slice. C: still has about 30.7 GiB free; cleanup was unnecessary.

## Business adapter constructors and native sync (EXP-02)

The actual CRM, ticketing and accounting constructors now use the shared adapter kit and their declared
manifests/tools. Strict schema and stream/writable-field checks run again at the final connector
boundary. Internal ticket notes cannot become public replies. Accounting offers only annotations and
invoice drafts; every payment-record field stays read only, money stays a decimal string, and status,
bank and pay-now fields refuse before contact. A repeated idempotency key creates one generated effect.
An uncertain response stays uncertain and is looked up; a best-effort absent lookup proves nothing.

The shared adapter now requires both saved configuration scopes and the connection row's actual granted
scopes before any read/write contact. Missing current row facts refuse. Existing-record updates and
internal ticket notes must still target a selected stream; a denied test reproduced all three update
constructors sending after selection was removed, before that late check was added. A new invoice draft
names no existing source record. No domain tool was added to an assistant's callable registry by this
slice, and the business write-proposal/review service remains unfinished.

The constructor/transport/certificate/SDK regression passed 183 cases across six files. The generic SDK
suite has no connection row, so its test-only adapter supplies explicit generated row scopes; actions
retain the SDK's hostile/silent network and canary credential. Successful sync checks alone use the
local adapter's read credential/network. Missing current-scope refusals run on unwrapped constructors.
No conformance TODO or catch-and-skip wrapper was added.

The first nine-case native TLS run passed six and exposed three generated-certificate loading failures.
The existing test helper appended a second PEM newline when the base64 length was a multiple of 64;
signature-length variation made this intermittent. A separate Node TLS/X.509/key-match regression
reproduced it. The test helper now removes that trailing wrapping newline before adding its one final
newline. Its 120 generated certificates across three names passed the actual TLS parser, signature,
key-match and hostname checks. No production TLS verification or crypto algorithm was changed.
The combined business/SMTP TLS regression then passed all 34 cases. After the final scope/selection
checks and typed fixture correction, the complete business native file passed all nine cases again.

Those native cases use a real HTTPS loopback server and the actual single-target TCP gateway. Every
connector syncs generated records for two companies with the same external ID through the actual native
connector database login, real sealed secrets/SecretBroker, source-principal mapping, cursor commit and
sync Activity. The repeat retains the stored record/timestamp. Ungranted owners and another company
cannot read the records. Actual connection revocation immediately removes read access, and the next
Activity revokes its sealed credential without another HTTP request. Wrong-name and untrusted
certificates refuse before any credential is lent or HTTP request arrives. Unknown source fields are
not retained, and gateway logs remain code-only. No live provider or Temporal poller was used.

Full repository lint and connector/test TypeScript checks passed. The first full unit run, concurrent
with native/type checks, reached 9,659 passes and four failures: the two known release gates plus guide
and vendor-issuer reachability timeouts. With the other checks completed, the unchanged complete unit
suite reached 9,661 passes, two failures, four expected failures and 43 skips across 379 files in 61.76
seconds. No timeout or assertion was relaxed. The release failures still name 71 planned API operations
and the 30-table portability inventory gap.

These constructors are internally available to the connector worker when an operator explicitly binds
a gateway. This slice does not add them to the customer connection catalog or claim that setup is
finished. Business write proposals/review, connection setup/configuration, built-worker/Temporal and
provider acceptance remain open, as do the ADR-033 review and Cloud adapter-routing decisions. The
existing three-mode default remains no business route and no contact. No migration, secret/config
format, external dependency, actual credential or provider commitment was introduced by this slice.


## Private Work, review, action and history readers (WORK-03, QA-007, ADR-024/027/028/039)

The native PostgreSQL regression reproduced private content reads that the existing DAL correctly
refused: an unassigned member, four workers copying human bindings, and unadmitted agent/knowledge
service contexts could read Work objectives, approval actions and external-action payloads. A later
extension reproduced the same leak in free-text Work transition and approval-decision reasons,
including an unadmitted delegated platform context. Migrations 0741ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“0743 and 0746 add restrictive
SELECT policies on all five material tables, retaining their existing tenant, parent, inherited-input
and immutable-history rules. An actual web person still needs a current active membership and the
current Work ACL. Copied human bindings and SET ROLE do not turn a worker login into a person.

Legitimate agent reads still require the actual active run, its initiator and scoped admission.
Legitimate delegated platform reads require an actually requested process intent, its current active
starter and the actual root or immutable step-birth association. A guessed Work ID or temporary birth
selector grants nothing. Platform/connector service logins retain their existing trusted tenant
processing access. This does not claim that those two roles have been reduced to individual queue
intent capabilities; that narrower service-purpose boundary remains work to do.

The Work creation kernel now inserts without RETURNING and reads only after the real scope mirror and
contributor assignment exist. It checks the driver's inserted row count and returns an actually
readable stored row; it does not manufacture a substitute Work row. Test fixtures now use the native
platform or connector database for worker Activities and primitives, rather than a web database with
service-shaped bindings. Human paths continue to use the web database.

The first strict read policy exposed a prerequisite regression: invisible prerequisites disappeared
from an inner join, allowing blocked Work to advance. Migration 0744 provides a fixed, tenant-bound
status-only projection for an actual web reader of the dependent and an actual dependency edge. Its
selectors are restored on success and failure. It returns no private body. Queries use a left join;
an unavailable status counts as unfinished. Existing hidden/stopped prerequisite counts and removal
still work without returning a hidden title or objective.

Terminal agent cleanup also needed an actual metadata path. Migration 0745 can cancel only pending
work.review records tied to the exact fenced, authoritative terminal run and its released current
Work/version. Completed runs close outdated reviews by hash; failed/stopped runs cancel their own
reviews. The capability returns review/requester IDs only, then applies shared notification, audit
and outbox effects. It cannot approve, inspect review actions, release a newer active hold or operate
through a web login. Ordinary review writes and external-action dispatch keep their existing paths.

All six migrations are flagged for human security review; no human review is claimed. The status and
terminal-review helpers are fixed-path security definers with no PUBLIC execution; the reader helper
is an invoker. A fresh ordinary-migrator installation applied 156 migrations and matched all 156
stored hashes to the final source files, and verified these owners, execution flags and five
restrictive SELECT policies. The first unit pass caught missing required security header comments on
two newly authored migrations. Their pre-marker bytes remain under ignored local evidence; the
comments were corrected before the final fresh hash proof. No migration ledger was rewritten.

The four-file Work/external-action/process regression passed all 326 cases before the history
extension. The agent/input-scope/search/parent regression passed 50 of 51 cases, exposing terminal
review cleanup; after its fix, the full native reader file and new status-purpose file passed all 21
cases. The final four-file history/process/agent/status regression passed all 37 cases. The complete unit
suite then passed 9,661 cases, with two known failing release gates, four expected failures and 43 skips
across 379 files in 58.26 seconds. The failures still identify 71 planned API operations and the
30-table portability inventory. No assertion or timeout was relaxed. Application TypeScript passed;
repository lint and test TypeScript were also rerun after the history test extension. Native evidence
and exact final source/log hashes are in `evidence/rc-private-work-material-20261121.json`.

No public API, event schema, table, model route, actual credential, external dependency or required
configuration was added. These SQL paths are shared by Cloud, BYOM and Sovereign and make no provider
contact. Hosted acceptance, built workers/Temporal, load and independent security acceptance remain
open. The business write-proposal/review service, customer business-connection setup and the broader
platform gaps listed above remain unfinished.


## Reviewed business changes through the production web/API (EXP-02)

This slice implements the five previously planned proposal, revision and retry operations. CRM and
accounting record updates, internal ticket notes and manually entered invoice drafts now use the
existing immutable M3 external-action/approval kernel. Each proposal has the exact canonical payload,
request hash and independent approver; revisions cancel the old proposal atomically and retries need
a proven failed action and a new approval. These business operations are not added to the AI tool
manifest. Payment/posting and customer-facing ticket replies remain refused.

Admission checks the actual web login, active proposer and reviewer, readable Work, connection type,
configuration and granted scopes, selected stream, source version, classification and direct/team
source grants for both people. An update without a source version is refused. A record-backed
proposal loses readable payload when the current reader loses source access. New invoice drafts have
no existing target record: their manually entered content follows Work, connection and classification
access. The source page does not copy source names or customer facts automatically into new Work or
invoice drafts. A single idempotent transaction creates Work, explicitly assigns its reviewer, and
creates the approval; refusal rolls these effects back together.

Migrations 0747Ã¢â‚¬â€œ0749 add source-bound read restrictions and narrowly scoped record/team fact locks.
Native connector dispatch repeats permission, version, scope and classification checks before
creating an attempt. Team-grant deletion races return VERSION_CONFLICT without an attempt or a
permanent cancellation. A subsequent committed loss cancels the action before contact. The lock
helpers do not grant the web role UPDATE access to source records or team memberships. All SQL
changes are marked for human security review, which is still pending. A fresh ordinary-migrator
installation applied 159 migrations, matched all 159 source hashes, and verified fixed search paths,
function ownership, execution grants and restrictive policies. No applied migration was rewritten.

The production source page now offers proposal forms, exact review previews, receipt history and
source-filtered retry reviewers. Mobile field values survive a refusal; the actual no-JavaScript
320-pixel journey also preserved invalid invoice values, corrected them and created the review.
Generated browser journeys exercised CRM approval, ticket-note denial, invoice validation and review,
a person finding after a generated uncertain outcome, and a new retry awaiting its own approval.
The uncertainty fixture used actual native state-machine functions and contacted no adapter. Its
receipt is local test evidence, not provider acceptance. Widths 320, 768, 1024 and 1440 had no horizontal
overflow; source script-shaped text stayed literal. Final mobile screenshots were inspected. No
independent accessibility or customer walkthrough is claimed; the guide remains written_untested.

The final native business-action file passed all 12 cases, including the concurrent team-grant race.
A combined business/source-reader/native-TLS regression passed 25 cases before the final race addition;
the existing M3 external-action regression passed all 124 cases. The final production HTTP file passed
all five cases against the final build. The complete unit suite passed 9,669 cases with two failing
release gates, four expected failures and 43 skips across 379 files in 56.78 seconds. The gates now
identify 66 planned API operations and the 30-table complete portability inventory. Application,
connector, web and test TypeScript, repository lint, guide generation and the production build passed.
Exact source, fresh-database proof and local-log/image hashes are recorded in
`evidence/rc-business-actions-20261121.json`.

Customer business-connection catalog/setup, the browser revision editor, real provider adapters and
credentials, Cloud routing, durable built-worker/Temporal acceptance, hosted/human/load/offline,
restore/upgrade acceptance and the broader platform backlog remain open. There was no production
deployment, provider contact, original-source deletion or volume cleanup. About 28.6 GiB remained free.


The business-action commit check caught one CRLF in each new SQL file that Git normalized under the
repository LF rule. Pre-normalization bytes are preserved under ignored local evidence. The working
files now exactly match their committed blobs; SQL is unchanged. A second fresh ordinary-migrator
installation matched all 159 committed source hashes. The evidence above now records this final
proof and source hashes. No existing database migration ledger was rewritten.


## Caller-private replay responses (API-12, ADR-024 D4)

A generated native-role reproduction found that platform.idempotency_keys protected company identity
but did not enforce the documented per-person response boundary. Same-company members and native
workers with copied human bindings could read a generated private response, and a person could insert
a replay row for another member. Migration 0750 adds restrictive SELECT and INSERT policies requiring
the native web login, user actor, exact membership/user match and active membership. It leaves
existing erasure metadata and DELETE paths intact and adds no security-definer function, grant,
configuration, API or event. Human SQL security review is pending. The same SQL applies to all modes.

All 22 native cases across private replay readers, existing replay/race semantics and business actions
passed. The stricter denied-insert assertions verify PostgreSQL 42501. A second run passed all ten
private-reader/replay cases but exposed seven failures in the existing erasure suite: the joined
expansion table inventory is not classified/granted for erasure, first naming
integrations.business_record_actions. The erasure path correctly refuses incomplete grants. This is
a separate outstanding joined-platform integration gap, not a passing lifecycle qualification.
All five production business HTTP cases still passed after 0750. Test TypeScript and focused ESLint
passed. A fresh ordinary-migrator installation applied 160 migrations and matched all 160 source
hashes, including canonical LF bytes for 0750; both policies are restrictive. Evidence and hashes are
in evidence/rc-idempotency-person-20261121.json. No real stored response or credential was inspected;
the reproduction used generated marker data only. No tenant data was erased.

The complete unit rerun after 0750 again passed 9,669 cases with the same two release gates, four
expected failures and 43 skips across 379 files, in 53.48 seconds. A catalog-only audit names 24 joined
content tables without erasure reach across business records, federation, marketplace, meetings,
sandbox, skills and residency requirements; this needs deliberate lifecycle integration, not a blanket
grant. No real content or tenant rows were read by that inventory query.


## Browser value revisions (EXP-02, QA-007)

Unattempted pending/approved business receipts now offer Change the proposal. The form edits existing
field values, an internal note, and every existing invoice line and optional terms. The authorized
stored proposal supplies the target, tool and source version; posted values cannot replace them.
Changing the target, selected field set or invoice line count still requires a new proposal. The
server resolves the actual tenant/person again, validates bounded known fields, then uses the shared
idempotent native revision service. A successful revision atomically closes the earlier approval and
creates a new immutable action/hash/review. Invalid values preserve the earlier action and entered
form values. These controls grant no new source access and make no provider contact in any mode.

Five focused parser cases cover target/version retention, other-field preservation, null versus empty
text, internal-only notes, all 200 invoice lines with exact decimal text and malformed/read-only
refusals. The first complete unit run caught direct ID form reads outside the required normalization
helper; those reads were fixed without weakening the guard. All eight parser/ID cases passed, then
the final complete run passed 9,674 cases with the same two release gates, four expected failures and
43 skips across 380 files in 66.74 seconds. Both production builds and web/test TypeScript passed;
focused final lint and 30-page guide generation passed. The five production API cases passed on the
first revision build before the form-ID helper correction; those API handlers did not change.

Generated production-browser journeys covered CRM revision, invoice decimal refusal with every value
and reviewer retained, corrected replacement review at 320 pixels with JavaScript disabled, and the
original reviewer seeing the old approval closed with no Approve button. A final-build browser request
submitted uppercase organization/action IDs and preserved exact six-decimal quantity/price, due date,
reference and memo in the new review. Inspected mobile screenshots showed no horizontal overflow.
The guide remains written_untested pending its independent/CI acceptance. Exact final source and
local evidence hashes are in evidence/rc-business-revision-browser-20261121.json. No migration, secret,
configuration, API/event contract or actual provider result was introduced.

GitHub inspection found PR #3's 14 checks green at 50bc1567f79d8a615d74e22ee87370a631ef77e8,
already an ancestor of this candidate. PR #2's historical failure was the member-owned consent
connection case in suite-tools on 2026-11-11. These are historical branch results, not current candidate
CI acceptance. The repository is currently public; no new candidate source was pushed or published.
The candidate still needs current joined integration/CI, complete portability and erasure coverage,
customer connector setup and the wider implementation and external acceptance gates above.


## Current suite connector regression (ADR-038 D6, QA-007)

Running the complete current suite-tools native file reproduced six failures: the test dispatch helper
used the web login with service-shaped bindings, which the native Work/effect reader boundary now
refuses. The helper and worker classification read now use the actual connector login. An explicit
negative check verifies the same web-login dispatch is refused with no attempt row before the actual
connector succeeds. All 24 final cases passed in 25.06 seconds, including initiator deactivation,
provider scope loss, revoked connection, lost source/folder access and member-owned consent. The
historical PR #2 consent case also passed. Test TypeScript and focused lint passed. This change is to
the fixture and denied-role coverage only; no production grant, policy, service or assertion was
weakened. Exact test/log hashes are in evidence/rc-suite-tools-native-20261121.json. It does not stand
in for a current candidate Actions run or a complete joined integration rerun.


## Broader integration diagnostic and native restore fixture (QA-007, ADR-026)

The actual current integration command with --bail=15 stopped early at 129.43 seconds. Its summary was
three failed files, one passed file, 30 passing and ten failing cases (179 files registered, 43 cases
reported). This is a bounded diagnostic, not a complete joined qualification. All six knowledge
retrieval cases passed, including the unchanged 20,050-chunk HNSW/hidden-nearest-source case in 58.869
seconds. The current broader run therefore provides a positive result for that case without widening
its 300-second limit or weakening its ACL assertions. It is not a load benchmark.

The failure group included incomplete expansion erasure reach and a restore preparation fixture that
constructed actual workflow activities with the web login. That fixture now opens the actual workflow
worker login, explicitly verifies web-login preparation is denied, and runs the real preparation and
artifact production through the worker. Its complete final file passed 11 cases and failed two in
28.55 seconds. The remaining failures are the erasure inventory refusal and the subsequent assertion
that its uncreated erasure witness exists. Generated artifact restore, raw source restore, current
proof drift, writer isolation and later restore debt cases now pass. Test TypeScript and focused lint
passed. No production policy, service, timeout or assertion was loosened.

The delegated-offboarding command also remains blocked: its native eraser catalog preflight runs
before delegated purge scheduling and refuses the joined tables without DELETE coverage. Merely
adding grants would not finish integration: skills/marketplace and federation have separate object
keys, and global listings reference tenant submissions/publishers and installations in other tenants.
The metadata inventory and those references need deliberate lifecycle/retention, blob proof and
cross-tenant treatment. No retention or external legal decision has been invented and no foreign
installation or user content was deleted. The exact 24-table catalog-only inventory is retained in
local evidence. The frozen /3 export still refuses tenants with pending module data; its 30-table
new-profile gate and 66 planned API operations remain open.

Evidence and exact native logs/source hashes are in evidence/rc-integration-current-20261121.json.
The temporary production server and the two task-owned generated browser sessions were stopped after
validation; their fixture data, source, screenshots and logs remain. The candidate is local and not
launch-ready. No source was pushed, production deployed or real provider contacted. About 27.8 GiB
remained free, so no disk cleanup was required and no original worktree, branch or volume was removed.

## Compact copper workspace checkpoint (UX-11 to UX-14, EXP-02, QA-007; 2026-11-23)

The owner explicitly authorized continuous GitHub pushes, required shadcn/ui and technical fonts,
rejected the summary-card visual direction, selected Linear as the compact workspace reference and
requested a distinctive comfortable accent. The current implementation uses muted copper on cool
neutral surfaces: light primary #94624c with white (5.11:1), dark primary #c79b84 with #271c17 (6.68:1).
The actual Linear list references were inspected through Mobbin; no brand assets or example content
were copied. The interface contract now records the owner's latest direction; owner visual acceptance
and independent human accessibility review remain pending.

Official shadcn/ui Radix Nova source components replace shared controls and semantic form/table/panel
primitives across public, workspace and administration pages. Sidebar menus, search dialog, organization
switcher, buttons, badges and feedback use those components. Native links/forms, safe draft preservation,
pending/confirmation behavior, semantic tables, native multi-select size and server authorization remain.
The three locally bundled font roles are Space Grotesk headings, IBM Plex Sans text and IBM Plex Mono
technical metadata, with their original OFL notices and system fallbacks for other scripts. The MIT
shadcn notice and exact font hashes are inventoried. No remote font service is required in any mode.

My work replaces the greeting and summary tiles with Assigned to you, Needs attention and Reviews URL
views, status-grouped rows and a contextual selection pane. The selected UUID must belong to the
current authorized queue, and the native detail service rechecks Work ACLs. Invalid, foreign, private,
unlisted and wrong-view selections return 404 without the title or pane. Reviews retain actual immutable
approval links. Search adds Ctrl/Cmd+K, Escape and focus restoration to the existing authorized GET page.
The optional light/dark preference is browser-only and carries no authorization meaning; pages without
scripts use the documented initial light theme. No migration, secret, provider permission, event or
public API contract changed. No provider was contacted and no production deployment occurred.

Verification for this checkpoint (HTTP cases preceded the final presentation-only hover correction;
the production build and six browser cases were rerun after it):

- Complete workspace TypeScript and repository lint passed; the production build passed. The solid
  primary-button hover pairs measured 6.64:1 in light mode and 8.57:1 in dark mode. Sixteen baseline
  formatting issues were corrected; parsed syntax/data structures were unchanged. Final changed
  browser/test-source checks are recorded with the source hashes in evidence/rc-workspace-copper-20261123.json.
- The complete default-worker unit run passed 9,672 cases and failed four: the two existing release
  gates plus guide-check and web import-walk timeouts under parallel load. The final complete run with
  --maxWorkers=4 passed 9,674 and failed only the same two release gates, with four expected failures,
  43 skips and 380 files in 86.21 seconds. No assertion or deadline was widened. The gates remain 66
  planned API operations and the 30-table portability inventory.
- Five real production HTTP Home/preview cases passed in 34.96 seconds; eleven unrelated cases in that
  file were filtered out. Five complete production business-proposal API cases passed in 19.02 seconds.
- Six browser cases passed in the final hover-corrected build: long-name sidebar visibility, scrolling and keyboard order
  in actual light/dark themes and the light native fallback, no-script preview/details/search, keyboard
  search submission/focus restoration, and explicit preference persistence. Initial fixture failures
  were corrected: second-company setup, the final Help link and theme setup on audit-created frames.
- Eight representative pages had zero automated WCAG A/AA findings in each actual theme. Axe ran in a
  separate audit context with CSP bypass solely for local audit injection; application CSP was unchanged.
  The native/browser journeys ran with the default production CSP. Queue widths 320/768/1024/1440 and
  the 320-pixel creation form showed no horizontal overflow. Captured light/dark queue and mobile form
  screenshots were visually inspected; this is engineering evidence, not owner design approval.
- Dependency license checks passed for 549 production packages, the draft inventory accounted for 527
  components, and 511 version pins passed. Legal review and image OS-package SBOM collection remain
  separate pending gates. No disk cleanup was needed; original source worktrees and volumes remain.

This checkpoint preserves the earlier platform changes and their release gates. It is not a completed
platform or launch qualification. Current joined CI/integration, module APIs, complete portability and
erasure reach, customer connector setup, durable/provider acceptance and human review remain open.
Commit d930fbf and its history were pushed to origin/codex/release-candidate before this UI checkpoint;
subsequent Git history records the UI push. Earlier statements of local-only status above are historical.

## Current Linux CI startup repair (QA-007, PLAT-11; 2026-11-23)

PR #4 at 12c6128 started Actions run 45144849819. Browser and connector jobs failed before tests:
`server.mjs` imported `./sigv4.mjs`, but the test overlay mounted only the entry file. The overlay now
mounts the complete two-file fake-model source directory read-only. No shipped image, runtime provider,
network permission or model assertion changed. On the existing isolated qualification stack, starting
only fake-model with --no-deps --wait succeeded and its internal /__fake/stats answered HTTP 200.
The focused Compose formatting check passed. This proves fixture startup, not application or provider
acceptance; the Linux integration jobs also reported separate native authority/lifecycle failures.
The shared runtime fixture repair is pushed as its own checkpoint before continuing customer connector setup.

## Customer business connection setup and current guide provenance (EXP-02, CONNECT-01, DOC-01, QA-007)

CRM, ticketing and accounting adapters can now be created through the existing production connection
API and actual shadcn forms, on explicitly operator-routed BYOM/Sovereign deployments. The default is
no business routes. Web and worker use the same bounded route parser; addresses remain server-only,
and no customer setting chooses a network destination. The optional compose.business.yaml supplies
three independent fixed-target relay profiles without credentials. It extends an existing configured
connector profile; that profile's SMTP dependency and the optional Paddle startup coupling are separate
integration concerns, not silently qualified by this slice. Cloud routes are refused until its
multi-tenant routing contract is implemented, as ADR-033 already requires.

Creation uses the real privileged connection service, selected stream allowlists, a sealed credential
reference, outbox event and current administrative MFA/SSO policy. The server derives the manual
credential's local permission ceiling from validated settings; this is explicitly not an OAuth provider
consent receipt. The source independently authorizes each request. Read-only is the form default;
reviewed changes require a separate choice and retain the existing immutable approval/receipt controls.
Creation is not a connectivity test. Records appear after successful native synchronization and source
ACL mapping; administrators gain no content access by their role. Revocation closes reads and the
worker revokes the sealed lease. No migration, database privilege, public API shape or real provider
credential was introduced.

Safe form choices survive validation, and an account-scoped memory draft supports client navigation;
credentials are never included. Identity proof is requested before showing the credential form when
company policy requires it, and the action rechecks before sealing and again at the actual write.
The form's own disclosure stays open on a refused native submission. A 320-pixel check exposed the
existing OAuth callback URL widening an implicit fieldset grid track; the shared track now uses
minmax(0,1fr), preserving the URL while allowing wrapping. User and operator guides describe actual
setup, source authority, profile prerequisites and remaining qualification.

Actual checks:

- Changing the native TLS fixture to the real createConnection service first reproduced three
  unsupported-type failures. After implementation, all ten native cases passed in 17.11 seconds:
  three connectors, actual sealed leases/TLS, two separate tenants, source-only access, repeat,
  revocation, wrong/untrusted TLS, policy-required MFA, foreign credentials and invalid scopes/targets.
- Four production setup API cases passed, including all three read-only types and idempotent replay,
  authorization/MFA and malformed target/scope refusals. With the business routes absent, all three
  negative cases passed (four configured-only cases skipped). On the final functional build, setup
  plus the existing business-action API file passed nine cases, with three unconfigured-route cases
  deliberately skipped, in 27.25 seconds. No provider contact is part of connection creation.
- Six final browser cases passed in 21.7 seconds: JavaScript and native business form refusal,
  retained choices, cleared credential and successful creation at 320 pixels; policy-required fresh
  identity; and the existing workbench native/search/theme regression. The complete page has no
  sideways overflow at 320 pixels, not just the cropped new form. Actual light/dark setup audits had
  zero automated WCAG A/AA findings; separate audit-only CSP bypass was used for axe injection.
  Browser/native journeys retained the production CSP. Rendered setup screenshots were inspected.
- The production build, final complete workspace typecheck, repository lint/format, 515 pin checks,
  draft 527-component license inventory and optional Compose configuration validation passed.
- The complete bounded-worker unit run passed 9,691 cases, failed the same two release gates, kept
  four expected failures and 43 skips across 382 files, in 85.38 seconds. The open gates remain 66
  planned API operations and the 30-table portability inventory. The first workspace typecheck found
  one test-only unknown JSON typing issue; it was corrected before the final complete passing run.

The current Linux quality log also named 207 missing historical guide-source references in a shallow
checkout. This slice updates 21 as part of its two guide revisions and rebinds the remaining 186 to
verified existing current files. The guide check passed with GIT_DIR pointed at an empty bare test
repository, so none of the old local refs was available. All 184 focused guide cases passed, and
rebuilding help after metadata rebinding left the generated content unchanged. Guide statuses were
not promoted: independent walkthrough and current Linux acceptance remain separate requirements.

Exact source/local-log/screenshot hashes are in evidence/rc-business-setup-20261123.json. This is a
bounded local qualification using generated fixtures, not live adapter, full Temporal, joined CI,
Cloud routing or product-completion acceptance. Expansion erasure/portability, remaining APIs,
provider and other previously recorded release gates remain open. About 24.7 GiB remained free;
no original source worktree, preserved history or Docker volume was cleaned or removed.

## Connector profile isolation and tenant-bound browser seeding (QA-007, PLAT-15)

The Linux connector job reached the corrected fake-model fixture, then failed startup on an
unconfigured Paddle relay. The base connectors profile also selected every unconfigured office-suite
relay. It now starts only the connector worker and required SMTP relay. Google relays require
suite-google, Microsoft relays suite-microsoft, and Paddle checkout-paddle, in addition to connectors.
No target is invented, no provider is contacted, and each selected relay still refuses an empty target.
The connector worker retains fixed private-address pins even for absent relays, preventing DNS fallback.
Operator instructions and generated help name the new profiles and the continuing SMTP prerequisite.

The browser seed's generated reminder update now binds its organization with the existing fixture
transaction helper and constrains the row by organization. This respects the mail-outbox trigger's
native tenant check. No trigger, production policy, notification or source-access check was weakened.

Local qualification:

- Seven complete browser guard cases passed in 53.9 seconds against the production server, including
  the shared world seed, invisible work, another tenant, origin guard and deliberate axe/error controls.
- Twelve resolved-Compose connector cases passed in 6.67 seconds. Three explicitly check that selecting
  one optional provider profile starts only that provider's relays. All relay network isolation,
  secret absence, fixed pins and default empty-target checks remain asserted, including Paddle.
  The exact native connector login replaces an obsolete shared-app secret assertion in this fixture.
- Actually starting only the generated, isolated Paddle gateway with no target failed unhealthy with
  egress_gateway.no_target and exit 1. That single task-owned container was stopped and removed after
  recording the refusal. No volumes, original services or other project containers were removed.
- All 184 guide checks, guide accounting, affected ESLint/Prettier, browser types and complete tests
  TypeScript project passed. All 515 pin checks passed. A first guide-test command named nonexistent
  files and did not run tests; the corrected command ran the two actual files and passed 184 cases.

Logs are retained under ignored .local/ci-*-20261123.log. This qualifies local fixture/configuration
repairs, not full Linux CI, provider delivery or production readiness. The full integration and
portability/erasure/API release gates still need further work.

## Native held-review projection and historical checklist regression (SEC-10, QA-007)

The actual-role artifact fixture first reproduced both positive failures under the web login:
its service could no longer prepare Work after native worker narrowing. Activities and service-only
writes now use the real platform-worker login; human reads, writes and SQL denial checks still use web.
The historical checklist-upgrade fixture uses the same split for its resumed activities and review request.

A new negative check then exposed a real gap: the legacy held-review SECURITY DEFINER projection
still accepted the web login with a claimed service binding. It returned exact candidate artifact IDs,
not file bytes, but that control projection belongs only to the platform worker. New migration 0751
narrows its EXECUTE grant and three private projection policies to the native worker, rejects SET ROLE,
and preserves every exact Work/version/run/requester check, bound, lock and selector restoration. It
adds no table, content grant, universal service role or changed human review payload. Its first lines
explicitly flag pending human security review; this is not an agent security approval.

Actual qualification: before fixture repair, two native artifact positives failed NOT_FOUND. After it,
nine cases passed and the new web-spoof denial failed because the projection really succeeded. After
0751, all ten artifact cases passed. The joined final artifact, worker-login and old-checklist upgrade
run passed all 20 cases in 24.42 seconds. It includes malformed exact targets, foreign tenants, wrong
versions/runs/requesters, app-written/deleted authority denial, no byte access for a service, real human
review hash equality, selector restoration, agent SET ROLE denial and worker SET ROLE denial. Existing
worker-login/delegation migration unit checks passed 39 cases. All data and file bytes were generated.

One earlier local test command omitted COMPOSE_PROJECT_NAME and attempted to recreate a stopped
default ensemus-postgres container. It could not bind the isolated fixture's already-occupied port;
no provisioning, migrations or tests ran from that launch. Its retained ensemus_postgres-data volume
was inspected intact, and the existing running stacks remained up. No data volume was deleted. The
reproductions and passing runs above explicitly used ensemus-rc-20261121 and its own test ports.

Ignored exact local evidence: ci-artifact-native-isolated-before-20261123.log,
ci-artifact-native-after-20261123.log, ci-artifact-native-qualified-20261123.log,
ci-native-review-regression-20261123.log, ci-native-review-regression-qualified-20261123.log,
ci-native-review-unit-20261123.log. The first regression run also caught the old checklist fixture's
same shared-login mismatch before that fixture was repaired. Linux CI and outside review remain owed.
