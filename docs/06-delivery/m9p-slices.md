# M9P slices

Twelve builders start in parallel from the foundation commit, and two more start once wave 1 and the M3 to M8 branches are merged. **No file has two owners.** The decisions are in [ADR-036](../00-foundation/adr/ADR-036-release-readiness.md), so read that first. It holds the reasons, and why this milestone has no migrations.

If you need a change to a file you do not own, or to anything in "Fixed" below, stop and report it. Do not work around it, and do not edit the file.

## Fixed: nobody changes these

| What | Where |
|---|---|
| **Database: nothing.** This milestone has no migrations, tables or roles (ADR-036 D1). No builder adds any | `packages/database/**` |
| Parity rules, catalog, contract, seams and harness | `tests/parity/rules.ts`, `catalog.ts`, `contract.ts`, `seams.ts`, `harness.ts` |
| The parity gate | `infrastructure/scripts/parity-gate.mjs` |
| The guide format and its checks | `docs/specifications/tools/guide-rules.mjs`, `guide-files.mjs`, `check-guides.mjs`, `build-help.mjs` |
| The list of guides and the exemptions | `docs/guides/index.json`, `coverage-exempt.csv`, `README.md` |
| The inventory's shape | `infrastructure/licenses/inventory.schema.json` |
| Gate wiring | `package.json`, `vitest.config.ts`, `tests/tsconfig.json`, `.prettierignore`, `tests/unit/gates.test.ts`, `infrastructure/scripts/run-all-gates.sh`, `.github/workflows/ci.yml`, `eslint.config.mjs` |
| Dependencies. `pnpm-lock.yaml` is frozen, and no builder adds a package | every `package.json` |
| Generated and listed at the final merge, never by a slice | `apps/web/src/generated/guides.ts`, `docs/MANIFEST.json` |
| Dockerfiles and compose files. **Report what they need under `docker_later`** | `infrastructure/containers/**`, `infrastructure/compose/**` |
| Decisions | ADR-036, this file |

A bug in any of these is reported, not fixed in passing.

## What runs where

This milestone is written in code-only mode. The owner decides when to start containers.

| Rule | Detail |
|---|---|
| **Never** | `docker`, `docker compose`, `pnpm test:integration`, `test:stack`, `test:browser`, `test:upgrade`, `test:parity`, `parity-gate.mjs`, `build-release.mjs`, any `prune`, any dev server or watch mode |
| Allowed | prettier, eslint, typecheck, `next typegen`, unit tests (`pnpm exec vitest run --project unit <paths>`), `pnpm test:replay`, and the dependency-free `node docs/specifications/tools/check-guides.mjs --pages-only` |
| Heavy commands | Every `pnpm install`, typecheck, eslint, `next typegen` and vitest goes through the slot wrapper your instructions name, with a 600000 ms timeout. Exit 75 means no slot yet, so run it again |
| Disk | Below 3 GB free on C:, stop and report |
| Unverified work | Parity, stack and browser tests you write are typechecked and have **not run**. Say so, and never report them as passing |

The test packages typecheck with `pnpm --filter @ensemus/tests typecheck`. It covers `tests/parity`.

## Every slice

- Follow the house comment style: say why, in plain sentences.
- No claims without evidence, and no invented prices, service levels, RTO or RPO numbers, certifications or legal terms. No real credential, address or provider. Generated values and `@example.invalid` only.
- Commit early, with several `-m` flags, the last being `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`. Do not push.

## The parity slices

Read `tests/parity/harness.ts`, `rules.ts` and `seams.ts`, then `tests/stack/product-flows.test.ts` and `tests/stack/pages.test.ts`, which already drive the product through its pages. Reuse `tests/helpers/forms.ts` and `flows.ts`, which you do not own. A slice's own helpers go in its `<file>-support.ts`.

A scenario file looks like this. The file name matches `catalog.ts`, and each key is a catalog ID. A file may implement only its own IDs, and must implement all of them.

```ts
// tests/parity/scenarios/work.parity.ts
import { describeParity } from '../harness';

describeParity('work', {
  'PAR-WORK-03': async ({ tenant }) => {
    const { organization, owner } = await tenant();
    // ...through the product's own forms, as tests/stack/product-flows.test.ts does...
    return { firstEdge: 'added', reverseEdge: 'refused', refusal: 'CYCLE', edgesStored: 1 };
  },
});
```

