# Source versions and team access, source follow-up

This follows the [M5 source checkpoint](source-checkpoint.md) and the parent integrator's client
privacy corrections. It implements the previously identified source-version and team-selector UI
gaps. It is local source/static evidence, **not M5, database, provider or browser acceptance**.

## Behavior

The source detail page shows the latest incoming revision separately from the document currently
available in search. A failed or rejected replacement leaves the older published revision available.
Readable source owners and authorized readable managers can submit a replacement through a native
Server Action using the existing `addDocumentVersion` service. Same bytes and name create no extra
version. A pending revision offers its real processing state and a progress link instead of a second
replacement control. Processing can raise sensitivity; a replacement starts with the source's current
classification and grants.

The service checks a fresh active human, source ownership or `knowledge.manage`, and live document
access before preparing a replacement, before putting bytes and before announcing it. A manager's
role/grant loss during a fulfilled put causes verified cleanup rather than publication. The original
human may settle that unchanged writer token after cleanup even after losing access; a delegated
worker cannot impersonate that human settlement. Unknown put outcomes retain their existing barrier.

The detailed source read holds a short source share lock so its published/incoming metadata agree
with source publication and grant changes. `canManage` uses the freshly read role, not an older
context role. Latest-version metadata stays under document RLS; unreadable managers receive no hidden
revision detail. This follow-up adds no content field, REST/OpenAPI expansion or model work in HTTP.

New uploads and source access use real people/team data and the domain grant rules. Restricted
sources offer named people only. Confidential sources may name people or teams; public/internal
sources may additionally name the organization. An ineligible previous sharing choice requires a new
explicit choice. Submit-time contracts and the fresh DAL remain authoritative. Existing wider grants
made ineligible by raised sensitivity are labelled ineffective rather than displayed as active access.

Forms reuse the shared buttons, errors, tokens and native labels. With JavaScript disabled, a person
can add the classified file privately and then use the source's real team-access form; the page
explains that route. No shared shell, global styling, runtime/worker file or earlier migration was
changed by this follow-up.

## Additive 0212 authority guards

`0212_knowledge_source_authority.sql` layers actual mutation checks over existing row-lock visibility:

- Human source creation is a fresh, self-owned upload. Human ownership rewriting is refused; no
  ownership is invented for legacy rows.
- Human metadata/grant mutations need the active source owner or `knowledge.manage`. A person cannot
  self-grant another source or substitute somebody else as the actual grantor.
- Human document and writer preparation additionally require a live readable upload and the actual
  uploader/starter. Existing class, lifecycle, tenant, source/document identity and exact writer-token
  checks remain active.
- Explicit trusted service ingestion/cleanup remains distinct from human, delegated and agent
  contexts. Original-human cleanup settlement remains available after role/grant loss; delegated
  settlement is denied. Body-read rights are not widened.

This uses triggers rather than an owner-only UPDATE `USING` policy, preserving authorized
`SELECT FOR SHARE/UPDATE` reads. The actor-to-membership binding is still the existing application's
trust boundary; these checks do not claim protection from a compromised application database role.
The migration is authored and has **not been applied or executed** here. Its journal entry belongs to
the final composition.

The synthetic source seed now records the actual supplied human grantor/uploader. When the requested
final ACL omits that uploader's named grant, a temporary actual-uploader grant makes creation
reachable and is removed after publication. The requested final ACL is preserved exactly. Service
seeds retain service attribution; delegated/agent contexts are never converted into humans. The
provider isolation fixture commits connection/ACL setup before a separate explicit service transaction
creates the connector source/documents. All guards stay enabled.

## Checks executed on 2026-11-07

The parent authorized a serialized light source slot. The formatter/lint target list is
[source-management.files.json](source-management.files.json).

| Check | Actual result |
|---|---|
| `pnpm exec prettier --check` on the 13 owned TS/TSX paths | Passed. |
| `pnpm exec eslint` on those 13 paths | Passed. |
| Focused unit command below, one worker | 10 files, 80 tests passed. |
| `pnpm --filter @ensemus/database typecheck` | Passed. |
| `pnpm --filter @ensemus/application typecheck` | Passed. |
| `pnpm --filter @ensemus/tests typecheck` | Passed after the approved provenance fixture field was supplied by its owner. |
| `pnpm --filter @ensemus/web exec next typegen` | Passed. |
| `pnpm --filter @ensemus/web exec tsc --noEmit --incremental false` | Passed. |
| `pnpm --filter @ensemus/browser-tests typecheck` | Passed. |

```powershell
pnpm exec vitest run --project unit --maxWorkers=1 --no-file-parallelism tests/unit/web-source-sharing.test.ts tests/unit/knowledge-input.test.ts tests/unit/knowledge-review-contract.test.ts tests/unit/web-knowledge-view.test.ts tests/unit/openapi-contract.test.ts tests/unit/knowledge-foundation.test.ts tests/unit/web-ids.test.ts packages/workflows/src/client-onboarding-step.test.ts packages/workflows/src/knowledge-purge-step.test.ts packages/workflows/src/knowledge-ingest-step.test.ts
```

A separate agent reviewed 0212 against 0201/0205 and the current source/object-writer code read-only.
It reported no new actionable authority or late-writer finding and explicitly retained the existing
actor-binding trust limitation. That review executed no database or tests.

No Docker, install, build, migration, real-role integration, replay capture, stack, browser, provider or
hosted command ran in this slot. The in-flight 0211 provenance implementation and its one required
restore-fixture `recordInputs` field remain owned by the provenance agent and are outside this scoped
follow-up commit.

## Authored, unexecuted coverage and remaining gates

- Five new direct-role cases cover ownership forgery, grant self-escalation/deletion, reader document
  and writer denial, original-token checks, delegated denial, and legitimate owner/readable-manager/
  explicit-service paths.
- Four service cases cover ordinary named-reader replacement refusal, unreadable/demoted managers
  including role loss after put, eligible/foreign/restricted team grants, and incoming/failed/published
  revision behavior with same-content retry.
- Five browser journeys cover replacement with and without JavaScript, hidden reader controls and
  stale access, and real team access/narrowing in both JavaScript modes. Accessibility/overflow
  assertions are authored. The existing forged wider-grant refusal case was adapted to the stricter
  selector. These journeys have not run or received visual approval.
- Three new pure sharing-rule cases are included in the executed 80-test batch. Those tests do not
  establish actual SQL enforcement or rendered accessibility.

The integrator still must apply/review 0212 with actual roles, run the direct SQL and role/grant-loss
barriers, exercise the built native forms and storage-backed revision journeys, and qualify rendering,
keyboard/no-JavaScript/accessibility behavior. The wider runtime, structured-input provenance,
provider, restore/erasure and milestone gates in the original checkpoint remain open. No full
Cloud/BYOM/Sovereign or production acceptance is claimed.
