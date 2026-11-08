# Native authentication and authorization after trusted full restore

Source inventory from root checkpoint `1239488`, 2026-11-08. This is a design input, **not an
implemented restore gate, executed restore, provider revalidation or new permission grant**. The
checked SAML/self-link work is preserved in separate commits. Shared SQL/ports await root review.

## What exists

`infrastructure/scripts/sovereign-restore.mjs` verifies the encrypted backup, stops a named set of
services, restores the three full PostgreSQL dumps, writes object bytes, and prints a reconciliation
reminder. The list predates the actual `knowledge-worker` and `agent-worker` services. No auth-state
invalidation occurs. `createRestoreGate` in `packages/application/src/tombstone-ledger.ts` checks
whether the current database is behind the deletion ledger; it does not validate restored roles,
memberships, SCIM revocations, provider review or native authentication state. The M6 reconciliation
command reports material/execution gaps and does not certify those identity facts either.

Current auth is stateful: an actual database adapter is configured, no secondary/session cache is
enabled, and pinned Better Auth defaults OAuth state to database storage for a stateful adapter
(`context/create-context.mjs`). `readInteractiveSession` explicitly disables cookie cache and native
effect checks recheck the actual session. This makes clearing database-backed authentication state
meaningful. It does not make restored business authorization current.

## Invalidation inventory

| Stored surface | Consequence of restoring an old copy | Required treatment |
| --- | --- | --- |
| `identity.sessions` | Revoked/logged-out native sessions can return | Revoke restored sessions before native admission |
| `identity.session_assurances` | Old MFA and SSO approvals can return | Revoke with sessions; no replacement proof |
| `identity.verifications`: `auth-state:*` | OAuth/SAML relay/code-verifier state can return | Invalidate |
| Native SAML request/replay values | Old request/assertion acceptance can return | Invalidate, while treating clock/expiry as an additional bound |
| `ensemus-saml-browser:v1:*`, `ensemus-saml-self-link:v1:*` | An old prepared browser selection can return | Invalidate; a purpose cookie alone must never admit |
| `ensemus-primary:v1:*`, enrollment and IdP-factor bridge values | Old primary/setup authority can return | Invalidate; require actual new native proof |
| `2fa-*`, attempts and trusted-device values | Old pre-auth or remembered-device authority can return | Invalidate |
| Password-reset/other native verification values | A consumed link can return | Invalidate |
| `ensemus-mfa-admit:v1:*` | A consumed TOTP/code admission can return, or a post-backup one can be missing | Invalidate transient proof only with a conservative replay/lockout drain |
| `identity.setup_tokens` | A used operator setup code can return unused | Mark restored outstanding codes unusable; operator can issue new ones |
| Native email-verification JWT | It is signed/stateless, not a verification-table row | Retain an issued-at cutoff; verify the real signature and refuse missing/pre-restore issuance |
| `identity.two_factors.backup_codes` | A consumed recovery code can return in its old encrypted list | Revoke restored lists using a valid native encoding; ordinary verification-row deletion is insufficient |
| `identity.two_factors.secret`, `verified`, `users.two_factor_enabled` | Resetting these would disable or replace a person's authenticator | Preserve; do not generate a new factor or an assurance |
| Password/account identity and provider config | These are durable identity/configuration, not a new native session | Preserve; operator must separately review current authority |
| Failure/rate-limit counters and `locked_until` | Post-backup failures/lockouts may be missing | Preserve restored counters and require a conservative restore-only hold; never claim exact latest failure history |

The pinned TOTP verifier accepts adjacent 30-second windows. The platform's native factor lockout
maximum is 900 seconds. No retained database snapshot can prove the latest pre-restore recovery-code
consumption or account failure budget. A proposed restore-only cooldown/revocation must be explicit;
it must not silently change everyday MFA policy or claim elapsed time validates tenant authority.

Native backup codes use `better-auth/crypto.symmetricEncrypt` for a JSON list. A valid encrypted empty
list can revoke a restored set while preserving the TOTP secret and enabled/verified flags. This is a
proposal requiring root approval, not permission to write malformed ciphertext or reset factors.
People would regenerate codes through the existing actual TOTP + primary-proof path. Lost-app
recovery still requires the existing independently reviewed operator procedure; no bypass is added.

## Restored tenant authority remains unknown

