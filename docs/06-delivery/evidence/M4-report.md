# M4 continuation: governed AI and shared interface

**2026-11-06. Core implementation is integrated in `codex/m4-integration`; verification and formal closure remain open.** This report records local evidence. No CI, live-provider qualification, outside security approval or production acceptance is claimed.

## Implemented

The four committed M4 slices and nine preserved dirty slices are composed with newer M2/M3 safeguards. The agent worker now binds real context, router, policy, credentials, usage, approvals, tools, cancellation and kill-switch services. It runs separately on an internal network. Generated private test models are confined to the test overlay; hosted credentials remain behind the review interlock.

Agent role creation/upgrade runs before migrations. The AI schema and security migrations are journaled with snapshots. Object reads are bounded while streaming; SMTP replies retain the integrated M3 aggregate bound. The model guard resolves once, connects to the judged literal, retains the hostname for TLS/Host and verifies the connected address. This fixes a reproduced Windows peer-address cache issue without relaxing destination checks.

Joined lifecycle fixes include releasing halt subscriptions on every activity exit, applying provider stops before a profile is bound, atomically closing only the stranded AI run matching its Temporal run ID, refusing agent approvals on failed work, and closing approvals when approver access is removed. A queued run request preserves the work's version; the worker moves queued work through ready to running with normal dependency checks. Known incomplete prerequisites are refused before a request commits and checked again at claim.

The owner requires a uniform, polished interface for non-developers. The [interface system](../../01-product/07-interface-system.md) governs every milestone. Shared controls and grouped workspace/Studio/administration navigation are implemented; rendered multi-page accessibility and responsive checks are underway. A guideline or source-level test alone is not visual acceptance.

## Actual local results

| Check | Result |
|---|---|
| Combined unit suite | **2,873 passed**, 87 files |
| Fresh real PostgreSQL suite | **1,177 passed**, 32 files |
| Whole-workspace typecheck and `tests/tsconfig.json` | Passed at the recorded checkpoint; repeat after remaining changes |
| Built-image M4 API test | **4 passed**; successful OpenAPI validation of all **18** activated operations, including real private-profile activation, generated-key sealing, exact idempotent run request, control and cross-tenant refusals |
| Real agent confidentiality gate | **3 passed**: BYOM, Sovereign and an unprotected Temporal positive control |
| Scripted assurance | Passing baseline plus deliberately wrong fixture, baseline regression and fabricated-citation controls; [details](m4/assurance.md) |
| Full replay, browser, M4 air-gap, upgrade and release checks | Remaining; do not treat focused results as these gates |

The real confidentiality journey starts through HTTP, outbox and Temporal, reads a stored artifact, calls the private wire-format fake, creates a draft and evidence through a tool, calls the model again and receives a raw provider error. Each mode completes with two model turns and one tool call. Raw and encoded test markers are absent from Temporal persistence, service logs, audit, public run/steps APIs and HTML/RSC views on both replicas. Positive controls prove the artifact/prompt/tool path ran, the draft exists and the same persistence scan detects an unprotected payload. This is a synthetic private-provider check, not a live hosted-provider or model-quality result. Cloud stack coverage is still owed.

## Failures found and corrected

Initial unit composition found policy/status gaps, a guard portability defect and stale isolated-slice assumptions. The initial PostgreSQL run passed 1,170 checks and failed five test setup assertions: incorrect assignment field names, a wrong audit schema name and unpriced final ledger entries. All affected cases passed after correction, followed by the fresh full run above.

The first actual worker journey then found the queued-work request/claim mismatch. Two new real-role regressions failed before the fix; all 42 timeline cases passed afterward. The multi-network object store also bound S3 only to its original interface. S3 now explicitly serves the data and agent networks, while its administrative listeners retain their original binding. A test-only relay exposes fake-model controls from the internal network, following the Temporal test-port pattern.

## Outstanding acceptance

Capture and replay agent-loop histories, complete recovery/delegation/budget fault journeys, verify the shared interface in the full browser suite, and repeat isolation/upgrade/release gates for this exact composition. Bind later knowledge/commercial integrations without replacing governed ports with test doubles. Independent security/accessibility review, reviewed hosted credentials and real-provider/commercial acceptance remain external gates. No real credential or customer document was used here.

## Temporary resources

The owner explicitly requires careful cleanup. Only test projects created for this work are disposable. The original `ensemus` project, source worktrees, preserved Claude recovery snapshots and unrelated Docker/PC data are retained. Completed `ensemus-platform-test` resources were removed after checking project ownership: 16 containers, three volumes and six networks. The fresh integration and live M4 preview projects remain temporarily in use and must be removed when their checks finish. No broad Docker prune or disk sweep is authorized.
