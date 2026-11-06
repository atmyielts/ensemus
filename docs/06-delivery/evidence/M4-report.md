# M4 continuation: governed AI and shared interface

**2026-11-07. Core implementation is integrated in `codex/m4-integration`; verification and formal closure remain open.** This report records local evidence. No CI, live-provider qualification, outside security approval or production acceptance is claimed.

## Implemented

The four committed M4 slices and nine preserved dirty slices are composed with newer M2/M3 safeguards. The agent worker now binds real context, router, policy, credentials, usage, approvals, tools, cancellation and kill-switch services. It runs separately on an internal network. Generated private test models are confined to the test overlay; hosted credentials remain behind the review interlock.

Agent role creation/upgrade runs before migrations. The AI schema and security migrations are journaled with snapshots. Object reads are bounded while streaming; SMTP replies retain the integrated M3 aggregate bound. The model guard resolves once, connects to the judged literal, retains the hostname for TLS/Host and verifies the connected address. This fixes a reproduced Windows peer-address cache issue without relaxing destination checks.

Joined lifecycle fixes include releasing halt subscriptions on every activity exit, applying provider stops before a profile is bound, atomically closing only the stranded AI run matching its Temporal run ID, refusing agent approvals on failed work, and closing approvals when approver access is removed. A queued run request preserves the work's version; the worker moves queued work through ready to running with normal dependency checks. Known incomplete prerequisites are refused before a request commits and checked again at claim.

The owner requires a uniform, polished interface for non-developers. The [interface system](../../01-product/07-interface-system.md) governs every milestone. Shared controls and grouped workspace/Studio/administration navigation are implemented; rendered multi-page accessibility and responsive checks are underway. A guideline or source-level test alone is not visual acceptance.

## Actual local results

| Check | Result |
|---|---|
| Combined unit suite | **2,883 passed**, 89 files in the final serialized run |
| Fresh real PostgreSQL suite | **1,177 passed**, 32 files |
| Whole-workspace typecheck and `tests/tsconfig.json` | Passed in the final serialized repeat, including fresh Next route generation |
| Built-image M4 API test | **4 passed**; successful OpenAPI validation of all **18** activated operations, including real private-profile activation, generated-key sealing, exact idempotent run request, control and cross-tenant refusals |
| Real agent confidentiality gate | **4 passed**: Cloud, BYOM, Sovereign and an unprotected Temporal positive control |
| Scripted assurance | Passing baseline plus deliberately wrong fixture, baseline regression and fabricated-citation controls; [details](m4/assurance.md) |
| Actual Temporal capture/replay | **33 new histories**, **71 histories replayed**; the final full replay project passed **158 checks** with 20 opt-in capture checks skipped, including the new continuation-link assertions; [details](m4/workflow-replay.md) |
| Fresh connector consent | **60 real-role connector sync checks passed**, including recorded scopes independent of forged configuration and a subsequent changed-consent pass |
| Focused interface browser check | **11 passed**, including 64 page/theme/width accessibility and overflow combinations; [details](m4/interface-system.md) |
| Full browser suite | **195 passed in 11.5 minutes** on the freshly rebuilt web image; local log `.local-m4-browser-full-final.log` |
| Upgrade rehearsal | Earlier run interrupted by full disk. The fresh attempt refused at the 16 GiB preflight before touching Docker; a complete rehearsal remains owed |
| M4 air-gap control | **Passed** after Docker recovery: seven deliberate outbound packets detected on the watched subnet |
| Fresh full M4 offline gate | **326 passed, 18 profile-specific checks skipped**, followed by all **six** service-outage rounds and **zero outbound attempts**; complete gate passed |
| Local release rehearsal | Web/worker SBOMs have **337 / 394 packages**; offline signature/digest checks passed and both manifest/SBOM tamper controls were rejected. Explicit throwaway test key, not production release signing |

Backlog/traceability, generated-contract consistency and the production-license inventory passed on this composition. The production dependency audit passed the configured high-severity gate; it still reports one moderate esbuild development-server advisory. This is not a claim of a vulnerability-free dependency tree.

The real confidentiality journey starts through HTTP, outbox and Temporal, reads a stored artifact, calls the private wire-format fake, creates a draft and evidence through a tool, calls the model again and receives a raw provider error. Each mode completes with two model turns and one tool call. Raw and encoded test markers are absent from Temporal persistence, service logs, audit, public run/steps APIs and HTML/RSC views on both replicas. Positive controls prove the artifact/prompt/tool path ran, the draft exists and the same persistence scan detects an unprotected payload. Cloud uses an explicit current-period entitlement, Ensemus-owned private profile and synthetic versioned test rate card; the test checks actual mode and billing ledger facts. This is a synthetic private-provider check, not a live hosted-provider or model-quality result.

## Failures found and corrected

Initial unit composition found policy/status gaps, a guard portability defect and stale isolated-slice assumptions. The initial PostgreSQL run passed 1,170 checks and failed five test setup assertions: incorrect assignment field names, a wrong audit schema name and unpriced final ledger entries. All affected cases passed after correction, followed by the fresh full run above.

The first actual worker journey then found the queued-work request/claim mismatch. Two new real-role regressions failed before the fix; all 42 timeline cases passed afterward. The multi-network object store also bound S3 only to its original interface. S3 now explicitly serves the data and agent networks, while its administrative listeners retain their original binding. A test-only relay exposes fake-model controls from the internal network, following the Temporal test-port pattern.

