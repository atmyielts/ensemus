# Model bridge and platform runtime join

Source follows semantic merge `ce4e461` on `codex/m5-model-platform-join`, based on root `eb1dbbb` and
the preserved Knowledge model checkpoint `3ff8301`. It preserves root SQL, closed-tool, tenant,
onboarding, native-session and product registrations. Migration journaling, schema snapshots, actual
PostgreSQL and runtime acceptance remain owned by the integrator.

## Runtime behavior

- The actual agent Activity owns heartbeat/cancellation/halt watching before any auxiliary compilation.
  It passes the real run/step/attempt and combined signal, releases the watch on every path, then reads
  current counters and class again. Auxiliary turns/money/tokens are already counted; refusing the main
  call does not count another paid turn. Activity time is included in the remaining deadline.
- Knowledge's final context authorization uses the genuine `reason` router, actual immutable agent
  requirements, current profile pin and current tenant bundle. It cannot borrow an `answer` approval.
  Production composition always binds this check; optional customization can only tighten it.
- The main admission DAL inventories every retained influence: actual observations; flattened artifact
  inputs, records, sources and packages; every prior run package; and every canonical auxiliary call
  input, including candidates dropped later. It also checks current Work/project/client ACL/class scope
  as metadata without inventing a historical body read. Sources/documents are locked before catalogs
  and checkpoints, references are bounded and checked again under the run lock, and missing/hidden/
  unknown input authority refuses. Mutable historical hashes are not compared with current bodies.
- Before reservation and again immediately before the adapter, the actual gateway rechecks input class,
  current principal/step/profile/bundle and canonical money/token headroom. It includes already settled
  fallback ledger rows even before Activity counters post, and uses admitted token ceilings for unknown
  auxiliary usage. Existing live legacy holds and unknown paid auxiliary outcomes block further calls.
- Conservative generation input counts the actual SDK data-role fences, message framing, function
  names/schema, response format and model envelope. Money remains exact BigInt arithmetic. Actual
  provider overuse is charged, then its output is refused. A late class/ACL/content closure discards
  completion/proposal content while retaining the actual settled usage and counters.
- The trusted runtime marker is scoped to exact run/step/reservation attempt/cost and minted only by
  actual same-transaction admission. A failed later check clears an earlier successful scope. 0216
  guards legacy-main inserts on auxiliary-influenced runs; SQL-backed reserve also checks before the
  existing-hold path and rejects changed ceilings, including raced upserts. The new turn writer stamps
  a separate version marker, preventing older bundles from taking over an influenced step/old hold.
  These are runtime-version fences, not authentication credentials or new grants. Late financial
  settlement remains permitted; unknown paid calls are never silently released or replayed.
- Actual finish, terminal reclaim and initiator-loss cleanup permanently fence first, then invoke the
  real agent-role `reconcileRun` seam. Missing Cloud settlement authority still leaves work unresolved.
- Completion/proposal writes carry the exact originating model attempt, pin it before mutating content
  and use an auxiliary-influenced SQL result-write fence. A stale Activity cannot overwrite a newer
  attempt before the later `completeTurn` comparison notices it. Ordinary tool and late financial
  reconciliation paths retain their existing authority.
- Work observation producers in context source, compiler, fact subject reads and the exact deterministic
  checklist inventory now call the existing metadata scope lock and current structured Work class at the
  read point. Their hashes remain the own Work material actually read. Root's 0411 public helper/OID
  provides the current Work/project/client class and exact parent closure locks; it must be joined.
- Qualification and workload approval now default to actual native interactive privilege checks in the
  effect transaction (`model_profile.activate` / `model_workload.approve`). The original opaque native
  context is preserved. Fixture sessions use the real native verifier and auth-role second-factor proof;
  synthetic provider results do not constitute live-provider or production identity acceptance.

## Verification status

The bounded source gate on 2026-11-07 passed:

- Actual contracts/OpenAPI generator; scoped Prettier, ESLint (zero warnings) and `git diff --check`.
- 276 unit tests across nine files with maximum one worker: usage, main/Knowledge gateways, native
  embedding adapter, agent Activity lifecycle, model transport, model authority, API contracts and
  context compilation.
- All eight sequential noemit types: database, application, intelligence, Knowledge, workflows,
  worker, web and integration tests. Web used `tsc --noEmit`, without Next build/type generation.
- Necessary frozen offline ignore-scripts workspace linking reused 44 cached packages and downloaded
  none. No dependency version was changed. Current profile/policy SQL stays in the application DAL;
  worker composition does not add a Drizzle dependency. Agent Activities receive only an IDs-only
  terminal-accounting capability; no service context enters their content authority.

Initial unit failures were five old text-only reservation snapshots plus one unrelated tiny input
fixture; these were corrected to the new full-envelope behavior. Initial types exposed cached M7
workspace linkage and two generated test fixture shapes; the final focused run/types passed.

No PostgreSQL execution, Docker/build/browser, Temporal/provider, Cloud-credit or restricted-eraser
acceptance is claimed. The 0216 result/admission SQL and new real-role cases remain unexecuted.

New source regressions cover precompile cancellation/identity, auxiliary exhaustion, late output-class
closure, full input framing, post-lender denial, actual canonical headroom and retained document/client
floors, terminal accounting, old-bundle attempt refusal, existing-hold/upsert identity and scope reset.

## Remaining joins and limits

- Join root-owned 0411 ordinary Work/tool body DAL and current Work scope ACL/class functions. A final
  provider check does not repair an earlier unauthorized body read; this source gate did not execute
  those new SQL helpers or claim their actual-role qualification.
- Join actual `object_record` metadata helpers and before-material observation capture with 0407 before
  claiming those records as supported model/artifact inputs. Do not backfill reads or guess missing
  history. Unknown kinds currently refuse.
- Preserve root's newer product ports/transaction binding reset/0406 work when composing this branch.
  Add schema config, 0216 journal/snapshot and the 0216-before-0404 ordering in the canonical integration.
- M8's real approved Cloud credit holds, canonical standalone billing, hold-aware eraser dependencies,
  precise append-only grants/FK order and physical byte proofs remain explicit separate joins. No
  micro-USD/credit/currency conversion or estimated-usage correction is invented here.
- The current model-profile UI still offers its legacy text probe. A real native qualification/workload
  approval management flow must call the now-bound services; durable job APIs alone do not complete
  spend configuration. Missing approvals continue lexical/refused behavior.
- Run focused actual-role cases against a fresh joined database, then full unit/integration/replay/
  browser/offline/image gates. A source checkpoint is not a platform completion claim.
