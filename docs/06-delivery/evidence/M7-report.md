# M7 implementation and integration status

## Current local evidence, 2026-11-08

Active composition is on `codex/m7-platform-integration`; M7 is not complete. The earlier joined
55-migration source checkpoint passed 5,051 unit cases with two explicit skips, sequential package
and application type checks, and an actual PostgreSQL constraint-name audit over 149 modeled tables.
Those results precede the newer process-authority and dispatcher-wake changes below.

A fresh restricted-role PostgreSQL regression after `d93422d` and `5770d8c` passed 90 of 109 cases.
All 13 custom-record cases passed, including the fixed native deletion effect, post-deletion body/index
closure, forged selector refusal, native-session requirement, tenant isolation and agent login refusal
even after `SET ROLE ensemus_app`. Interactive privileges, parent Work authority, manifest read scope
and the runtime-adapter group passed. Five Pulse failures exposed an invalid audit target reference;
the repaired Pulse group subsequently passed all 12 cases. Fourteen model-call cases failed because
the worker could select an approval but its `FOR SHARE` locking read was hidden by the UPDATE policy.
`8180aed` repairs that lock visibility while retaining actual app-login-only mutation authority.
The later 25-case model group passed after the separate SQL alias and exact refusal-fixture repairs.

Studio now links the actual assistant draft, workflow draft and publication review pages. Published
versions are labeled "Published", without implying current model/budget readiness. The guided paths,
HTTP adapters, outcome composer and setup flows have source and focused local evidence; the complete
rendered journeys remain open.

`b6b3f23` joins immutable native process-start intent and real child Work birth records, complete step
inventory, kind-specific completion receipts, and actual owner confirmation. Migration 0418 refuses
active legacy runs whose real birth intent is absent; no history is guessed or promoted. Migration
0420 adds a dispatcher-only metadata mapper for persisted outcome events, without dispatcher body or
event-payload grants. A Temporal patch preserves old replay decisions while retaining new wake signals
received during an Activity. The focused source batch passed 193 cases across six files, including
both signal-race branches. Database, application, workflows, actual worker and tests type checks passed
sequentially. All 57 migrations applied to the fresh restricted-role database, and the actual constraint
audit over 151 modeled tables found zero missing or differently named keys/checks. The joined product
regression then passed **170 cases across 14 files**, covering actual native identity, custom records,
parent/manifest authority, runtime adapters, Pulse, archive custody, model-input receipts, Studio,
outcomes/setup and process execution. The separate model group passed **25 cases**: these are 195
distinct actual-role cases, not an additional repeat of the 15 process cases. The process group now
also exercises a genuinely published assistant delayed at its real M4 admission port: after a native
stop commits, both admission and the independent SQL binding guard refuse, with zero new runs/bindings.
New test fixture corrections pass actual native MFA session proof and use genuinely restricted Work
for assignment revocation; no runtime authority was relaxed to make them pass.

Five actual process HTTP adapters and four native execution pages are joined in `f925807`. The pinned
contracts generator matches the committed generated artifacts. A joined focused batch passed 98
cases across seven files; contracts, application, browser-test, Next route generation/web and tests
type checks passed sequentially. HTTP/browser execution and real Temporal signal delivery/replay
remain open. The previous full unit checkpoint has not yet been rerun over all these changes.

Navigation now discovers Pulse under Home, private outcome drafts under Work, custom records in the
workspace, role-authorized company setup under Administration, and workflow execution under Work
separately from draft creation in Studio. The initial discovery group passed 23 cases; its newer
run-section assertions and rendered navigation/layout review remain open.

SaaS lifecycle and billing composition, inherited agent-input authority, actual provider journeys,
Cloud/BYOM/Sovereign acceptance, performance, independent reviews and release/production checks remain
open. None of the local results above establishes launch readiness.

## Preserved recovery history

2026-11-07. The owner asked to continue all unfinished milestones. Seven preserved Claude slices are now composed in `codex/m7-integration`, reusing the clean existing `wf_2e9ac267-bb6-1` checkout at foundation `8a5d8a9`. Original slice worktrees and recovery snapshots remain intact.

Recovered source includes assistants service/pages, custom-object domain validation, agent draft/simulation rules, process specifications/compiler, durable process-run source, bundled workflows, packs and sales-operations content. Thirty untracked source/test files were copied only after checking target containment and absence, then checking copy hashes. Tracked patches were checked against the common foundation before application. `git diff --check` passed.

This is a source checkpoint, not an implemented or verified milestone. No M7 dependency install, typecheck, unit/integration/browser/replay run, build or Docker command was performed for this recovery. Existing tests are retained as unverified. MFA, SSO, Pulse, composer/onboarding, custom-object application paths, Studio and remaining feature portions still require implementation or composition; source presence does not establish usable behavior.

The final join must retain the M4 shared interface and security/runtime changes, bind M4/M5/M6 ports, stitch migrations and contracts, replace unavailable feature ports with real authority, and test successful and denied journeys on real roles and images. Real identity providers and real second factors remain behind ADR-031's outside review requirement. Independent usability/accessibility studies, cross-department verified outcomes and measured cost remain open. No milestone completion or production acceptance is claimed.