Active memberships/roles, `org.sso_member_links` deprovisioning, `org.sso_connections` state and
`identity.sso_providers` review flags can all be older than the last real revocation. Neither a fresh
password/MFA check nor an empty deletion-ledger report makes them current. An explicit pending
identity-reconciliation barrier is needed. Its release must come from actual operator authority and
review against independent current identity records, bound to the exact restore generation and
reviewed snapshot. It must not come from a restored owner's browser, an empty list, a count, time,
or an invented current role. Any mutation seam must preserve native policy and allow no implicit
role elevation/provider activation.

## Composition dependency

The catalog owner supplies unregistered 0515's protected per-organization
`material_restore_generation` and `sovereign.rotate_material_restore_generation() RETURNS integer`.
It requires the actual migrator login, rotates UUIDs after PostgreSQL/schema readiness and **before
any object restore/reapply/readers**, and refuses missing/error states. This is distinct from auth
session invalidation and from ordinary export-epoch increments. The restore script must call the
actual helper and must not infer generation from time or empty debts. Its SQL/runtime qualification
belongs to the catalog/root gate; this inventory does not claim it passed.

## First bounded source checkpoint

Root approved 0422 and the concrete source design after this inventory. The first unchecked source
checkpoint stages the protected control singleton, original-OID tenant admission guard, ready UUID
reader for prepaid/outcome binding, fixed native admission metadata, native write/read fences and
the begin call to the catalog's real 0515 helper. The common application/agent transaction facade
asserts admission for unbound reads too. Read/count helpers avoid private-row output and filtered-zero
proofs; native invalidation scopes never grant application admission.

This is **incomplete, unregistered source**. Operator security snapshot/fingerprint, deny-only
reconciliation/acknowledgment, native JWT cutoff hooks, actual cryptographic invalidation, command
packaging, restore-script ordering, UX/error mapping and denied/race tests are still being authored.
The acknowledgment guard already requires the fresh fingerprint helper; there is no permissive
fallback if that dependency is missing. Do not apply or activate this intermediate checkpoint.

No formatter, lint, type, unit, database, migration, provider, build, browser or restore check has run
for this foundation. No new real credential or runtime activation was used. Earlier self-link checks
do not qualify it. Root will review the completed composed source before a separate allowed gate.

## Second bounded source checkpoint

The next unchecked source adds restrictive native and fixed-owner metadata read fences (using the
actual session login), dispatcher entry/batch fences and outbox policies, native admission hooks,
HS256/native-issued-at email verification cutoff, typed restoring-page/API behavior, and the real
native cryptographic invalidation transaction. The crypto helper checks the supplied key against
each bounded factor page before mutation, writes a valid native encrypted empty recovery-code list,
preserves TOTP/flags/counters, raises the lock deadline, removes actual transient state, and asks the
SQL guard to validate exact generation/actual zero state. Exact-generation retry verifies the stored
proof and native empty ciphertext; it does not invent a second successful cleanup.

New pure/native-library tests are authored but unrun. Their explicit memory adapter/metadata doubles
cannot qualify PostgreSQL roles or a real restored installation. The pinned native email issuer has
no `iss` claim; this source verifies its actual HS256 signature/email/iat/exp form and does not invent
a required issuer claim. A token from before the cutoff, a coarse same-second token, a foreign issuer,
missing/future issuance, wrong key or other algorithm is refused after a restore.

The UUID helper is a pure metadata read, not a lock over provider I/O. A previously committed remote
admission may still finish; stopping a process or losing its response cannot certify that no remote
effect occurred. Every actual reader/worker must stop/drain before begin. Unknown prior external
effects retain debt and need independent reconciliation. Post-I/O generation refusal fences stale
acceptance/refund; it cannot recall an already delivered charge or send.

Operator snapshot/fingerprint, deny-only reconciliation/acknowledgment, recovery job packaging,
restore script ordering and actual role/browser/restore gates remain unfinished. 0422 is still
unregistered; no source check, database, build or restore has run for either restore checkpoint.

## Third bounded source checkpoint

The operator source now has actual-migrator-only inspect, deny-only reconcile and acknowledgment
helpers. The bounded explicit metadata snapshot includes security policies, native identity hashes,
provider configuration hashes, current memberships/team access, SSO links, SCIM state and invitation
state. It exports no XML, password/token/cookie/assertion or factor bodies. Large inventories refuse
instead of truncating. Mutations retain exact tenant/target identity; they can disable/downgrade,
deprovision or remove access, never reactivate/promote. Begin revokes outstanding invitations and
SCIM bearer sets while retaining their history. A tenant without a surviving active owner remains
pending with a repair-required refusal; this command cannot invent a replacement owner.