What a scenario returns is its **observation**. For a shared scenario it is compared across modes, so:

- Return what a person or client could see: statuses as stated, codes, counts and the order of states. Never IDs, names, addresses, times or URLs. The harness and the gate both refuse those.
- Return enough that two different behaviours could not look the same. `{ ok: true }` proves nothing.
- Assert inside the scenario as well. An observation is for comparing, and an assertion fails the scenario.
- A scenario that needs a seam calls `seam('modelSupply')` first, before any setup. An unplugged seam marks it `blocked`.
- A `mode_contract` scenario asserts against `expected('<dimension>')`, and returns that value in its observation, so it can never choose its own answer.
- If a behaviour does not exist yet, such as a route on a sibling branch, write the scenario against the seam or the route the plan names. **Do not make it pass by asserting less.** Never catch a failure to turn it into a pass.

### Denied and fault cases

A parity scenario *is* a denied case in most of this suite. Each one that says "refused" must show that it was refused, that nothing happened (a count, a state read back), and that the same thing happens in every mode. A second tenant is created with `tenant('Rival')`, using the same names where a name matters.

## Wave 1

### parity-work: `COMM-06`

Core Work Unit semantics in all three modes. These use only what M2 built, so most need no seam.

**Owns:** new `tests/parity/scenarios/work.parity.ts`, `tests/parity/scenarios/work-support.ts`.

**Implements:** `PAR-WORK-01` to `PAR-WORK-11` from `catalog.ts`, with `describeParity('work', { ... })`.

| Scenario | Holds | Must show |
|---|---|---|
| `PAR-WORK-01` | `WORK-01` | The sequence of statuses a person sees from creation to done |
| `PAR-WORK-02` | `WORK-01` | A stale edit is refused with the same conflict message, and the row is unchanged |
| `PAR-WORK-03` | `WORK-02`, `QA-004` | The reverse edge is refused, and one edge is stored |
| `PAR-WORK-04` | `WORK-04`, `QA-006` | Completion without evidence is refused, and status is unchanged |
| `PAR-WORK-05` | `WORK-03` | One owner. A delegate acts in scope, and is refused out of scope |
| `PAR-WORK-06` | `WORK-05` | A changed action voids the approval, and expiry is rechecked |
| `PAR-WORK-07` | `WORK-07`, `QA-014` | A paused approval resumes after `compose('restart', 'worker')`, using the helper in `tests/helpers/stack.ts` as `tests/stack/workflow-behaviour.test.ts` does |
| `PAR-WORK-08` | `UX-17` | An approver sees a notice and a reminder in the inbox, with no external channel |
| `PAR-WORK-09` | `API-12` | The public API's error envelope for malformed input and for a missing resource |
| `PAR-WORK-10` | `API-13` | Reconnecting on `onReplica('web-2', ...)` shows the same durable state |
| `PAR-WORK-11` | `LIFE-01` | A deleted item stays gone, on every path that served it |

**Do not** add a seam: if one looks necessary, report it. Run the typecheck on `@ensemus/tests`.

### parity-boundary: `COMM-06`

What no plan or mode may weaken ("no plan-specific weakening of core security boundaries", `05-commercial-modes.md`).

**Owns:** new `tests/parity/scenarios/boundary.parity.ts`, `tests/parity/scenarios/boundary-support.ts`.

**Implements:** `PAR-TEN-01` to `PAR-TEN-06`, `PAR-SEC-01` to `PAR-SEC-04`, `PAR-ACT-01` to `PAR-ACT-03`, with `describeParity('boundary', { ... })`.

