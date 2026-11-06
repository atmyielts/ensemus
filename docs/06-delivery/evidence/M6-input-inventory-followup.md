# M6 input-protocol inventory follow-up

Date: 2026-11-07. Source base: `897da3c6b283f2aae7422153ebb053ee4dcd3d6b` on `codex/m6-integration`.

This follows the [portability source checkpoint](M6-portability-source-followup.md). It accepts no database migration, restore, provider, browser, bundle or operator gate.

## Reviewed data and portability decision

The owning schema, `0214_agent_input_protocol.sql` and `ai/input-ledger.ts` at actual M4 checkpoint `aa6c234402a311bdfadd468f0ac512c448efb5f5` were inspected before choosing dispositions:

| Actual table | Stored data | Portable disposition |
| --- | --- | --- |
| `ai.run_input_checkpoints` | Durable run admission, legacy-history completeness flag, permanent fence generation and actual-zero payload-erasure certificate | `operational_excluded` |
| `ai.run_input_observations` | Durable private read relationships: run/record/artifact IDs, hashes and classes; no bodies | `private_excluded` |
| `ai.run_output_writes` | Durable exact artifact/run/writer token and registered/started/settled admission state | `operational_excluded` |

None is a rebuildable search index, and none is imported as executable authority. Database backup/restore preserves these rows and their original safety meaning. Portable archives do not recreate checkpoints, complete flags, fence/purge certificates, private observations or admitted writers. There is no synthetic private-payload query and no application-role payload grant.

New exports declare exact profile `ensemus.m3-m5/2`. Explicit `/1` archives remain supported as inert imports and by the standalone customer tool, using their exact frozen table inventory. A `/1` declaration cannot disguise the `/2` list, or vice versa. Unknown/missing/duplicated entries or future profiles still refuse. The actual joined-schema check requires the current three tables and still refuses an unknown future table.

## Restore contracts and counts

The private-transcript contributor now counts real tenant metadata: runs, checkpoints, observations, missing checkpoints, legacy unknown histories, unfenced terminal runs, uncertified/certified fences and unsupported protocols. Missing modern checkpoints and genuine legacy `history_complete=false` are distinct conditions. Legacy unknown history remains durable attention, even when payload erasure was certified; the audit neither calls it a broken checkpoint nor upgrades its flag.

Metadata alone cannot certify a purge. The actual agent adapter must additionally return `transcriptProof` with protocol `ai.run_inputs/v1`, the actual supported `fenceGeneration: 1`, `checkedRuns`, `certifiedRuns` and actual `remainingPayloads`. Coverage must include the tenant's runs and current certified fences. Missing, under-covered or wrong-generation proof stays nonzero; positive remaining payloads are counted. This is a typed contract and runtime validation, not a substitute for the actual role/generation SQL checks in M4's adapter. No passing production adapter is invented here.

Derived-artifact audits also count output-write metadata. Registered/started tokens remain unresolved unless matching retained lineage positively certifies fenced physical erasure and the catalog is dead. Absent/mismatched lineage or catalog and mismatched run/write/generation tokens remain attention. A settled token is not interpreted as proof of physical erasure. No elapsed lease, absent HEAD or current metadata presence is used as a network-writer fence.

Contributor reports expose these explicit numeric metadata counts. `checked` counts inspected metadata rows; `needsAttention` counts unresolved conditions and can contain multiple conditions for one row. Only identifiers, enums and counts are added to this operator path, with no bodies in reports or Temporal.

The browser/server error text and removed/unavailable export descriptions now explain **data or access changes**, rather than deletion alone, and direct the person to request a new export. Error codes/statuses and all commercial modes are unchanged.

## Verification actually run

The owner granted one bounded serialized source slot. No failures or implementation fixes occurred during this batch.

- Prettier write/check and ESLint passed for all **13 changed TS/TSX files**.
- `pnpm exec vitest run --project unit --maxWorkers=1 --no-file-parallelism tests/unit/portability-inventory.test.ts tests/unit/portability-epoch.test.ts tests/unit/restore-contributor-inventory.test.ts tests/unit/restore-input-metadata.test.ts tests/unit/hostile-archive.test.ts tests/unit/advisory-rehearsal.test.ts tests/unit/web-messages.test.ts packages/contracts/src/portability-records.test.ts packages/domain/src/portability.test.ts workers/workflow/src/restore-reconcile-command.test.ts tests/unit/sovereign-rules.test.ts`: **267 passed, 2 skipped, 11 files**. The existing platform-dependent tool skips are not passing filesystem qualification.
- Serial `typecheck` passed for domain, contracts, application, tests and worker.
- Web route generation, web `tsc --noEmit --incremental false` and browser-test types passed.

The cases cover explicit legacy/current inventories, future/mismatched/unknown refusal, private execution-record rejection, real metadata counts, legacy versus missing checkpoints, wrong/missing/under-covered generation proof, writer uncertainty, absence of any app private-payload query and consistent revocation wording. The standalone tool actually decrypted generated-key original bytes under both inventory profiles in its owned temporary folder; the existing resolved-path cleanup guard remained active.

**No database, SQL migration, Docker, install, build, browser journey, provider call, real credential or operator restore ran.** The metadata SQL additions are unrun against actual roles. The M4 adapter and SQL remain separate integration dependencies; root must bind actual agent recovery and qualify its coverage/generation result on the joined runtime. Existing source/record/derived-object erasure and export-epoch gates remain required. No migration, journal, dependency, license corpus, verifier, phone-home, navigation or cleanup script changed in this follow-up.
