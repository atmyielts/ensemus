# Platform completion progress

**Scope:** on 2026-11-06 the owner requested completion of the entire platform and explicitly included Claude's started but unfinished milestones. Work continues in dependency order on `codex/platform-completion`. Technical implementation and test results do not substitute for independent review, production acceptance or commercial sign-off.

## Preserved work

M2 continuation is committed as `feba9b8`. Before integrating later work, tracked binary patches, untracked files and source/HEAD/status metadata were copied from **36 dirty Claude worktrees** into the ignored local directory `.local/claude-wip-2026-11-06`. The source worktrees are intact. Snapshots include the unfinished code that is absent from branch HEADs; importing only committed branches would lose substantial work.

All later milestone foundations branch from `build-base` (`4e0535e`), which includes M3's foundation but not its completed implementation branch. Additive changes to schema exports, tenant contexts, OpenAPI, errors, package dependencies, worker registration and migration journals must be composed explicitly. Never replace those shared files with one sibling's full copy.

## Integration state

| Area | Existing source | Remaining implementation / verification |
|---|---|---|
| M2 | `feba9b8`; [evidence](evidence/M2-report.md) | Exact QA-007 email scenario must be verified with the M3 path; overall acceptance remains open |
| M3 | `m3-verified-actions` at `78b38e9`, merged with preserved newer M2 controls | Local integration, receipt/browser, connector fault and offline gates passed; outside acceptance remains open |
| M4 | `codex/platform-completion` at `aa1bbac`; composed M2/M3/M4 source | Runtime confidentiality, full replay/browser/offline gates and local signature rehearsal passed; upgrade, exact final release and outside acceptance remain open |
| M5, active composition | `codex/m5-integration` includes private clients, sources, structured/run input lineage, actual sharing readers and onboarding run/output binding | 33 migrations applied from fresh synthetic data; full units passed **3,084** and full real-role database regression passed **1,486**. Earlier failures are resolved; model transports and full journeys remain open. [M5 evidence](evidence/M5-report.md) records failures and reruns |
| M6 | Recovered slices plus v2 portability/restore/export-epoch and input-profile checkpoints `897da3c`, `335c7c1` | Latest source batch passed 267 focused units with two explicit skips and scoped types; 3 earlier guard checks passed separately. New SQL, recovery owners, joined runtime and offline acceptance still need composition |
| M7, active source composition | `codex/m7-platform-integration` joins native identity, actual Knowledge model runtime, Pulse/custom objects, checked portability, real M4/M5 adapters, parent Work authority, Studio HTTP and private outcome composer/setup through `148fd8a`; review/rehearsal screens recovered | Joined unit run: 4,981 passed, three failed, two explicit skips; the older worker-double fix passed five focused tests, with full rerun owed. All 53 registered migrations now apply from fresh PostgreSQL after inherited SQL repairs. The 145-table modeled-constraint audit is clean. Focused Studio/outcome/setup database run passed 32/failed one fixture assertion; its corrected rollback case passed separately. Full database/runtime/browser, graph UI and usability gates remain open. [Binding evidence](evidence/m7/runtime-bindings.md) |
| M8 | Source checkpoint `ca62c8e` preserved on `codex/m8-integration`: catalog, subscriptions, credits, invoices/payments, retention/offboarding and support | 270-unit checkpoint and scoped types passed, followed by 14 focused checks. Real bindings, database/journey/load/operations and commercial acceptance remain open |
| M9P | `m9p-foundation`; guides/help and dirty parity/inventory work in `wf_ed7cc9b4-b53-*` | Replace blocked parity wiring, complete license inventory and validate guides against integrated behavior |
| Hardening | Six committed slices and five preserved dirty slices composed in `codex/hardening-integration` at `f76893c` | Source checkpoint only, no hardening checks run for recovery. Preserve newer M4 safeguards at join, then verify tracing, release trust/reproducibility, scans and rebuilt images |
| M11A | `m11a-foundation` / `wf_3b625110-ef7-1`, including dirty contract/schema/rules | Department packs and business records/meetings/connectors require implementation |
| M11B | `m11b-foundation` / `wf_940a7a62-465-1` | Skills, marketplace and sandbox services/runner/bundle/signature implementations |
| M11C | `m11c-foundation` / `wf_84f90dac-4ce-1` | Federation/tenancy services, grants, bridge, isolation and residency flows |