| Scenario | Holds | Must show |
|---|---|---|
| `PAR-TEN-01` | `QA-001` | Tenant B asking for each of A's IDs, by page and by API, gets not found, and the answer holds none of A's text |
| `PAR-TEN-02` | `QA-002` | Two tenants with one client name each see one result |
| `PAR-TEN-03` | `QA-003` | Switching organization mid-stream emits nothing of the last. See `tests/stack/tenant-streams.test.ts` |
| `PAR-TEN-04` | `NEXT-01` | A forged Server Action for another tenant is refused and audited. See `tests/stack/server-actions.test.ts` |
| `PAR-TEN-05` | `ID-02` | An invitation grants only its organization |
| `PAR-TEN-06` | `UX-15` | A member sees only what their permissions allow |
| `PAR-SEC-01` | `NEXT-02`, `QA-018` | A generated canary in a document appears in no page, payload or log. See `tests/stack/canary.test.ts` |
| `PAR-SEC-02` | `NEXT-03` | A revoked permission is refused on the other replica while its cache is warm. See `tests/stack/replicas.test.ts` |
| `PAR-SEC-03` | `ASSUR-01` | The web container cannot open a connection to Temporal, as `tests/stack/platform.test.ts` shows |
| `PAR-SEC-04` | `QA-010`, `QA-011` | With `seam('modelSupply')`: restricted data is refused for chat and for embedding, and `callsReceived()` does not change |
| `PAR-ACT-01` | `QA-007` | With `seam('externalActions')`: the approval is void, and no effects |
| `PAR-ACT-02` | `QA-008`, `AI-TS-01` | With `seam('externalActions')`: one effect, and the status `unknown` |
| `PAR-ACT-03` | `QA-019` | With `seam('externalActions')`: one accepted, one effect |

### parity-modes: `COMM-06`

What runs on models and data, and then the differences the contract allows. Nearly all of this waits on seams, so it reports `blocked` until `parity-wiring` runs. That is correct.

**Owns:** new `tests/parity/scenarios/modes.parity.ts`, `tests/parity/scenarios/modes-support.ts`, and new `tests/parity/fixtures/agent-manifests.ts` (generated test manifests, valid and invalid).

**Implements:** every catalog ID with `file: 'modes'`, with `describeParity('modes', { ... })`.

| Scenario | Seam | Must show |
|---|---|---|
| `PAR-AGENT-01` | `agentRuns` | The same manifests are accepted, and the same refused with the same codes. Use `docs/specifications/schemas/agent-definition.schema.json` |
| `PAR-AGENT-02` | `agentRuns` | `QA-012`: ends `budget_exceeded`, with its code |
| `PAR-AGENT-03` | `agentRuns` | `QA-013`: ends `denied`, with its code |
| `PAR-AGENT-04` | `agentRuns` | `SEC-06`: queued and running work both end `stopped` |
| `PAR-KNOW-01` | `knowledge` | `QA-015`: served, then revoked, then not served at once |
| `PAR-KNOW-02` | `knowledge` | `QA-016`: the state stays disputed |
| `PAR-PORT-01` | `portability` | `QA-023`: the counts by record type are equal after import |
| `PAR-PORT-02` | `portability` | `QA-024`: with a generated secret, `archiveContains` is false |
| `PAR-MODEL-01` | `modelSupply` | `QA-009`, `AI-TS-02`: `unreachable` ends `denied`, and nothing else was called. BYOM and Sovereign |
| `PAR-MODEL-02` | `modelSupply` | `BYOM-TS-01`: after `rotateCustomerKey`, the key is not visible and the call is safe |
| `PAR-MODE-01` | none | The responsibility statement says what `expected('responsibility_statement')` means, in the mode's own words. **This one can run today** |
| `PAR-MODE-02` | `modelSupply` | `supplierUsed` equals `expected('model_supply')` |
| `PAR-MODE-03` | `entitlement` | `QA-027`: `inferenceBilledTo` matches `expected('inference_billing')`, with no double charge |
| `PAR-MODE-04` | `entitlement` | `QA-026`: paused, and nothing charged without asking. Cloud |
| `PAR-MODE-05` | `outbound` | `QA-020`: core work runs with zero attempts. Sovereign. Exercising the product is a real test. The packet count stays the air-gap gate's |
| `PAR-MODE-06` | `entitlement` | `QA-021`: after `lapseMaintenance`, work still runs |
| `PAR-MODE-07` | `entitlement` | `licenseCheck` is valid with no outside contact |
| `PAR-MODE-08` | `entitlement` | `QA-022`, `DEP-TS-02`: `tampered` and `unsigned` are refused, `intact` accepted |
| `PAR-MODE-09` | `outbound` | `SEC-05`: zero attempts over the round |

Numbers in an observation are counts. There is no price, allowance or limit anywhere in these. Use whatever the product's configuration holds.

### license-inventory: `LEGAL-05`

The tool that lists every distributed component's license for counsel. The review itself is owner-led. Read ADR-036 D7 and `infrastructure/licenses/inventory.schema.json`, and follow the rules/script split of `infrastructure/scripts/air-gap-rules.mjs` and `air-gap-gate.mjs`.

