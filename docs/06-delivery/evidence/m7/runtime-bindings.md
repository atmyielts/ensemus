# M7 real runtime bindings — source integration

**2026-11-07. Not runtime or milestone acceptance.** This follows the verified M5 checkpoint
`b568918` (3,084 unit and 1,486 real-role database checks), the preserved M7 source `c28e97e`,
Pulse rules `48e7f2c`, native interactive authority `d967fca` and Pulse implementation `248ca50`.
Their root composition is on `codex/m7-platform-integration`; main remains the verified M4 checkpoint.

## Implemented source

- Web and worker factories now use actual M4/M5 adapters instead of `unavailablePorts` for implemented
  agent registry, tools, assistant metadata, model readiness, Knowledge counts and measured usage.
  They contain no model transport, credential access or provider call.
- Assistant lists refresh the exact active viewer and filter readable Work before pagination. A detail
  read uses M4's actual timeline authorization. Returned reasons and step labels use fixed vocabulary;
  arbitrary uppercase text is not assumed safe. Stops record actual M4 controls, not false completion.
- Displayed money comes from canonical usage/rate-card records, including corrections. Missing pricing
  remains unknown, rather than becoming zero or being inferred from a pre-route allow decision.
- Pinning an older immutable agent version requires fresh native MFA, current publisher authority,
  the existing evaluation hash, exact spec hash and current policy compatibility. Publication changes
  serialize on the same definition lock as onboarding. Running agents retain their immutable version.
- A process acts through an actual delegated starter. A dedicated gateway validates its real process,
  immutable spec, exact step, starter, child Work and published agent definition; it writes the run,
  outbox and step reference atomically. A generic earlier run on the same Work is never adopted.
  Only a run already bound to this process/starter/Work can receive its delegated stop request.
- Process steps use the current Work creation kernel and form an actual parent/child hierarchy.
  A change in the root's classification stops later effects. The current root is locked while a step
  is checked; normal M4/M5 input, model and tool controls still apply afterwards.
- Nested application transactions use real savepoints. Successful nested bindings are restored before
  returning to the outer actor; failed SQL rolls back the savepoint and its bindings. Unbound reads
  remain unbound. The known binding set includes native session and scoped portability metadata.
- Ordinary Work reads, lists, approval eligibility and file serving use current Work/project/client
  authority before body selection. A Work owner/company admin does not bypass a private client grant.
  Current class includes the parent floor; earlier observations and content hashes remain historical.
- The previously stubbed Studio draft/simulation/review services now have source implementations.
  Draft compilation saves the exact canonical spec. Simulation admission saves a private immutable
  request-time input and actual outbox event; worker reports use the existing synthetic pure functions.
  Drafts cannot silently change what was rehearsed. No model or real tool executes in a simulation.
- Studio publishing joins actual M4 publication and activation through a real savepoint in the review
  transaction. Hash, passed scenario, current reviewer, native MFA and real result body/reference checks
  stay inside that transaction. Named reviewer assignments are immutable; changes require a new review.
  The policy advisory lock precedes author membership locks, matching member-disable administration.

## November 8 continuation — current boundary

Source checkpoint `f688b5d` adds 17 Studio HTTP operations, strict request contracts, actual native
forms and agent authoring pages. Review cancellation grants no authority and needs no fresh MFA.
Reviews pin both the responsible membership and display name; new agent service identities use that
actual reviewed responsible person while publication records the actual native signer. The real
M4 publisher now takes the policy lock before its membership lock.

`148fd8a` joins the private outcome composer and explicit company setup. Outcome authorization uses
the actual Work kernel and a protected Work-birth receipt; it does not adopt an earlier Work row or
start an assistant. Later Studio detail/rehearsal/review pages were recovered from the interrupted
agent checkout. A complete workflow editor and rendered acceptance remain open.

The full joined unit run passed **4,981**, failed **three**, and explicitly skipped **two** across
190 files. The three failures share an older stranded-recovery test double missing the newly added
export-expiry upkeep call. Only that double was corrected; its focused **five tests passed**. The
full rerun is still owed. Application/tests and actual Next typegen/web types passed before the last
screen recovery; later edits require their own checks.

Twenty new migrations are now registered (53 total), in dependency order rather than filename order:
0216, 0300–0303, 0400–0407, 0410, 0411, 0412, 0409, 0408, 0413, 0414. Isolated Drizzle generation
includes 145 tables, but the final checked-in snapshot and actual database metadata audit are pending.
**These new migrations have not yet passed the fresh database gate.** 0412 now also checks exact
released catalog workflow bodies, an actual approved review for graph publication, and native process
start authority. New real-role tests are authored, not executed.

