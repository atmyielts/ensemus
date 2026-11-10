# Pulse per-viewer source slice

Source follow-up to pure-domain checkpoint `48e7f2c` on `codex/m7-pulse`,
WORK-09 / QA-029 / QA-030. This is not M7, database, provider, deployment or
accessibility acceptance. Only this follow-up's later recorded commands can
qualify its current source; the earlier 81 tests belong to the pure checkpoint.

## Implemented source

`product/pulse.ts` now reads real records in a tenant transaction. Each call
requires a person and refreshes the exact active user/member and role. SQL applies
the Work kernel's visibility predicate and named-viewer central metadata predicate
before ordering, limits or counts. Work shares are bounded. The overview includes
up to 200 readable open Work records or finished records with unresolved external
actions, with an explicit partial marker when its review limit is reached.
Approvals/external outcomes and assistant/process metadata each have bounded
200-record reads and their own partial code.

The separate `pulse-metadata.ts` adapter reads actual M4 agent-run and M7
process-run identifiers, outcomes, controlled stop codes and times. It does not
read transcripts, step payloads, prompts, provider responses, credentials, or
invent assistant-control methods. The shared assistant/product ports remain
unchanged. Missing declared metadata capability or a missing source table is
reported partial through a SQL savepoint. Unexpected infrastructure or authority
errors propagate, never becoming an empty healthy result.

Scope IDs require current project/client readability; private linked metadata
does not leak through grouping. A prerequisite is reported incomplete only when
its Work is readable. Work titles are enriched only after current viewer
authorization; no person labels or scores are included. Summary labels explicitly
refer to reviewed records rather than asserting organization-wide completeness.

Personal preference writes are person-only and obtain fresh member/Work locks.
The canonical key resolves to its real readable source, and a focused projection
recomputes that exact risk before mutation, independent of the overview's limit.
Users cannot name another member. Dismissal/snooze/open affect only the current
member, and snooze uses the approved finite future/30-day helper. Identical writes
do not duplicate the preference effect. No new MFA requirement is introduced.

## Policy and contracts

Reserved `0405_pulse_personal_state_authority.sql` replaces only the existing
restrictive personal-state policy. The old policy matched only user ID; a genuine
delegated/agent context could therefore impersonate that person's preferences.
The new predicate requires actor `user`, the exact active current membership,
same user and tenant, on SELECT/INSERT/UPDATE/DELETE. No grant is widened. This
policy-only migration changes no Drizzle table schema; root owns its ordered
journal registration with 0400–0404. It has not been applied here.

The approved service adaptation uses a narrow Pulse metadata reader instead of
the unrelated full assistant control port. `CompanyPulse.partial` now also
represents bounded Work/approval/action coverage, and its view has fresh Work
titles. Domain evidence remains IDs/codes/dates only.

Only Pulse's actual GET overview and documented PUT personal-state operations
lose their OpenAPI planned marker. Their runtime contracts and explicit snake-case
serializer allowlist the real fields. All other planned M7 operations remain
planned. Contract artifact regeneration awaits the authorized source-check slot.

## Interface source

The overview and focused evidence page reuse the existing shell, headings,
buttons, action gate, status styles, spacing and native forms. Dismissed and
snoozed signals remain inspectable/restorable only for the current viewer.
Partial and empty copy states what was reviewed and does not promise that absent
signals establish a healthy company. Unknown delivery stays distinct from sent.
No score, ranking, causal explanation, feature-local palette or sidebar exists.

Evidence links use existing Work, approval and external-action pages. Because
this checked M7 tree has no process-run detail page, a focused read-only Pulse
evidence route recomputes and displays the actual current source record. IDs and
controlled diagnostic codes are optional details. Navigation/global files remain
root-owned; qualification should expose Pulse contextually through the shared
Home/navigation model.

## Authored gates and current result

The authorized serialized source-check batch ran in this checkout:

| Command / scope | Actual result |
| --- | --- |
| `pnpm exec prettier --write` then `--check` on the 15 changed TS/TSX files and application export JSON | Final pass. The final check needed one additional whitespace-only formatting pass on the integration test. |
| `pnpm exec eslint` on the same 15 TS/TSX files | Passed. |
| `pnpm --filter @ensemus/contracts generate` | Passed with the real pinned generator; only the actual Pulse OpenAPI/DTS fields were added. |
| `pnpm exec vitest run --project unit --maxWorkers=1 packages/domain/src/pulse.test.ts packages/domain/src/domain.test.ts packages/application/src/product/pulse.test.ts tests/unit/pulse-contract.test.ts tests/unit/openapi-contract.test.ts` | **5 files, 112 tests passed.** This includes the earlier pure rules, not an additional 112 on top of 81. |
| `pnpm --filter @ensemus/contracts typecheck` | Passed. |
| `pnpm --filter @ensemus/application typecheck` | Passed. |
| `pnpm exec tsc --noEmit -p tests/tsconfig.json` | Passed; actual-role cases remain unexecuted. |
| `pnpm exec tsc --noEmit -p tests/browser/tsconfig.json` | Passed; browser journeys remain unexecuted. |
| `pnpm --filter @ensemus/web exec next typegen` followed by `pnpm --filter @ensemus/web exec tsc --noEmit --incremental false` | Both passed. |

No implementation, unit or TypeScript failure occurred in this batch. No install
ran. The final UI review removed an inaccurate primary "observed by" label:
`since` is only an ordering marker, not proven condition history. The replacement
neutral copy passed its separately authorized one-file format/check; no broad
suite was repeated for that text-only correction.

Explicit OpenAPI formatting initially normalized unrelated older text. The final
diff restores every unrelated baseline section and retains only the two Pulse
path blocks plus `CompanyPulse`/`PulseSignal` schema blocks. The pinned generator
was rerun after that narrowing, and the generated DTS SHA256 remained identical
to the already typechecked artifact. The single OpenAPI unit file then passed
26/26 again; this confirmation subset is not added to the 112-test total. No
final whole-document formatting claim is made for preserved baseline text.

Twelve authored actual-role cases cover
restricted Work/member/admin/foreign refusal, fresh assignment removal, own
preferences, finite snooze, direct RLS service/delegated/agent/disabled denial,
actual M4 private-code minimization, actual failed-process evidence, partial
capability versus infrastructure error and pre-limit privacy/truncation.

The browser/API journey source covers native and JavaScript-disabled evidence,
personal dismissal/restoration/snooze, another viewer, strict GET/PUT contracts,
forged identity/overlong snooze rejection, narrow overflow and axe checks. These
are authored/typecheck targets, not browser/accessibility execution claims.

No SQL apply, DB, Docker, build, HTTP/browser, native identity provider, model or
external side effect ran for this follow-up. Cloud/BYOM/Sovereign share this
metadata-only behavior with no egress, but their runtime acceptance remains open.