**Owns:** `infrastructure/scripts/license-inventory.mjs` (replace the stub), new `infrastructure/scripts/license-rules.mjs`, new `infrastructure/licenses/components.json`, new `tests/unit/license-rules.test.ts`, new `tests/unit/fixtures/licenses/**`.

**Implements, in `license-rules.mjs` (pure, no file or process access):**

```js
attentionFor({ licenseDeclared, textFound, version, declaredByHand }) // -> string[] from the schema's enum
npmComponents(byLicense, { distributedIn, licenseTextOf })   // pnpm's JSON, see below -> Component[]
mergeComponents(lists)                                       // one per name and version, distributed_in joined
composeImages(composeYamlText)                               // -> [{ image, service }] with @sha256 digests
imageComponents(images, declarations)                        // -> { components, problems }
sbomComponents(spdxJson, distributedIn)                      // OS packages -> Component[]
buildInventory({ release, sections, components })            // sorted, schema-shaped, review always the constant
checkProblems(inventory)                                     // -> string[] of what --check refuses
renderCsv(inventory)
renderNotices(inventory, licenseTexts)                       // first line says it is a draft counsel has not reviewed
```

**The CLI:** `node infrastructure/scripts/license-inventory.mjs [--check] [--sbom-dir <dir>] [--out <dir>]`.

- The default output is `.local/release/licenses/`: `license-inventory.json`, `license-inventory.csv`, `THIRD-PARTY-NOTICES.draft.md`.
- npm comes from `pnpm licenses list --json --prod --filter @ensemus/web` and `--filter @ensemus/worker`, which give `{ "<license>": [{ name, versions: [..], paths: [..], license, homepage, description }] }`. Find the license text under each `paths` entry, and hash it.
- `--check` is the gate: it needs no Docker, and exits 1 if `checkProblems` finds anything.
- With no `--sbom-dir`, the OS section says `not_collected`, with why. Do **not** run Docker or `build-release.mjs`.

**`components.json`** declares by hand what cannot be read yet: each `image:` in `infrastructure/compose/compose.yaml` that is not `ensemus/*`, and the `node:24-slim` base in `infrastructure/containers/Dockerfile.*`. Each entry has the license its upstream project publishes, evidence `upstream_repository_not_the_image`, and a `note`. Model weights are `none_distributed`, because it is an owner decision before M6. Read the upstream license from Context7 or the package where you can, and where you cannot, say `unknown`. **Do not guess.** A wrong license in front of counsel is worse than a flagged gap.

**Denied and fault tests (`tests/unit/license-rules.test.ts`):**

- A compose image with no declaration is a `checkProblems` entry.
- An image only in `compose.test.yaml` is not listed. `ensemus/web:local` is not listed as third party.
- `Unknown`, an empty license and SPDX `NOASSERTION` become `no_license_declared`, and `unknown` is never replaced by a guess.
- A missing license text gives `license_text_not_found`.
- `LGPL`, `GPL`, `AGPL`, `MPL`, `EPL`, `CDDL` and `EUPL` give `copyleft_family`. `SSPL`, `BUSL` and `Elastic` give `source_available_not_open_source`. `CC-BY` gives `attribution_family`. `A OR B` gives `dual_or_choice_of_license`. Each case is tested.
- `(MIT AND LGPL-3.0)` does not read as permissive.
- The output validates against the schema (ajv is a test dependency), and `review` is the constant however it is called.
- **No absolute path reaches any output.** The fixture paths hold a Windows user name, and the test looks for it.
- A section with `not_collected` and a non-zero count is refused. An empty npm collection is an error, not an empty inventory: pnpm failing exits 1.
- Every license `has_reviewed_exception_in_check_licenses` names appears in `check-licenses.mjs`, which a test reads.

Do not change `check-licenses.mjs`. It remains the separate gate.

### help-route: `DOC-01`

Shows the user guides in the product at `/help`. Read ADR-036 D5.

**Owns:** new `apps/web/src/app/help/page.tsx`, `apps/web/src/app/help/[slug]/page.tsx`, new `apps/web/src/components/guide-blocks.tsx`, new `apps/web/src/lib/guides.ts`, new `tests/unit/web-guides.test.ts`, new `tests/stack/help.test.ts`, new `tests/browser/specs/help.spec.ts`. Small additions in `apps/web/src/app/o/[organizationId]/layout.tsx` (a "Help" link in the main navigation), `apps/web/src/app/sign-in/page.tsx` (a link), and `apps/web/src/app/globals.css` (guide styles). Siblings touch those three too, so keep each change small and additive.