### Actual PostgreSQL follow-up

All **53 registered migrations applied from fresh PostgreSQL** as the actual restricted migrator.
The first run exposed unexecuted PL/pgSQL CASE expressions in 0216/0301/0413 and a nonexistent
`agent_drafts.classification` reference in 0408. These were repaired without removing authority checks.
Draft export sensitivity now comes from a fixed helper: instructions receive at least internal
protection, declared confidential sensitivity is retained, and unknown/malformed answers refuse export;
selected sources still require their actual current class and named-viewer permission.

The five-file Studio/outcome/setup run first failed all 33 cases in generated membership fixtures
that did not bind the tenant required by the new export-epoch trigger. Fixtures now bind that real
row tenant rather than disable the trigger. The next run passed 29/failed four, exposing an ambiguous
SQL `spec` variable in real publication, a lowercase audit-reason value and the rollback fixture's
failure to inspect Drizzle's cause. After those repairs and another ownership-checked fresh database
reset, **32 passed/one failed**. That remaining assertion assumed zero existing events despite the
real `organization.created` event; it now compares the original event/outbox identities and checks
that no Work-birth receipt survives. Its focused rerun **passed one** (11 cases deselected). A full
post-fix rerun of these five files is still owed; these counts are not additive full-suite acceptance.

The isolated 145-table schema generation was compared with actual PostgreSQL constraint metadata.
Modeled PK/FK/unique/check names now have **zero missing entries and zero name mismatches**;
PostgreSQL's normal 63-byte identifier truncation is respected. New receipt/table declarations match
the actual named constraints, and the redundant idempotency unique declaration was removed while
its identical primary key remains. The final snapshot is chained to 0215.

Scoped formatting/lint, application/tests no-emit and actual Next route generation passed after the
screen recovery; web no-emit found one read-model optional-field typing mismatch, corrected by using
the actual snapshot reader's type. Its web rerun passed. Later schema/fixture edits still require their
joined source checks. No full database regression, new browser/Temporal run, actual provider,
restoration, physical lifecycle, hosted or independent acceptance is claimed.

The sections below describe earlier source work and its historical checks, not newer acceptance.

## Earlier SQL and checks

`0406_product_agent_binding.sql` adds tenant-safe draft-definition, process-agent-run and external-action
foreign keys, plus fixed direct-SQL process-binding and polymorphic publication-reference checks.
It is authored, **not journaled, snapshotted or applied**. Existing unknown references require repair;
the migration does not erase or silently rebind them. The other M7 SQL sources (0400–0405) also need the
combined migration gate; 0404 explicitly depends on the new 0216 model authority tables.

`0411_work_parent_authority.sql` adds current parent metadata/class and restrictive Work parent RLS.
Its public structured-lock OID is preserved and locks the exact current Work/project/client closure;
the object-record branch delegates to 0407's own metadata lock. `0412_studio_admission.sql` adds exact
draft compilation, private `studio.simulation_inputs`, native session/required-SSO admission without
forcing MFA on drafts/simulations, scoped worker reads and direct-SQL publication/reviewer backstops.
Both are authored **without journal/snapshot/application**. 0412 requires 0410; M6's later exact draft
export policies must be installed after 0412. New private simulation inputs must be erased before their
headers and must never be imported/exported as execution authority.

Root scoped formatting/lint and application/database/tests/workflows/worker/web no-emit checks passed;
web used actual Next route type generation. The first full joined unit run passed 3,850 and failed one
form-helper consistency check in Pulse. That form now uses the shared helper, and its focused rerun
passed eight tests; the full post-fix/post-Studio run remains pending. New actual-role cases cover metadata, stop requests,
private-before-limit filtering, stale/non-human authority, private reason text, immutable version pins,
actual compiled process binding, successful/failed nested transaction restoration, parent-client
revocation/class/lock barriers, Studio author/tenant/stale-version denials, immutable simulation input,
direct-SQL incomplete intent/reviewer/result denial and real publication replay. They are authored
and typechecked, **not executed**. Studio HTTP/UI, real Temporal simulation history and full journeys
are unfinished. Separate 0404 and Pulse source checks remain recorded in their own
reports; those counts are not runtime evidence for this composition.

Next: compose model admission/execution and M6 schemas, register migrations in dependency order,
run the actual-role suites against fresh PostgreSQL, repair any failures, then qualify real worker and
browser journeys. No provider, Temporal, built-image, hosted, accessibility or full usability acceptance
is claimed here. The required-SSO effect-time gap found after 0404 is being corrected separately in 0410.
