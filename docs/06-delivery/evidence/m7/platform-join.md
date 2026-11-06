# M7 platform source composition

2026-11-07. Source composition only; no joined acceptance or migration execution is claimed.

The isolated branch `codex/m7-platform-join` starts at root checkpoint `76de772` and merges the recovered M7 checkpoint `152c06edd339031cfcb57f6e6cf1c1b2c29ae3c9`. The original clean `codex/m7-integration` branch and its MFA/SSO evidence remain preserved. Root's newer uncommitted M5 tool-fence/read-port repairs were not copied or edited; those still need the parent's subsequent join.

## Conflict decisions

Twenty-six files conflicted. Exports, direct dependencies, frozen importer/snapshot records, application error/status/message maps, schema source declarations and workflow exports were composed as unions. Existing package versions and integrity values were retained. The current web API consent/receipt paths remain, with the real session ID added for M7 callers and tenant SSO enforced after the restore gate. The lazy runtime, separate lazy object store and restore gate remain; its narrow additions expose MFA/SSO and bind trusted application callbacks.

The dispatcher keeps the current dedicated `CONNECTION_REVOKED` workflow ID and branch. The recovered M7 branch's combined revoke/normal-sync branch was discarded, since an existing normal sync must never swallow a revoke. M7 simulation/process/object-migration cases are additive. No existing workflow execution order or replay patch changed. M8's Knowledge-model-job additions are owned separately and must join additively; no model-job symbols were invented here.

The shared grouped sidebar, mobile menu and workspace location remain. Assistants is an actual workspace destination; packs sits within Automation Studio and appears in its overview. Security joins Administration for permitted managers, and every signed-in person's existing account label links to their actual account-security page. The old flat M7 navigation is unused and its compatibility helper now derives only implemented destinations from the shared model. Pulse, composer, custom-record and setup placeholders are not advertised. Navigation unit source adds the real nested destinations; rendered/no-JavaScript/accessibility checks remain unrun for this join.

Current implemented M3/M4/M5 OpenAPI operations and existing schemas take precedence over old recovered planned copies. M7-only definitions are added, and actual recovered pack/security/SSO handler operations lose only their obsolete planned marker. The source API method is PATCH for security policy. SSO route directories/parameters are aligned to `ssoConnectionId` and `scimTokenId`; metadata replacement, single-connection read, token metadata read and token revocation are documented from the actual handlers. Source route existence is not runtime acceptance. The generated `openapi.d.ts` intentionally remains the current root artifact until the parent grants an explicit bounded generator slot; it is currently stale for the added M7 source definitions.

## Evidence identifiers

Repository source plus main/M5 documentation used threat IDs only through TR-028 before assigning this unused block. Existing M3 identifiers and their evidence are untouched. M7-only references were updated as follows:

| Recovered M7 ID | Joined M7 ID | Threat |
| --- | --- | --- |
| TR-023 | TR-029 | Unowned domain claims |
| TR-024 | TR-030 | Forged/replayed SAML |
| TR-025 | TR-031 | Forged or skipped recent MFA |
| TR-026 | TR-032 | Unreviewed pack/graph/draft authority |

The mapping applies only to the M7 threat rows, M7 traceability entries, slice plan/evidence and M7 test comments. NEXT-01 through NEXT-04 retain the current root's recorded `verified_ci` evidence state; the old recovery's `not_implemented` copies were not allowed to downgrade that record.

## Boundaries still open

- The generated contracts require regeneration and the joined source requires scoped static/unit checks, followed by real-role/native-provider/HTTP/browser/replay/security gates. The earlier 62-unit M7 result belongs to its pre-join checkpoint and is not a pass for this joined source.
- M7 migrations 0400–0403 are present but remain unjournaled/unapplied. The root journal currently ends at 0213, while contributing 0214 exists as source. M6 0300+ and other contributing migrations must be composed before root coordinates the journal/snapshots. This join changes neither journal nor snapshots.
- Recovered product web/worker ports still return explicit capability-unavailable results. Real M4/M5/M6 adapters, unfinished Pulse/composer/onboarding, Studio/application/custom-record portions and remaining recovered feature gaps are not presented as accepted functionality.
- Existing M4 publication/profile activation and M2 administration effects still need the parent-authorized transaction-time interactive-session/MFA authority seam. The M7-owned policy/UI checks alone do not enforce that policy across older services. Design and core edits follow this source checkpoint; durable authorized worker intents must retain their separate authority.
- The committed base does not include root's newer uncommitted M5 repairs or M8's newly authored model-job transport. Their owners retain those files.

No Docker, install, build, database, generator, typecheck, lint, formatter, unit or browser command ran for this source join. File/source reads, structured source composition and Git merge/index operations only. Outside identity/security review and hosted-provider acceptance remain open.