## Outstanding acceptance

Complete the upgrade rehearsal when disk headroom permits. Replay, the full browser suite, offline stack/outages and the local release rehearsal now have the evidence above; killed-agent-worker, rolling-agent-deployment and real-provider recovery remain distinct acceptance work. Bind later knowledge/commercial integrations without replacing governed ports with test doubles. Independent security/accessibility review, reviewed hosted credentials and real-provider/commercial acceptance remain external gates. No real credential or customer document was used here.

## Temporary resources

The owner explicitly requires careful cleanup. Only test projects created for this work are disposable. The original `ensemus` project, source worktrees, preserved Claude recovery snapshots and unrelated Docker/PC data are retained. Completed `ensemus-platform-test` resources were removed after checking project ownership: 16 containers, three volumes and six networks. The completed M4 integration project was later removed: one container, one volume and four networks. The live M4 preview remains in use. No broad Docker prune or disk sweep is authorized.

The host C: drive subsequently reached zero free space during parallel rehearsals. Resource-heavy checks were stopped. Two scoped generated-file deletion attempts were blocked by automatic approval review and did not run. The owner restarted Docker after its engine became unresponsive. Ownership of 49 recent build records was checked against the Ensemus repository before exact cache-ID cleanup; about 22 GB of selected Ensemus cache was reclaimed. The interrupted upgrade's three volumes, four networks, four image tags and clean temporary worktree were removed. The temporary path and base commit were verified before Git removed the worktree; only its two generated YAML files and empty parent directory were then removed. Original platform volumes were inspected and remain present.

Docker trimmed 24,059,297,792 already-free bytes. Windows refused compaction from this non-administrator session, so the owner ran the reviewed `Optimize-VHD -Mode Quick` command with Docker fully stopped. The virtual disk length fell from approximately 160.0 GB to 138.2 GB and C: reported 27.0 GB free afterward. The shared virtual disk was neither deleted nor reset. Subsequent checks run serially with free-space monitoring; rebuilding the corrected web image consumes part of that recovered headroom.

The local all-gates runner now chooses a disposable Compose project for each invocation, rather than deleting volumes from the existing `ensemus` project. Heavy offline/upgrade rehearsals refuse to start below 16 GiB host disk headroom. **42 focused safeguards/runner checks passed**; workflow package typecheck passed. Executing the new preflight on this low-space host refused as expected, before touching Docker. The standalone air-gap runner refuses ordinary project names before cleanup and uses a unique capture container. Release scanning honors the selected isolated image tags. These are preventive checks, not evidence that the interrupted product gates passed.

The upgrade cleanup no longer falls back to recursive deletion after Git refuses its temporary worktree. It verifies the exact resolved parent/tree, refuses junctions and unexpected scratch files, uses normal Git worktree removal and removes only its two generated YAML files plus an empty parent. Four real-filesystem tests passed, covering successful cleanup, preservation of an unexpected file, a refused dirty tree and a substituted Windows junction whose destination remains untouched.

The browser rerun corrected two real interface faults: the run page streamed before authorization and therefore returned HTTP 200 for an inaccessible run, and model controls had accessible names that omitted their visible action text. Authorization now precedes streaming; accessible names include the visible labels. Fixture repairs use the real profile state transition, the fake model's actual port and explicit alert text. Agent execution is paused only during browser tests whose fixtures manually advance run states; runtime checks use the real worker.

The first offline round then found two test assumptions left over from the earlier shell: a current navigation link was expected to start with bare text, and any environment variable containing `PRIVATE` was treated as key material. The tests now check the exact selected Work link and its visible label through nested decorative markup, forbidden secret-bearing environment names and actual private-key material. Environment values are no longer printed by a failed key assertion. The public private-model endpoint allowlist remains permitted configuration. Both repaired checks passed on the isolated preview, and test TypeScript passed. The original failed offline log is retained; these focused results are not a substitute for a fresh complete offline pass.

The fresh complete rerun then passed **326 cases** in 785.72 seconds with **18** explicit profile skips, and all six outage rounds returned expected responses with zero outbound attempts. The completed script exited successfully and removed only its `ensemus-m4-airgap` resources. Logs are `.local-m4-airgap-control-final.log`, `.local-m4-airgap-full-final.log` (the initial two-failure round), `.local-m4-airgap-full-repaired.log` (the passing gate), and `.local-m4-release-final.log`. The signed local manifest records source checkpoint `2f1b122`; runtime files are unchanged from the preceding clean image build, with the intervening repair confined to excluded tests/docs. No CI or production artifact publication occurred.

An additional attempt to remove the unused dependency cache in completed M3 worktree `wf_4b614715-08e-10` was rejected by automatic approval review as “blocked by policy.” It did not run, and that cache remains intact. No alternative deletion method was used.

After the completed rehearsals, free host space fell just below the 16 GiB guard. The fresh upgrade command refused before any Docker operation or temporary checkout. Fifteen new build records were independently checked against the Ensemus repository, and only their 15 recent regular-cache entries were selected by exact ID; the bounded prune reclaimed **zero bytes**. Older or unrelated cache and the original deployment volumes remain untouched. Source integration continues while resource-heavy builds are held; this is a resource block, not a passed upgrade test.
