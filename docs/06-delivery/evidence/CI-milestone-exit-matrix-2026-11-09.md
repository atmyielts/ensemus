# Milestone exit evidence: CI and local checks

2026-11-09, Asia/Tashkent. Feature development is paused while the integration's Linux CI failures
are repaired. A green local unit suite, a source recovery commit and an archived branch are not
milestone acceptance. This report separates those observations from actual GitHub Actions results.
Updated 2026-11-10 with the round 11 and round 12 CI runs; a green run is not milestone acceptance
either.

The required exits remain those in the [delivery plan](../06-end-to-end-delivery-plan.md) and
[acceptance criteria](../03-acceptance-and-dod.md). No exit requirement has been removed.

## One integration branch

The sole current `codex/*` integration branch is **`codex/m7-platform-integration`**, reviewed through
[draft PR #1](https://github.com/atmyielts/ensemus/pull/1). Its tip at consolidation was
`62879ef7330434616d683f071b52a3b3b09e42b0`.

The [branch consolidation ledger](branch-consolidation-2026-11-09.json) records all 57 closed local and
remote branch names and their exact preserved commit/tag pairs. All57 remote archive tags were
verified against those tips before this report:32 branches were already integrated by ancestry (9)
or patch equivalence (23); 25 contain unmatched source preserved for later review. Unmatched source
has not been declared merged, tested or accepted. Existing working directories were preserved.
Subsequent CI repairs belong on the one integration branch rather than new feature branches.

## First integration CI checkpoint, kept as history

This section was the current integration result on 2026-11-09. It is kept unchanged as history; the
later runs are recorded in the next section.

The first PR run, [42565538981](https://github.com/atmyielts/ensemus/actions/runs/42565538981), completed
with **six failed jobs and one passed job** at exact head
`62879ef7330434616d683f071b52a3b3b09e42b0`. No complete milestone exit passed on that head.

| Job | Actual result | Evidence and limit |
|---|---|---|
| quality | Failed | [Job 128991122955](https://github.com/atmyielts/ensemus/actions/runs/42565538981/job/128991122955). Prettier found six files; later lint, types, units, replay, backlog, contracts, licenses and audit steps did not acquire passing evidence. |
| integration | Failed | [Job 128991123141](https://github.com/atmyielts/ensemus/actions/runs/42565538981/job/128991123141). The current schema/runtime composition did not pass its real-role suite. |
| proxy | Passed | [Job 128991123136](https://github.com/atmyielts/ensemus/actions/runs/42565538981/job/128991123136). This proves the deployed proxy check's scope; it is not a complete milestone exit. |
| stack | Failed | [Job 128991123090](https://github.com/atmyielts/ensemus/actions/runs/42565538981/job/128991123090). Disk preflight refused 12.1 GiB free against the unchanged 16 GiB requirement, before the rehearsal. |
| connectors | Failed | [Job 128991123151](https://github.com/atmyielts/ensemus/actions/runs/42565538981/job/128991123151). No successful current Slice 2/connector acceptance result. |
| browser | Failed | [Job 128991123022](https://github.com/atmyielts/ensemus/actions/runs/42565538981/job/128991123022). No successful current complete browser gate. |
| upgrade | Failed | [Job 128991123139](https://github.com/atmyielts/ensemus/actions/runs/42565538981/job/128991123139). Disk preflight refused 13.1 GiB free against the unchanged 16 GiB requirement, before the rehearsal. |

This is the initial failing checkpoint. Later repair attempts must be recorded with their own run
URL, exact head and actual job results; a pending or partially green rerun does not supersede it.

## Later integration CI: repair rounds 11 to 13 (recorded 2026-11-10)

This section records GitHub Actions results only. It is separate from the local evidence further
down, and nothing in it was produced on a workstation. Run conclusions, heads and job conclusions
were read with `gh run view --json`; the job-log API was used for the counts quoted below.

### Round 11: run 42719085697 passed all 14 jobs

[Run 42719085697](https://github.com/atmyielts/ensemus/actions/runs/42719085697) (`pull_request`
event on [draft PR #1](https://github.com/atmyielts/ensemus/pull/1)) ran on exact head
`74e12a88500393f5ccc87957f0696d34e9a68314`, the round 11 head. Its conclusion is success, and every
one of its 14 jobs concluded success.

| Job | Result | Job link |
|---|---|---|
| quality | Passed | [129508126907](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508126907) |
| proxy | Passed | [129508126613](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508126613) |
| connectors | Passed | [129508126956](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508126956) |
| upgrade | Passed | [129508126899](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508126899) |
| stack | Passed | [129508126952](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508126952) |
| integration (1/6) | Passed | [129508127080](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508127080) |
| integration (2/6) | Passed | [129508126972](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508126972) |
| integration (3/6) | Passed | [129508126976](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508126976) |
| integration (4/6) | Passed | [129508127123](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508127123) |
| integration (5/6) | Passed | [129508126918](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508126918) |
| integration (6/6) | Passed | [129508127239](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508127239) |
| browser (1/3) | Passed | [129508127236](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508127236) |
| browser (2/3) | Passed | [129508127216](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508127216) |
| browser (3/3) | Passed | [129508127058](https://github.com/atmyielts/ensemus/actions/runs/42719085697/job/129508127058) |

Counts read from the job logs, as limits rather than extra claims: the quality job's unit step
passed 6,136 tests in 289 files with none skipped; its replay step passed 204 tests with 50 skipped
and 6 todo (21 of 32 replay files skipped, so the replay corpus is not fully exercised by that
pass). The connectors job's Slice 2 step passed 15 tests, its external-action browser spec passed
16, and its connectors-profile air-gap gate passed 15. Every job in the quality, integration, proxy, stack, connectors, browser and upgrade
definitions in `.github/workflows/ci.yml` at that head ran to success; no job was skipped.

### Round 12: run 42731641015 did not start any job

[Run 42731641015](https://github.com/atmyielts/ensemus/actions/runs/42731641015) on round 12 head
`49233a97f9fe78edb59f3755e5242742dd640d99` is reported as failed, but none of its 14 jobs started:
each has zero steps and no log, and each carries the same annotation, that the job was not started
because recent account payments failed or the spending limit needs to be increased.

That run is therefore **no evidence for or against** anything on that head, including migrations
0553 and 0554. It is not a code failure and it is not a pass, and it is listed as neither anywhere
in this report.

### Round 13: run 42736537246, attempt 4, passed all 14 jobs (recorded 2026-11-10)

[Run 42736537246](https://github.com/atmyielts/ensemus/actions/runs/42736537246) on round 13 head
`eb7627be49576945cb9e245d3939979515815f2c` passed all 14 jobs on attempt 4: quality, proxy,
upgrade, connectors, stack, integration 1/6 to 6/6 and browser 1/3 to 3/3. Attempts 1 to 3 started
no job, for the same billing reason as run 42731641015, and are evidence of nothing. Job ids for
attempt 4:

| Job | Result | Job id |
|---|---|---|
| quality | Passed | 129718737659 |
| proxy | Passed | 129718737977 |
| upgrade | Passed | 129718738042 |
| connectors | Passed | 129718738070 |
| stack | Passed | 129718738155 |
| integration (1/6) | Passed | 129718738026 |
| integration (2/6) | Passed | 129718738537 |
| integration (3/6) | Passed | 129718737917 |
| integration (4/6) | Passed | 129718738071 |
| integration (5/6) | Passed | 129718738126 |
| integration (6/6) | Passed | 129718737998 |
| browser (1/3) | Passed | 129718737978 |
| browser (2/3) | Passed | 129718738154 |
| browser (3/3) | Passed | 129718738145 |

This is the first run in which migrations 0553, 0554 and 0555 applied: every integration and
upgrade job migrated a real PostgreSQL database through them before running. It is CI evidence for
those jobs' automated checks at `eb7627b` only. It is not a security review of those migrations,
which remain **FLAGGED FOR HUMAN SECURITY REVIEW**, and it accepts no milestone exit.

### What the green runs do not cover

- Run 42719085697 predates migrations 0553, 0554 and 0555; run 42736537246 covers them at
  `eb7627b`. Neither run covers any later commit, which needs its own recorded run.
- A green CI run is not launch readiness and not milestone sign-off. It shows that the named jobs'
  automated checks passed at one commit. It does not accept any milestone exit, and none is marked
  accepted below.

### Still unreviewed or not done

- Human security review of migrations 0519 to 0555, including the 0548 delegation birth readiness
  migration. Migrations 0553, 0554 and 0555 are **FLAGGED FOR HUMAN SECURITY REVIEW**.
- ADR-032 D7 (offboarding and operator erasure) still needs the outside security review its status
  line requires, with D3, D4, D5 and D8.
- ADR-028: the security reviewer is not yet named (owner decision (c), 2026-11-09).
- Outside penetration test: not done.
- Legal review: not done.
- Accessibility audit by an independent party: not done. Automated axe checks in the browser jobs
  are not that audit.

## Historical Linux CI that actually passed

These results were inspected directly through GitHub Actions job metadata and logs. They belong
to the named historical commits, not automatically to the current integration.

| Checkpoint | Exact head and run | Verified result |
|---|---|---|
| M1 foundation | `2e78f21834b21c5244e107f59f1e59a579b34455`, [run 42057951400](https://github.com/atmyielts/ensemus/actions/runs/42057951400) | All three Ubuntu jobs passed: quality, integration and stack. Logs show 43 unit, 36 actual-role integration and 34 stack passes with one explicit skip; zero normal outbound attempts; valid signature and rejection of modified manifest/SBOM controls. |
| M2 committed baseline | `780d4fb8cfa292d40527d5452acfa83a3402d27b`, [run 42228039404](https://github.com/atmyielts/ensemus/actions/runs/42228039404) | All six Ubuntu jobs passed: quality, integration, proxy, stack, browser and upgrade. Logs show 325 units, 14 replay passes with one capture skip, 427 actual-role tests, 292 stack passes with one skip and 130 browser passes. The control detected 11 deliberate outbound packets; the normal offline run counted zero. Signature/tamper controls passed. The paused-approval upgrade job passed. |

Both quality jobs include the applicable backlog/traceability, generated-contract and documentation
manifest checks. The later M2 quality job also passed its configured license/dependency-audit steps.
No successful M3–M11 milestone exit evidence was found in the inspected repository Actions history.

## Required exits and their CI evidence

“Historical subset” below means the named technical checks passed at the historical SHA above.
It does not mean the complete milestone, the current integration or outside sign-off passed.
“Round 11 jobs” means the named jobs of run 42719085697 passed at `74e12a8`, as recorded above. It
is CI evidence for those jobs' checks at that commit only: it does not cover 0553, 0554 or 0555, and
it does not accept any exit. Every exit below remains unaccepted.

| Milestone | Required exit | What passed in CI | What still lacks CI or external acceptance |
|---|---|---|---|
| M0 | Every PRD requirement, QA scenario and threat maps to a ticket; regenerated manifest. | Historical mechanical backlog/traceability, contracts and manifest checks. Round 11 jobs: the quality job passed format, lint, types, units, replay, backlog/traceability, contracts, licenses, audit and docs manifest at `74e12a8`. | The quality checks have no passing run on the round 13 head yet (round 12's run never started). Checker success alone is not acceptance of every mapped requirement. |
| M1 | Phase 0 technical criteria and outside review of D4/D5 before any real credential. | Historical foundation technical subset: actual roles/RLS, auth/secrets tests, built offline stack, confidentiality/network controls and signed-manifest checks. Round 11 jobs: all six integration shards and the stack job (air-gap control, offline stack suites, SBOMs and signed manifest) passed at `74e12a8`. | No complete current milestone exit; no CI evidence yet for 0553–0555; outside security review, production signing custody and counsel/license decisions remain separate gates. |
| M2 | Slice 1, QA-001–007 and NEXT-01–04; measured tenant transaction overhead/dispatcher delay and forecast. | Historical committed core integration, built stack, browser, replay, proxy and upgrade checks. Round 11 jobs: integration, stack, all three browser shards, replay (with 50 skipped), proxy and upgrade passed at `74e12a8`. | Verification on the round 13 head, which carries 0553–0555; exact changed-email-recipient QA-007 was partial until M3. Historical aggregate success does not certify all later behavior or missing measurements. |
| M3 | Slice 2; QA-007/008/019 and AI-TS-01, including timeout-after-send faults. | No successful milestone exit in inspected CI. Round 11 jobs: the connectors job passed its Slice 2 / QA-007 / QA-008 / QA-019 / AI-TS-01 stack step, the external-action receipt browser spec and the connectors-profile air-gap gate at `74e12a8`. | Not yet reviewed against every M3 exit criterion (including timeout-after-send faults) and not accepted; replay was partly skipped; no CI evidence yet on the round 13 head. |
| M4 | Slice 3; QA-009/010/012–014/018, Gate C for an agent and use with actual approved keys. | No successful milestone exit in inspected CI. | Current composed runtime, API, confidentiality, replay, agent-control and provider acceptance; outside review remains separate. |
| M5 | Slice 4, Gate D, measured pgvector recall under ACLs and the BYOM pilot gate. | No successful milestone exit in inspected CI. | Full knowledge/provider journeys, actual egress, measured recall, hosted pilot and complete mode acceptance. |
| M6 | Sovereign offline acceptance on built binaries including packet capture; a restore run independently. | No M6 exit in inspected CI. Earlier foundation offline passes do not qualify the final Sovereign binaries. | Final signed install/local-inference/upgrade/restore acceptance and independently executed restore. Released-binary qualification is required before an air-gap sales claim. |
| M7 | Phase 4 exit; representative cross-department workflows finish with verified receipts and measured cost. | No successful milestone exit in inspected CI. | Complete current workflows, actual Temporal wake/replay/runtime transport and measured outcome cost/receipts. |
| M8 | Gate E for Cloud/BYOM, Gate F drills and measured cost feeding pricing. | No successful milestone exit in inspected CI. | Complete schema/role qualification, both prepaid inference paths, genuine payment/provider reconciliation, deletion/restore, operating drills and commercial acceptance. Cloud inference remains refused pending real prepaid authority. |
| M9 | No unresolved critical findings; Gates A–F signed with named evidence. | No independent milestone sign-off established by CI. | Pen test, independent accessibility/legal review, mode parity/retests and signed named evidence on a frozen release candidate. |
| M10 | Customers can buy Cloud, BYOM and Sovereign from a qualified signed release; released Sovereign acceptance and Cloud/BYOM canaries. | No production launch/released-binary acceptance evidence. | Production release qualification, canaries, executed agreements, customer documentation/release notes and launch decisions. |
| M11 | Ongoing expansion scope delivered and accepted per feature/mode. | No expansion milestone exit evidence in inspected CI. | Remaining packs/connectors, meetings, skills, marketplace/sandbox, federation and tenant/residency tiers are partial foundations, not accepted completed journeys. |

## Local evidence, kept separate

The latest full local source suite at the initial PR checkpoint passed **5,751 tests with two
skips across 261 files**. That is a shared suite, not 5,751 separate passes for each milestone. Earlier
milestone numbers below are distinct historical checkpoints and must not be added together or
treated as current-head revalidation.

| Milestone | Local unit/source checks | Other actual local evidence | Limits and source |
|---|---|---|---|
| M0 | Document/backlog reconciliation; unit count not applicable. | Reconciled requirements and documentation. | [Delivery plan](../06-end-to-end-delivery-plan.md); current CI quality still needs to rerun its mechanical checks. |
| M1 | Foundation unit/source checks, also covered by the historical CI checkpoint above. | Local foundation stack and role checks. | [M1 report](M1-report.md); outside review and custody are not unit tests. |
| M2 | Continuation 331 local unit passes. | Continuation 427 actual-role DB and 131 browser passes. | [M2 report](M2-report.md); newer continuation is distinct from historical 780d4fb CI. |
| M3 | 831 local units and90 replay passes, with explicit capture skips. | 819 actual-role DB cases; test-SMTP-relay fault exercises; 318 offline stack passes, 27 affected browser cases and 11 connector isolation cases. | [M3 report](M3-report.md). These are more than unit-only checks, but not current CI, hosted or real-provider acceptance. |
| M4 | 2,883 local units at its separate integration checkpoint. | 1,177 actual-role DB cases; four built API cases; four confidentiality controls;158 replay checks;195 browser cases; offline and throwaway-key release rehearsal. | [M4 report](M4-report.md). Fixture-backed local mode checks are not real-provider or independent acceptance. |
| M5 | 3,084 local units at its separate repaired checkpoint. | 1,486 actual-role DB cases. | [M5 report](M5-report.md). Complete built journeys, replay, measured recall, provider transport and pilot acceptance remained open. |
| M6 | Focused portability/input-protocol source suites and scoped types/lint. | Later selected archive/export checks participate in the joined platform's bounded database/browser checkpoints. | [M6 report](M6-report.md), [joined source follow-up](M6-M7-joined-authority-source.md). No complete final Sovereign install/restore/upgrade acceptance follows from those checks. |
| M7 | Shared 5,751-case source checkpoint; separate process/native-identity source checks. | Earlier registered composition: selected 84 actual-role DB cases and 57 production-browser cases, spanning M7/M8. | [M7 report](M7-report.md), [database checkpoint](m7/saml-self-link-database-checkpoint.md), [browser checkpoint](m7/product-browser-checkpoint.md). They do not rerun every platform journey or newer unregistered source. |
| M8 | Shared source suite plus focused payment/restore/operator-erasure source checks. Eight new SQL files compiled in a rollback-only transaction. | Selected standing/catalog/entitlement/lifecycle checks passed locally within the earlier registered database scope. The rollback-only candidate had 214 tables and returned to 198 installed tables. | [Combined checkpoint](M8-combined-source-checkpoint.md), [standing checkpoint](M8-standing-database-checkpoint.md). No new migration registration, actual restore/erasure completion or real-provider acceptance is implied. |
| M9 | Partial assurance, guide, parity and hardening foundations. | No completed independent assurance established by this audit. | [Platform progress](../platform-completion-progress.md); recovered source is not signed Gates A–F evidence. |
| M10 | Partial release foundations and prior local throwaway-key rehearsals. | No production release/canary launch established by this audit. | [Delivery plan](../06-end-to-end-delivery-plan.md); local packaging is not customer launch. |
| M11 | Preserved partial source foundations. | No completed expansion journey acceptance established by this audit. | [Platform progress](../platform-completion-progress.md); archived unmatched source stays reviewable and unaccepted. |

## How this report was checked

Read-only commands inspected repository Actions history, exact run heads, final job conclusions and
job logs: `gh run list`, `gh run view --json`, `gh run view --log` and the Actions job-log API. The
57 archive tag tips were compared with the ledger using `git ls-remote --tags`; the remote
`codex/*` head list contained only the integration branch when checked. Local results above were
read from their linked checkpoint reports; those tests were not rerun for this documentation audit.

No provider message, real credential, signing key, customer data, deployment or acceptance approval
was created by this audit. Later CI repairs and their results require separate evidence updates.

The 2026-11-10 update added only the CI section for rounds 11 and 12 and the round 11 entries in the
exit table. Its run and job conclusions, heads, annotations and quoted counts were read with
`gh run view --json`, the check-run annotations API and the Actions job-log API; the presence of
0553 and 0554 on `49233a9` and their absence at `74e12a8` were checked with `git ls-tree`. No test
was run for that update and no exit was accepted by it.