Dirty scratch test configs and `zz-*` files are preserved in the snapshots and are not automatically imported as product code. Migration ranges are reserved per foundation; `0999_saas_eraser_reach.sql` must run after all contributing schemas.

## Current verified observations

- M3's branch forked before recent M2 integrity, proxy, ID, ledger and test-gate fixes. Integration preserves those fixes.
- The SMTP reader previously bounded only the partial-line string. Fragmented multiline and queued complete replies could grow without bound. Two regression tests failed before the fix; four parser tests and the existing connector tests now pass. The fix bounds aggregate unread bytes and releases budget on consumption; independent internal review found no further issue.
- The first merged unit run exposed skipped ID normalization in new forms/services. Existing regression tests caught it; the merged suite subsequently passed **826 unit tests**. Further gate-coverage and API regressions are being added, so this is a checkpoint count, not the final result.
- Replay of M2 and new connector/webhook/action histories passed **90 tests**, with 16 explicit history-capture cases skipped.
- Merged M3 integration passed 819 checks; receipt/draft browser confirmation passed 27 checks after correcting an accessible label and two test assumptions. Slice 2 exercised send, worker-loss uncertainty, revised recipients and replay. Detailed initial failures and focused reruns are in the M3 report. The air-gap control detected deliberate attempts; the connector isolation round passed 11 checks, five relay messages and zero outbound attempts.

## Owner and external decisions

The owner directed that entity/jurisdiction and residency choices not hold up implementation. Those values remain unset rather than invented. Outside security review, production signing custody, independent restore/accessibility testing, provider-backed commercial acceptance, legal review and final launch approvals remain external gates. Test configuration and generated values are used while code is built and verified.

## Active M4 and design continuation

All nine preserved dirty M4 slices were composed with the four committed slices in `codex/m4-integration`. The runtime binds real policy/router/usage/context/tool/approval ports, bounded object reads and the kill watcher. Agent role provisioning and the migration journal passed the isolated database gate. The combined checkpoint passed **2,883 unit tests** and **1,177 fresh real-role PostgreSQL checks**. The built-image API gate passed all four cases and covered all 18 activated operations. The four-case real agent confidentiality gate passed Cloud, BYOM, Sovereign and an unprotected positive control. The fresh full browser run passed **195 cases in 11.5 minutes**. The final full replay project passed **158 checks** and replayed 71 real histories, with 20 opt-in capture checks skipped. [M4 evidence](evidence/M4-report.md) distinguishes these results from the still-open offline, upgrade, release and outside acceptance checks.

The owner explicitly requires excellent, uniform design and intuitive navigation for non-developers while accommodating the platform's complexity. [The shared interface contract](../01-product/07-interface-system.md) applies to all milestones. Shared controls and workspace/Studio/administration navigation are implemented. The rendered gate covered 64 page/theme/width combinations with no axe findings or sideways overflow, plus native no-JavaScript navigation, denied member deep links and a long-name mobile header bound. These local checks do not substitute for independent usability/accessibility review or later milestone journeys.

Resource-heavy work now runs serially with a 16 GiB disk preflight. Cleanup is limited to positively identified task resources; original platform volumes, Claude recovery snapshots and unrelated PC/Docker data are preserved. The owner compacted Docker's trimmed virtual disk after Windows required administrator access. Source work continued while Docker recovered; the incident and exact cleanup scope are recorded in the M4 report.

The fresh M4 offline gate subsequently passed 326 checks with 18 explicit profile skips, six outage
rounds and zero outbound attempts. The local release rehearsal passed its recorded digest/SBOM and
tamper checks with a throwaway key. A later cached rebuild changed the OCI image-index digests; those
results are separate, and final release qualification must use a newly matching manifest. The
completed offline images and 469.3 MB of their exact cache entries were removed after build-provenance
and container-reference checks. The active preview and original volumes remain preserved.

M3 full offline stack gate subsequently passed318 checks (18 profile-specific skips); all six dependency outage rounds matched their expected responses and outbound attempts were zero. Its temporary Compose project removes its own resources on completion. The M4 upgrade rehearsal is being prepared with scoped temporary-directory cleanup.