**Implements:**

```ts
// apps/web/src/lib/guides.ts, pure, so the unit test can inject pages
pagesFor(mode: CommercialMode, pages?: readonly GuidePage[]): readonly GuidePage[]
pageFor(slug: string, mode: CommercialMode, pages?: readonly GuidePage[]): GuidePage | undefined
sectionsFor(mode, sections?, pages?): readonly { section: GuideSection; pages: readonly GuidePage[] }[]
hrefOf(link: string): string                  // 'approvals#x' -> '/help/approvals#x'

// apps/web/src/components/guide-blocks.tsx, a server component
GuideBlocks({ blocks }: { blocks: readonly GuideBlock[] })
```

Types come from `apps/web/src/generated/guides.ts`, which holds no pages until `guides-sweep` rebuilds it, so the index page needs an honest empty state.

**Things to get right:**

- **No `dangerouslySetInnerHTML`.** Every block renders as React elements and text nodes. Links go through `hrefOf`, so the only places a guide can link are other guides.
- `/help` needs no sign-in, reads no tenant data, and takes only a slug. Get the mode from `getRuntime().config.mode`, as `sign-in/page.tsx` does.
- A slug not in the list, or a page for another mode, calls `notFound()`, the same answer as for anything else that does not exist.
- A `written_untested` page shows its banner: it is the first block, so render it, and never strip it.
- Keep it usable with JavaScript off, and with the design system's existing classes. Heading levels stay in order: the page's `<h1>` is the title, and guide blocks start at level 2.

**Denied and fault tests:**

- Unit: an unknown slug; `../` and encoded forms; a Cloud-only page in Sovereign; empty pages; a `javascript:` or `https:` href never survives `hrefOf`; text holding `<script>` renders as text.
- Stack: signed out works; signed in as tenant A and tenant B get the same bytes, with neither tenant's data; an unknown slug is a 404; a billing page answers 404 in Sovereign when the stack is in that mode, and is skipped otherwise.
- Browser: axe on the index and on a page, and keyboard navigation, as `tests/browser/specs/` already does. Written and typechecked, **not run**.

### The guide slices

These seven write the guides. Read `docs/guides/README.md` and ADR-036 D6 first.

**Owning a page means its Markdown file, and nothing else.** The list of pages is fixed in `docs/guides/index.json`. If a feature has no page, report it for `guides-sweep`.

**Finding what is real.** Your source is the code, not the specification. The specification says what should exist, and a guide says what does.

```powershell
git branch --list 'm3-*' 'm4-*' 'm5-*' 'm6-*' 'm7-*' 'm8-*'      # what exists right now
git ls-tree -r --name-only <branch> -- <dir>                      # what files it has
git show <branch>:<path>                                          # read one, without merging
```

| Milestone | Where it is |
|---|---|
| M1, M2 | This tree. Read the code, `tests/stack/*.test.ts` and `apps/web/src/lib/messages.ts` |
| M3 | `m3-foundation` is in this tree, and is mostly stubs. Behaviour is on `m3-verified-actions` and `m3-email`, `m3-intents`, `m3-receipts`, `m3-sdk`, `m3-webhooks`, `m3-stack` |
| M4 to M8 | `m<N>-foundation` and `m<N>-*`. They may be anywhere from nothing to finished when you read them. Check, and read their slice plan in `docs/06-delivery/m<N>-slices.md` with `git show` |

**A foundation is not a feature.** A function that throws `NOT_IMPLEMENTED`, a port that only ever answers `CAPABILITY_UNAVAILABLE`, a table no code uses, or a route that renders nothing means the feature is not there. Then the page is:

```text
status: not_in_product
sources: []
```

with `This is not in the product yet.` straight after the heading, plus one or two sentences on what is missing. Do not describe the plan. `guides-sweep` comes back to it.

**A page that describes something real** is `status: written_untested`, starts with the exact banner, and lists every file it was read from in `sources`, as a plain path if it is in this tree, or as `branch:path`. **Never set `tested` or `walked_through`.** Nothing has run in this mode, and the second is for a person.

**How to write it:**

