# Custom objects source checkpoint

Scope: KNOW-07, QA-037, QA-038; ADR-031 D11. Based on root `c5d8726`, isolated
branch `codex/m7-objects`. This is source implementation evidence, not completed M7,
database, HTTP, browser, Temporal, provider or operator acceptance.

## Implemented source

- Human-only fresh membership/role checks in the real DAL, with tenant RLS and
  record owner/class checks before SQL paging, filtering and relationship reads.
  Restricted records remain owner-only, including against an organization admin.
- Validated custom types, immutable hashed schema versions and refusal of unsafe
  migrations. Records keep their pinned schema. Type floors only rise; record
  scope can lower only above that floor with the existing native recent-MFA
  action. No delegated/agent context becomes a human.
- Optimistic record edits, exact derived index rows in the same SQL transaction,
  declared same-tenant relations, and atomic one-valued slots that include hidden
  endpoints. Native forms preserve safe submitted values on ordinary refusal.
- Durable per-record migration results; invalid rows retain their content and old
  version and count once. Any failed row makes the terminal job failed. Transient
  database faults retry with durable bounded backoff; known permanent refusals
  terminate. Explicit human retry creates a new intent and retains old outcomes.
- Real leaf API/routes/pages and shared components, native forms, safe URL
  rendering, permission-filtered selectors and paging. Creation keys retain only
  IDs, followed by a fresh authorized reread; private response bodies are not
  replayed from an idempotency cache.
- Metadata-only `object_record` entries and type floors join the existing
  structured source policy. Soft deletion closes live metadata and retains a
  tombstone. Historical hashes remain historical; routine content edits do not
  pretend that an earlier read used the new body.

Canonical schema hash: SHA-256 of UTF-8 `canonicalJson({fields, relations})`, using
`@ensemus/domain/approval`. Array order is retained. Every pinned shape is checked
against its stored hash before application use.

## Schema and integration boundaries

`0407_object_record_authority.sql` is additive source, **unregistered and unrun**.
It introduces `objects.migration_results`, `objects.type_acl_catalog`, and
`objects.relation_slots`; the owned Drizzle schema is
`packages/database/src/schema-object-authority.ts`. It adds record/type authority,
derived indexes, relationship slots and metadata serving/locking helpers.

The original public structured-function OIDs are preserved: fixed original
definitions are copied to internal helpers, then the public bodies are replaced.
This avoids leaving already-parsed RLS/view expressions on old function OIDs.
Independent source review identified and corrected that issue before execution.

Mandatory composition still owed:

- Root `0411` Work/project/client scope helpers and parent-closure locks. The
  `work_unit` wrapper calls the new helpers without an old Work fallback. Missing
  helpers refuse. `objects.lock_record_authority(uuid)` is the isolated object
  metadata/type-floor lock branch root must preserve.
- M6 `0408` binds named export-owner reads to its actual immutable running export,
  before LIMIT, and advances the real export epoch on relevant object changes.
  Ordinary service reads of objects are otherwise limited to durable migrations;
  a filtered zero-row export is not acceptance.
- Root/M8 extend actual `0214` observations and `0216` model-input kinds with
  `object_record`, including strongest current type/record class. Ordinary object
  DAL body reads are currently person-only. A future agent read must capture its
  actual joined body/schema hash under fresh locks before material is returned;
  no old input history is backfilled.
- Restricted erasure needs the actual `ensemus_eraser` role and
  `lifecycle.erasure_open(org)` helper. Missing helper refuses. Relation DELETE has
  only that exact role/org/open-erasure exception. Source/artifact/structured
  positive lineage and physical-proof guards remain mandatory. Root must add the
  new tables to its exact whitelist/dependency order; no normal DELETE grant.
- Root shared navigation exposes Custom records beneath Knowledge. No feature
  sidebar, global styles, agent runtime or shared auth semantics were replaced.

All data remains in PostgreSQL. Events, audit references and Temporal payloads
carry IDs/codes, not attribute or schema text. No model, provider, credentials,
dependency, mode setting or Sovereign phone-home is introduced.

## Authored gates and actual results

The parent granted one serialized source-check slot. Final fresh results:

| Command/scope                                                                                                                                                               | Actual result                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm --filter @ensemus/contracts generate`                                                                                                                                 | Passed; pinned `openapi-typescript 7.13.0` and the actual JSON-schema generator |
| Scoped Prettier and `eslint --no-ignore --max-warnings 0`                                                                                                                   | Passed for 36 owned TS/TSX files                                                |
| Pinned Prettier comparison of the owned OpenAPI paths/schemas                                                                                                               | Passed; unrelated specification segments preserved exactly                      |
| `vitest run --project unit` on custom-object, product-policy, custom-object contracts, migration failure boundary, native object inputs and OpenAPI units, `--maxWorkers=1` | **144 tests passed across six files**                                           |
| Sequential database, domain, contracts, application and workflows package typechecks                                                                                        | All five passed                                                                 |
| `tsc -p workers/workflow/tsconfig.json --noEmit`                                                                                                                            | Passed                                                                          |
| `tsc -p tests/tsconfig.json --noEmit`                                                                                                                                       | Passed                                                                          |
| `tsc -p tests/browser/tsconfig.json --noEmit`                                                                                                                               | Passed                                                                          |
| Web `next typegen && tsc --noEmit`                                                                                                                                          | Passed                                                                          |
| `git diff --check`                                                                                                                                                          | Passed                                                                          |

The initial web check found four exact-optional-property diagnostics when Zod
optional fields met the domain types. The conversion now omits absent properties,
without widening domain types or casting them away; a new regression and the
focused units/web check passed afterward. Initial scoped lint also exposed the
shared `**/migrations/**` ignore catching two actual API routes. The final explicit
`--no-ignore` scoped lint checked both; root owns narrowing that shared ignore.
One unmatched worker package filter was replaced by the actual worker tsconfig
check above. No dependency installation was needed or run.

These results cover source only. No SQL, real-role database cases, built-stack
HTTP responses, browser journeys, actual migration worker execution, history
capture/replay, hosted mode or operator acceptance ran in this checkout.

Authored, unrun: twelve real-role cases (including cross-tenant/direct SQL,
restricted admin/filters/values, stale versions, MFA, live floor raises, terminal
failed rows, fresh role/disabled member and explicit retry); five built-stack
contract/authorization/idempotency/recovery cases, including an assertion that
every implemented custom-object operation had a validated successful response;
three browser journeys including no JavaScript, same-tenant private denial and
axe source; four required real-Temporal capture/replay histories. The replay gate
fails on missing histories rather than passing an empty corpus.

Read limits: at most 100 records/relations/selector choices per page, at most eight
indexed fields per type, 200 records per worker batch, and at most 200 types per
organization. No measurements or runtime performance results are claimed.
