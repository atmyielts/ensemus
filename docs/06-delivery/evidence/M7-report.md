# M7 source recovery checkpoint

2026-11-07. The owner asked to continue all unfinished milestones. Seven preserved Claude slices are now composed in `codex/m7-integration`, reusing the clean existing `wf_2e9ac267-bb6-1` checkout at foundation `8a5d8a9`. Original slice worktrees and recovery snapshots remain intact.

Recovered source includes assistants service/pages, custom-object domain validation, agent draft/simulation rules, process specifications/compiler, durable process-run source, bundled workflows, packs and sales-operations content. Thirty untracked source/test files were copied only after checking target containment and absence, then checking copy hashes. Tracked patches were checked against the common foundation before application. `git diff --check` passed.

This is a source checkpoint, not an implemented or verified milestone. No M7 dependency install, typecheck, unit/integration/browser/replay run, build or Docker command was performed for this recovery. Existing tests are retained as unverified. MFA, SSO, Pulse, composer/onboarding, custom-object application paths, Studio and remaining feature portions still require implementation or composition; source presence does not establish usable behavior.

The final join must retain the M4 shared interface and security/runtime changes, bind M4/M5/M6 ports, stitch migrations and contracts, replace unavailable feature ports with real authority, and test successful and denied journeys on real roles and images. Real identity providers and real second factors remain behind ADR-031's outside review requirement. Independent usability/accessibility studies, cross-department verified outcomes and measured cost remain open. No milestone completion or production acceptance is claimed.