- Use the words on the screen, exactly, from the pages and `messages.ts`. A reader is looking at that button.
- A user guide says what to do, what you will see, and what can go wrong. No architecture, and no words like Temporal, RLS or Drizzle. Keep it short.
- **Every page says what it will not do and what a refusal means**, under a heading such as "When it refuses". Use the real message, and say what to do next. Where it matters, say what another organization can and cannot see. This is the guide's denied case.
- Say where modes differ, using each page's `modes` list. Do not repeat a difference that is not real.
- `operator/` pages give exact commands, exact settings from `packages/config/src/index.ts` and `infrastructure/compose/`, and say what success looks like. Show how to tell it failed. Give no numbers you did not measure.
- Anything numeric about prices, service levels or recovery is the owner's, and is not stated. Say it is set by configuration or by the agreement, and end that line with `<!-- not-a-claim -->` if it needs the words.

**Check before each commit:** `node docs/specifications/tools/check-guides.mjs --pages-only`. Do not run `guides:build` or `regenerate-manifest.mjs`, because both write shared files.

**Tests:** these slices have none beyond the checker. Do not write a test to show a guide is right.

### docs-user-work: `DOC-01`

Everyone's first pages, from M2.

**Owns (`docs/guides/user/`):** `getting-started.md`, `home.md`, `members-and-invitations.md`, `people-and-teams.md`, `work-units.md`, `dependencies.md`, `evidence-and-completion.md`, `approvals.md`, `notifications.md`, `clients-and-projects.md`, `deleted-content.md`, `live-status.md`, `public-api.md`.

**Read:** `apps/web/src/app/**`, `apps/web/src/lib/messages.ts`, `packages/application/src/work.ts`, `approvals.ts`, `tests/stack/product-flows.test.ts`, `pages.test.ts`, `api.test.ts`, and `docs/specifications/openapi.yaml` for `public-api.md`, which also says how a key or session is used, and what errors look like.

### docs-user-data: `DOC-01`

Connections and external actions (M3), then search and knowledge (M5, M7).

**Owns (`docs/guides/user/`):** `connections.md`, `sending-email.md`, `sent-failed-unknown.md`, `webhooks.md`, `google-workspace.md`, `microsoft-365.md`, `mcp-tools.md`, `search.md`, `knowledge-and-citations.md`, `embeddings.md`, `memory-and-facts.md`, `removing-access.md`, `company-graph.md`, `custom-objects.md`, `company-pulse.md`.

**Read:** M3 first: ADR-027 and `docs/06-delivery/m3-slices.md` for what is meant, then the M3 branches for what is there. `sent-failed-unknown.md` matters most: a person has to understand that `unknown` means nobody knows, and that resolving it never sends anything. Then the M5 and M7 branches.

### docs-user-agents: `DOC-01`

Models and agents (M4, M5, M7).

**Owns (`docs/guides/user/`):** `model-providers.md`, `your-own-models.md`, `usage-and-budgets.md`, `data-classes-and-egress.md`, `agents-and-runs.md`, `agent-tools-and-approvals.md`, `delegation.md`, `stopping-agents.md`, `agent-output.md`, `agent-studio.md`, `assistants.md`, `outcome-composer.md`, `workflows-and-packs.md`.

**Read:** the M4, M5 and M7 branches. `your-own-models.md` keeps the caveat from `05-commercial-modes.md`: using your own models does not keep your data from Ensemus in the hosted service. `data-classes-and-egress.md` says what leaves, to whom, and how to see it.

### docs-user-admin: `DOC-01`

Running an organization (M6, M7, M8).

**Owns (`docs/guides/user/`):** `onboarding.md`, `sign-in.md`, `sso.md`, `mfa.md`, `exporting-your-organization.md`, `plans-and-credits.md`, `billing-and-invoices.md`, `sovereign-license-status.md`, `retention.md`, `legal-hold.md`, `closing-your-account.md`, `support.md`, `reporting-a-vulnerability.md`, `accessibility.md`.

**Read:** `apps/web/src/app/sign-in/**`, `packages/auth/**`, and the M6, M7 and M8 branches.

- `sovereign-license-status.md`: maintenance lapsing changes support status only.
- `plans-and-credits.md` and `billing-and-invoices.md` hold no price. Say prices are in the rate card shown to you.
- `support.md` and `reporting-a-vulnerability.md` name no address or hours, because those are the owner's. Say the agreement or the operator gives them.
- `accessibility.md` says what has been tested, and states that no independent audit has happened yet, with `<!-- not-a-claim -->` where it needs the word.

