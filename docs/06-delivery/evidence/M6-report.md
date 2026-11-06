# M6 continuation: Sovereign integration

Source integration started on 2026-11-07 in `codex/m6-integration`. This is a local implementation checkpoint, not milestone acceptance, released-binary qualification or a sales claim of air-gap readiness.

## Recovered implementation

The six preserved slice commits were applied to the clean M6 foundation: licensing and its frozen corpus, issuing/customer tools and diagnostics, offline bundle verification, organization export, organization import, and backup/restore reconciliation. Their original branches remain intact. The preserved console snapshot was then applied without overwriting an existing untracked target: five tracked changes and 30 new files covering license/advisory and portability pages, APIs and their tests.

These changes were authored before this integration. Recovering and composing them does not establish that they work together. No frozen license corpus file was regenerated. No real signing key, provider credential or customer archive was used.

## Verification still required

The initial recovery checkpoint ran no validation. The later [portability and restore source follow-up](M6-portability-source-followup.md) records 248 passing focused unit tests, two skipped cases and scoped passing format/lint/types, with a separately recorded final contributor hardening check. It does not establish database, browser, provider, bundle or restore acceptance. No build, install, Docker, database migration, backup/restore or offline acceptance ran in that follow-up.

M3, M4 and the current M5 implementation must be joined before testing the complete product. Migration journals/snapshots, production ports, all-section export/import inventory, source/derived-artifact revocation, actual restore contributors, cancellation and operator commands require review at that join. Missing inventory or contributor implementations must not be treated as empty successful work. The console must use the shared interface system from the current platform integration.

Outside security review of signing, sealing, hostile import and restore remains open. Signing-key custody, rights/support policy, real redistributable model weights and an independently executed restore are separate acceptance inputs. Defaults in a foundation document are not evidence that the owner approved production commercial terms.

## Resource scope

This work reused the existing clean M6 checkout. It created no Docker resource or new dependency tree. Original worktrees and the Claude recovery snapshot were retained. Heavy verification must use the platform's disk-headroom guard and run one environment at a time; cleanup is limited to identified disposable task resources.
