# Account navigation and export access — source checkpoint

Scope: OPS-21 / COMM-05, ADR-032 D5 and ADR-030 export behavior. This follow-up does not qualify operators, providers or production recovery.

## Implemented source

- Account destinations use the existing shared `DestinationList` with capability filtering. Leaving links to the actual `/account/leave` page. Only owners see export/leaving; administrators retain their existing billing/support choices and members retain support. The description no longer implies every member can use owner controls.
- `/account/exports` is a real owner-only page using `requireAccountTenant`, the existing public-key request form and actual export list. It has an ordinary refresh link and offers a download only when M6 says the archive is ready and downloadable.
- An explicit account request action preserves the existing public-key/private-key refusal behavior. No key value is retained in error state. Data/import/core surfaces continue to use core admission.
- The four existing export HTTP operations opt into the account surface of the unchanged shared API wrapper. Native identity, origin, tenant membership, SSO and restore checks still run before the export handler. Imports receive no account admission.
- A narrow `@ensemus/application/saas/exports` adapter applies `accountContextOf` privately to only request/list/get/open-archive. It exposes neither a full-serving context nor a general writer to web callers. Each original M6 transaction verifies the actual native symbol, policy-before-member lock order, fresh same-user active owner membership and the existing0412 session proof. Required-SSO owner recovery follows the existing owner policy; non-owners are refused.
- The original M6 archive/epoch/part/manifest checks remain intact. The private transaction facade rechecks native owner authority at every existing M6 download checkpoint around storage. It holds no transaction across storage/network I/O and makes no promise to recall previously delivered bytes.
- The export list's legacy exclusion wording now names the actual work/file/client counters and points to other section omissions in the archive, rather than claiming those three counters account for every restricted record.

## Authored coverage

- Three pure destination cases cover actual owner routes, role filtering and unknown-role denial.
- Six real-role integration cases use actual native contexts, M6 requests, real source sections/sealing/manifest proof and an in-memory test object store. They cover suspended request/list/download, non-owner/non-human/unissued/foreign denials, unchanged core read-only behavior, private-key refusal, actual session expiry and actual owner demotion before streaming. The store checks no SQL transaction remains open during object reads. No ready export row, epoch or passing manifest is seeded.
- Three built-browser journeys cover JavaScript/no-JavaScript suspended-owner request and actual background-worker download, private-key refusal, member/administrator navigation, owner-only API access and continued core/import refusal. The new standing fixture uses the real standing service for explicitly generated tenants with no agent runs; it does not claim agent lifecycle qualification.

## Actual checks

Fresh bounded source checks on `codex/m8-account-exports`, based on root `2b8dfc3`:

| Command / scope | Actual result |
| --- | --- |
| `node node_modules/prettier/bin/prettier.cjs --write` and `node node_modules/eslint/bin/eslint.js --max-warnings 0`, scoped to 14 changed TypeScript/TSX files | Passed; the one subsequently corrected test file was formatted/linted again |
| `pnpm exec vitest run tests/unit/web-account-destinations.test.ts tests/unit/navigation-model.test.ts tests/unit/portability-epoch.test.ts tests/unit/sovereign-rules.test.ts --maxWorkers=1` | 41 passed in 3 files; epoch suite initially could not load due to the inherited missing SaaS workspace link |
| `pnpm install --offline --frozen-lockfile --ignore-scripts` | Authorized cached link repair; lock up to date, resolution skipped, zero downloads; no lock/version/resolution change |
| `pnpm exec vitest run tests/unit/portability-epoch.test.ts --maxWorkers=1` | 8 passed after the link repair |
| `pnpm exec vitest run tests/unit/openapi-contract.test.ts --maxWorkers=1 -t "the key field on the export form\|streaming an archive"` | 11 passed; 35 unrelated cases excluded by the explicit name filter |
| `pnpm --filter @ensemus/application typecheck` | Passed |
| `pnpm --filter @ensemus/tests typecheck` | Passed after correcting an owned unsupported `describe.sequential` modifier to the ordinary sequential suite; no test disabled |
| `pnpm exec tsc --noEmit -p tests/browser/tsconfig.json` | Passed |
| `pnpm --filter @ensemus/web typecheck` | Route generation and TypeScript passed |

Overall 60 unit cases passed across 5 distinct files. The source slot was released immediately after the final type command. The six real-role integration cases and three built-browser journeys remain unrun. No database, Docker, build, browser, operator or provider operation was executed for this follow-up.

## Boundaries

No tenant-helper, shared API-wrapper, model, schema, migration/journal or global navigation/CSS changes. Original export worker registration and storage remain actual deployment prerequisites. Missing/failed runtime export proof remains a failure or unavailable download, never fabricated completion. Cloud/BYOM/Sovereign acceptance and actual suspended export/download remain unrun.