### docs-ops-install: `DOC-02`

Installing, configuring, upgrading and recovering. The first half of `DOC-02`'s acceptance: someone else has to be able to follow these.

**Owns (`docs/guides/operator/`):** `overview.md`, `install-compose.md`, `configuration.md`, `secrets.md`, `identity-providers.md`, `first-owner.md`, `upgrade.md`, `rollback.md`, `backup-and-restore.md`, `after-a-restore.md`.

**Read:** `infrastructure/compose/*`, `infrastructure/scripts/*`, `packages/config/src/index.ts`, `docs/05-operations/05-container-deployment-runbook.md`, `docs/05-operations/02-deployment-and-recovery.md`, ADR-024, ADR-025, ADR-026, `tests/stack/restore.test.ts`, `infrastructure/scripts/upgrade-gate.mjs`.

- `configuration.md` lists every setting the code reads: grep `process.env`, `readSecret` and the compose files, and note which are secrets and whether each is required. A test-only setting is marked as such, and is not presented as a production option.
- `overview.md` states the properties that matter to an operator, in plain words: the web tier has no path to Temporal and cannot unseal secrets, and the database roles are narrow.
- `after-a-restore.md` is ADR-026's ledger steps, including the operator confirmation before a file is destroyed.

### docs-ops-sovereign: `DOC-02`

Sovereign, and the shared release and outbound pages.

**Owns (`docs/guides/operator/`):** `offline-install.md`, `verify-a-release.md`, `license-issuance.md`, `offline-upgrades.md`, `advisories-and-branches.md`, `local-models.md`, `diagnostics-export.md`, `outbound-traffic.md`, `third-party-licenses.md`.

**Read:** the M6 branches, `docs/specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md`, `infrastructure/scripts/verify-release.mjs`, `build-release.mjs`, `air-gap-gate.mjs`, ADR-036 D7.

- **Never claim air-gap readiness.** The delivery plan allows that only after the offline acceptance test passes on released binaries. Say what the gate tests and what has not been done.
- Signing today uses a throwaway key, which the manifest says. Say so until the owner's custody decision changes it.
- `third-party-licenses.md` explains how to run the inventory tool, what its sections mean, and that its output is a draft for counsel, not a review.
- `advisories-and-branches.md` has no policy of its own: patch rights and supported branches are owner decisions, so say what M6 built, and that the policy is set by the agreement.

### docs-ops-run: `DOC-02`

Running the hosted service (M3, M8) and the parity gate.

**Owns (`docs/guides/operator/`):** `workers-and-workflows.md`, `connector-worker.md`, `observability.md`, `scaling-and-load.md`, `incidents.md`, `support-access.md`, `hosted-environments.md`, `provisioning-and-suspension.md`, `billing-operations.md`, `mode-parity.md`.

**Read:** `workers/workflow/src/**`, `packages/workflows/src/**`, ADR-027 D5 for `connector-worker.md`, the M8 branches, `docs/05-operations/*`, and `infrastructure/scripts/parity-gate.mjs` with ADR-036 D2 for `mode-parity.md`, which explains `proven`, `not_proven` and `failed`, and that the gate has not run yet.

- `support-access.md` states the default from the delivery plan and M8: no support access to customer content. Describe break-glass only as far as it is built.
- `scaling-and-load.md` and `observability.md` give no target number that was not measured.

## Wave 2

These two need more than wave 1. Start them only when the slices above and the M3 to M8 branches are merged into one tree. Whatever is missing at that moment stays `blocked` or `not_in_product`, and goes in the report.

### parity-wiring: `COMM-06`

Plugs the seams into the real code, so scenarios can run.

**Owns:** `tests/parity/wiring.ts`, new `tests/parity/wired/**`, new `tests/parity/fixtures/fake-provider.ts`, `tests/parity/fixtures/fake-mail.ts` and `tests/parity/fixtures/**` beyond what parity-modes added.

**Implements** each interface in `tests/parity/seams.ts`, one file each, such as `tests/parity/wired/model-supply.ts`, exporting one object, added to `wiring`:

```ts
export const wiring: Partial<ParitySeams> = { modelSupply, agentRuns, knowledge, portability, entitlement, externalActions, outbound };
```

**Rules:**

