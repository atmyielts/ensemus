# M6 continuation: Sovereign integration

Source integration started on 2026-11-07 in `codex/m6-integration`. This is a local implementation checkpoint, not milestone acceptance, released-binary qualification or a sales claim of air-gap readiness.

## Recovered implementation

The six preserved slice commits were applied to the clean M6 foundation: licensing and its frozen corpus, issuing/customer tools and diagnostics, offline bundle verification, organization export, organization import, and backup/restore reconciliation. Their original branches remain intact. The preserved console snapshot was then applied without overwriting an existing untracked target: five tracked changes and 30 new files covering license/advisory and portability pages, APIs and their tests.

These changes were authored before this integration. Recovering and composing them does not establish that they work together. No frozen license corpus file was regenerated. No real signing key, provider credential or customer archive was used.

## Verification still required

No command that builds, installs dependencies, runs tests, starts Docker or executes a backup/restore has run for this M6 composition. Typechecks, license/hostile-archive tests, real-role migrations, API/browser checks and replay capture remain owed. The M4 browser gate is currently using the serialized verification slot.

M3, M4 and the current M5 implementation must be joined before testing the complete product. Migration journals/snapshots, production ports, all-section export/import inventory, source/derived-artifact revocation, actual restore contributors, cancellation and operator commands require review at that join. Missing inventory or contributor implementations must not be treated as empty successful work. The console must use the shared interface system from the current platform integration.

Outside security review of signing, sealing, hostile import and restore remains open. Signing-key custody, rights/support policy, real redistributable model weights and an independently executed restore are separate acceptance inputs. Defaults in a foundation document are not evidence that the owner approved production commercial terms.

## Resource scope

This work reused the existing clean M6 checkout. It created no Docker resource or new dependency tree. Original worktrees and the Claude recovery snapshot were retained. Heavy verification must use the platform's disk-headroom guard and run one environment at a time; cleanup is limited to identified disposable task resources.