Acknowledgment requires the exact generation, backup and manifest, current locked security
fingerprint, an actual nonempty bounded operator review artifact, real 15-minute cooldown and zero
transient authentication state. The review declares external-authority and previous in-flight-effect
reconciliation evidence; it is human review, not a live-provider verification. SQL validates the
generation, fresh metadata/counts and transitions. The native cryptographic tool remains the trusted
boundary for decrypting the supplied key and encrypting an empty recovery-code list; SQL does not
claim to decrypt or cryptographically verify passwords/ciphertexts.

A new one-shot auth-restore Compose job has only the auth DB URL and native key, with no Temporal,
object, vault or provider credential. Ordinary workers gain no key/role. The worker receives one
workspace dependency/build entry; no dependency version/resolution or third-party package changes.
The restore script now enumerates all configured project services, including overlay replicas,
stops/verifies all readers except PostgreSQL/object storage, restores DBs, applies schema, commits
begin (including 0515 material UUID rotation), and runs the real native invalidation BEFORE writing
object bytes. Missing helpers/jobs/results stop. It never acknowledges or resumes readers.

New parser and exact command-boundary regressions are authored, not run. Their command double
does not qualify Docker, native roles, real restore or external services. All source checks and
actual PostgreSQL/restore/browser gates remain open; 0422 is still unregistered. Dedicated isolated
real-role tests, operator runbook and independent source review are next.

The later source also closes native initialization before provider plugins, retains per-request
checks for warm runtimes, and maps pending initialization to the same typed refusal. An owned local
rejection handler preserves the original rejected native promise; no global rejection listener or
permissive fallback is added. An accidentally started pending runtime must restart after real ack.

An opt-in isolated role profile is authored at tests/integration/auth-restore/authority.gate.ts,
with vitest.auth-restore.config.ts. It requires all actual role URLs to the same explicitly named
disposable ensemus_auth_restore_* database. It enrolls via native HTTP, never seeds admission or
assurance and never advances a test clock over the cooldown. It deliberately leaves the disposable
database pending and is excluded from the shared integration suite, which must remain available.
These cases are unrun; the profile/config are not a role acceptance result.

The final root-owned 0999 migration must call identity.extend_auth_restore_admission() AFTER all
SaaS tables/grants and eraser reach. It adds restrictive ready-UUID policies for actual operator,
support and eraser raw reach, no new grants. Missing required SaaS/eraser inventory, an unknown
reachable application schema, non-FORCE-RLS/view/materialized/foreign reach or TRUNCATE privilege
refuses registration. Repeated calls verify existing policy definitions rather than replacing an
unexpected policy. This helper is source only; currently unregistered coverage is not claimed.

Preserved native password/account history can also be older than the last real credential change.
Snapshot hashes bind exactly what was reviewed; they do not prove a restored password or provider
account link is still current. External-authority review must address that uncertainty. Root approved
the separate bounded follow-up: exact selected-account password NULL or OAuth token-material NULL
under the same pending generation/locked fingerprint, with real membership-to-account tenant
association. All other account/user/TOTP identity stays intact; no insert/relink/activation/new
credential is accepted. Native-password/cross-tenant/elevation role cases are authored, unrun.
Clearing OAuth tokens does NOT disable its retained provider-account login binding or prove historical
link authorization. That separate live-authority/revocation gate remains explicit, never an implicit
result of this tool. No source/runtime checks have run for this follow-up.

The pre-gate source review also removes reliance on planner/PK evaluation to avoid recursive
verification-table admission. The fixed control reader owns a saved/restored scope whose outer
RLS CASE selects only that row without recursing. The actual count helper explicitly clears and
restores that narrowing scope before querying, so caller GUCs cannot create a filtered-zero proof.
Actual-role spoofed-scope/count regressions are authored, unrun; no private body grant is added.

The invoker authority-change trigger uses only the granted admission assertion for ordinary runtime
roles. Only the actual migrator branch reads the private backup/review control body. This avoids
requiring a new private-body EXECUTE grant for ordinary admitted membership/account mutations;
existing authority/RLS guards still run. This source correction awaits the same actual-role gate.