- Reach the product through its own forms, API or Activities, as the sibling's own tests do. Nothing shipped may change for this. If a seam truly cannot be met, report it, and leave it unplugged, so its scenarios stay `blocked`.
- A seam's real shape may differ from a sibling's types, so adapt here. **`seams.ts` is fixed**, and a change to it is a reported change to the foundation.
- A fake lives in `tests/parity/fixtures/` and is never a default code path. Each one uses generated values only.
- A fake reachable from containers needs a compose overlay. Do not write one. List the service, the network and the settings under `docker_later`.
- `outbound` shares its rules with `air-gap-rules.mjs`. A real count needs the firewall the air-gap gate installs. If only that gate can count, report `outbound` as not wirable from a scenario, and name what to change.
- Every seam gets a denied test of its own: a wrong tenant's call is refused, in `tests/parity/wired/*.parity.ts` only if it fits `describeParity`, otherwise in `tests/integration/parity-wiring.test.ts`.

**Where the real things are, as far as the sibling foundations show today.** Check the merged tree, because these may have moved.

| Seam | Start from |
|---|---|
| `modelSupply` | M4: ADR-028, `packages/intelligence/src/testing/*`, `tests/helpers/ai/*` (two-tenant seeds, canaries, scripted adapter). The router and profiles are slices `policy-router` and `model-profiles` |
| `agentRuns` | M4: slices `agents`, `spine`, `delegation`, `halt` |
| `knowledge` | M5: `packages/knowledge`, once its foundation and slices land |
| `portability` | M6: ADR-030, slices `export` and `import`, `tests/helpers/sovereign.ts` |
| `entitlement` | M4's `Entitlements.check`, whose result carries `billable` and `commercialMode`, and M6's `createSovereignEntitlements`. M6: `packages/sovereign`, slices `license` and `bundle`, generated keys from `tests/helpers/sovereign.ts`. M8: `COMM-01`, `BILL-05`, once they land |
| `externalActions` | M3: `tests/helpers/integrations.ts`, `tests/integration/fixtures/scripted-gateway.ts` |
| `outbound` | M6: slice `acceptance`, `infrastructure/scripts/air-gap-rules.mjs` |

Nothing here has run. It stays typechecked and unverified until the owner runs the gate.

### guides-sweep: `DOC-01`, `DOC-02`

The second pass over the guides, on the merged tree, and the step that makes `check:guides` pass in full.

**Owns:** every file in `docs/guides/user/` and `docs/guides/operator/`, `docs/guides/coverage-exempt.csv`, `docs/guides/index.json`, `apps/web/src/generated/guides.ts`, `docs/MANIFEST.json`, `README.md`.

**Does:**

1. Reads each page against the merged code. A `not_in_product` page whose feature has now landed is written. A page whose behaviour changed is corrected.
2. Rewrites every `sources` entry from `branch:path` to a plain path. A path that no longer exists means the page is checked again, not that the entry is dropped.
3. Adds pages for features with none (the guide writers' reports list them), with the index. Sibling milestones add tickets of their own, and `check-guides.mjs` names each one with no guide once they merge. M4 already adds `AGENT-15` and `AGENT-16` (`agents-and-runs.md`), `SEC-13` (`data-classes-and-egress.md`) and `SEC-14` (`operator/overview.md`). Add each to a page's `tickets`, or to `coverage-exempt.csv` with its reason.
4. Runs `node docs/specifications/tools/build-help.mjs`, then `node docs/specifications/tools/check-guides.mjs`, then `node docs/specifications/tools/regenerate-manifest.mjs`.
5. Reports, by page, what is `written_untested` and `not_in_product`, and which `needs_walkthrough` pages still need a person.

**Never:** sets `tested` unless the named tests ran in CI and that run can be pointed to, and never sets `walked_through`. Never removes a banner because a page "looks right".

## Merge recipe

1. Merge wave 1 in any order. No two slices share a file. In three small files help-route adds a line beside what siblings add, so keep both.
2. After every merge: `docs/MANIFEST.json` is regenerated, and never hand-merged, as is `apps/web/src/generated/guides.ts`.
3. Merge M3 to M8, then run wave 2.
4. `tests/unit/gates.test.ts`, `vitest.config.ts` and `tests/tsconfig.json` hold this milestone's additions, and sibling branches add their own to the same places (M4 adds projects and test folders), so keep both sides.
5. `check:guides` reports sibling tickets that have no guide until `guides-sweep` runs. That is the check doing its job, so do not exempt them to quiet it.
