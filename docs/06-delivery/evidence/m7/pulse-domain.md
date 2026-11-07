# Pulse pure-domain foundation

Source follow-up on `codex/m7-pulse` from checked M7 join
`c28e97e2d1181e8b1f8017fc56df4adb84b9d7e8`. Scope: WORK-09's domain foundation,
supporting QA-029/QA-030. This is not completion of Pulse, M7, or its database/UI
acceptance.

The checked join's recorded baseline had 26 failures in
`packages/domain/src/pulse.test.ts`: `deriveSignals` still threw
`NOT_IMPLEMENTED`, and `pulseSignalKey`, `parsePulseSignalKey`, `personalStateOf`
and `snoozeEndIsAllowed` were absent. That historical failure record is in
`platform-join.md`; it is not a newly executed before-result here. All inherited
tests remain enabled and unchanged in their acceptance assertions.

## Implemented behavior

The implementation follows ADR-031 D4 and the existing Work Unit date/terminal
rules. It has no database, network, model, provider, clock or global tenant-data
cache access. The caller supplies the current time and already-readable facts.

| Fact | Signal / evidence |
| --- | --- |
| Open Work whose due UTC calendar day has passed | Overdue; link to that Work. Due earlier today remains due soon. |
| Open Work due within the next 48 hours, inclusive | Due soon; link to that Work. |
| Open Work with a known incomplete prerequisite or disabled owner | Separate factual signals, each linking to Work; no causal assertion or person score. |
| Pending approval still decidable and expiring within 24 hours, inclusive | Watch signal; approval plus its readable Work. An already-expired approval is not called pending. |
| Unknown external action | Attention signal even on finished Work; unresolved delivery remains unresolved. |
| Failed external action, failed process, or stopped agent | Attention signal on open Work, with its source record and readable Work. Deliberate `STOPPED_BY_PERSON` / `WORK_STOPPED` agent stops are omitted. |

Only `completed` and `cancelled` Work are terminal here, matching the existing
kernel; `failed` Work can be reopened. Supporting records never produce a signal
without a valid matching Work fact. IDs and keys use canonical lowercase UUIDs.
Malformed grouping IDs become absent grouping rather than a copied label.

Identical repeated facts collapse. Conflicting or invalid snapshots of one record
have no authoritative winner and are omitted independent of input order. Invalid
or future observation times, unknown Work states and malformed record IDs do not
become established facts. Stop reasons use known M4/M7 control codes; unknown
text, including uppercase text, gets a generic failure reason. Evidence contains
IDs, fixed codes and dates only, with no copied provider/model words.

Signals sort by attention before watch, then their conservative `since` marker,
then stable key. `since` uses the later of the current Work observation and a
derivable due-window boundary, or the supporting record's observation. This is
not a claim to know the complete historical duration of a condition. Input records
and Date objects are not mutated or aliased into the returned evidence.

The four missing helpers are implemented. Key parsing accepts only known signal
kinds and exact UUID syntax; it does not trim extra text or accept prototype-like
keys. Missing, malformed or expired personal state reads as open. Dismissal is
explicit and remains until withdrawn. Snoozes must have a finite, future end no
more than **30 days** away, inclusive, using exported `PULSE_MAX_SNOOZE_DAYS`.
The owner approved this explicit product bound during this follow-up so snoozing
cannot silently hide signals indefinitely. The future mutation service must use
the same helper, and must reauthorize the signal against fresh viewer access.

## Source checks

The authorized serialized source-check batch ran in this checkout:

| Command | Actual result |
| --- | --- |
| `pnpm exec prettier --write packages/domain/src/pulse.ts packages/domain/src/pulse.test.ts` followed by `--check` | Both passed. |
| `pnpm exec eslint packages/domain/src/pulse.ts packages/domain/src/pulse.test.ts` | Passed. |
| `pnpm exec vitest run --project unit --maxWorkers=1 packages/domain/src/pulse.test.ts packages/domain/src/domain.test.ts` | **2 files, 81 tests passed**: all 26 inherited Pulse cases plus 10 new cases, and the adjacent Work/policy rules. No test was disabled or marked skipped. |
| `pnpm --filter @ensemus/domain typecheck` | Passed; the four missing helper exports are resolved. |
| First `pnpm --filter @ensemus/application typecheck` | Failed on the reused checkout's absent M7 `@ensemus/packs` workspace link and consequent process-run diagnostics. No Pulse diagnostic. |
| Integrator-authorized `pnpm install --offline --frozen-lockfile --ignore-scripts` | Passed: 22 workspace projects, 44 cached packages reused/added, zero downloads; resolution skipped and lockfile unchanged. No scripts ran. |
| Rerun `pnpm --filter @ensemus/application typecheck` | Passed. |
| `pnpm exec tsc --noEmit -p tests/tsconfig.json` | Passed. Typechecking existing integration files is not their execution. |

Ten additional pure regressions cover day/window boundaries, canonical IDs,
duplicate conflict refusal, private stop text, invalid observations, input
immutability, strict keys and the exact 30-day snooze bound. Existing randomized
determinism, evidence and person-minimization checks remain enabled. No source
fix was needed during the check batch; only the inherited workspace-link setup
needed the authorized cached repair.

No DB, Docker, build, browser, HTTP, migration or provider gate ran for this
checkpoint. No test results from the earlier M5/M6 branches are added to these
81 tests.

## Open integration work

`packages/application/src/product/pulse.ts` remains an explicit unfinished stub.
This checkpoint does not bind or advertise it. Fresh tenant/ABAC filtering,
bounded database reads, active pending/failed/stopped source selection, per-viewer
RLS dismissal persistence, unavailable-port partial results, API/routes, native
forms, evidence links and browser accessibility are still separate work. A pure
Work-ID intersection cannot replace those actual read-authority checks.

No migration, contract, event, secret, dependency or mode setting changes here.
The pure behavior is shared across Cloud/BYOM/Sovereign; their real role and UI
bindings have not been executed or qualified by this follow-up.
