# ID-05 MFA source checkpoint

Scope: ADR-031 D8, ID-05, QA-045 and TR-025. This is implemented source plus focused local checks. It is **not** a database, built-stack, browser, outside-security-review or M7 acceptance claim.

**Subsequent SSO source correction (unvalidated):** callback/session creation time does not prove recent IdP authentication. The active SSO work removes the earlier operator OIDC callback-time receipt. Without an actual validated signed `auth_time` binding, passwordless operator OIDC setup fails closed. SAML is being bound to the exact accepted POST and signed `AuthnInstant`, with live provider/member revocation. The commands below describe MFA checkpoint `36c3e88`; they do not validate these later SSO edits.

## Behavior

An enrolled password sign-in returns the plugin's signed challenge, without a full session. The code form then verifies through a private, rate-limited Better Auth router. It checks the authoritative cookie/session identity before and after verification, admits the actual accepted account code across replicas, writes trusted recent assurance, and only then forwards the resulting cookie. Form fields cannot select a user or session. A step-up returns only to a checked path in the same company.

Public factor verification and management routes return 404. In particular, password-only disable/recovery regeneration cannot bypass recent verification. The private router omits framework cookie plugins, so it cannot automatically forward a session before admission/proof succeeds. It also omits OIDC/SAML plugins: checking a TOTP code cannot cause provider discovery. No verification uses `auth.api` to bypass router limits.

The pinned `better-auth@1.7.17` plugin supplies confirmed TOTP enrollment, encrypted factor/recovery storage, atomic recovery-code consumption and sign-in account lockout. Its installed source was inspected, alongside the [official two-factor documentation](https://www.better-auth.com/docs/plugins/2fa). Source-specific findings were addressed:

- An enrollment confirmation rotates the session, while its response body may retain the earlier user snapshot. Assurance binds the authoritative resulting cookie session, never that response token/snapshot.
- The plugin accepts a current TOTP repeatedly. A separate auth-role admission ledger prevents using an admitted account code to create another recent proof.
- The plugin's account counter applies to sign-in challenges, not signed-in code checks. Signed-in verification/enrollment first reserves the same configured account budget in a short auth-role transaction. Parallel replicas cannot all pass a read-only counter check. No database lock spans a call into the private router.
- A trusted admitted proof and the reserved factor's counter reset commit together. Refused, replayed, failed and unknown attempts do not reset the budget. Sign-in remains single-counted by the plugin.

The native policy is one shared constant: ten attempts and a 900-second lock, matching the explicitly configured plugin options. The final permitted reservation may still succeed; later reservations are denied. Duplicate factor rows fail closed.

Authorized migration `0402_second_factor_uniqueness.sql` is authored, **not journaled or applied**. It holds the factor table write lock while checking existing duplicate user IDs, then adds the matching unique-per-user index. Existing duplicates stop the migration with sanitized `SECOND_FACTOR_DUPLICATES_REVIEW_REQUIRED` / `EN402`; no secret is selected or removed. Its immutable-secret UPDATE trigger (`EN403`) also prevents the pinned plugin from overwriting a competing unconfirmed setup. Confirmation and recovery-code rotation remain allowed because neither changes the TOTP secret.

Concurrent/stale setup and already-enrolled requests return plain, distinct refusal states without returning keys. A saved pending key can still be confirmed during its current setup authorization. A lost pending key requires the actual installation operator reset; there is no invented self-reset button. The existing `identity-operator reset-second-factor <email>` command, using migrator authority after the operator verifies the person, clears the factor and its assurance. People who still have their factor may explicitly turn it off with their password/live code, then enroll again. The new pinned-flow concurrency and rollback-only duplicate-upgrade cases are authored but unrun.

## Trusted proof and crash recovery

MFA proof insertion locks and rechecks the actual enabled user and matching unexpired session in the auth-role transaction. It cannot mint for another person's session or an expired session. The application role receives no assurance write grant. A service/agent/delegated context cannot pass privileged confirmation.

Factor removal clears MFA-kind assurance on every session, preserving SSO and other people's proofs. Privileged validation also checks the existing narrow `two_factor_enabled` metadata grant, so a crash between disable and revoke-all cannot leave old proof usable. Before enabling a replacement factor, confirmation deletes old MFA proofs again: reenrollment cannot revive another session's old-secret proof after such a crash. Operator reset already locks/updates the user before removing factors and proofs, matching this order.

Tenant policy changes recheck the live active owner capability and recent proof in the effect's transaction, validate the 60–3,600-second range, compare the submitted version, and emit/audit IDs, enums and counters only. An absent row has virtual version 1; the first change creates version 2 so concurrent initial saves cannot both succeed. Existing M2 administration remains opt-in. Member managers may see names and enrollment status, never secrets.

## Primary authentication for passwordless accounts

A password remains mandatory and verified by the pinned plugin for credential accounts. The optional password field supports accounts that actually have no credential password; it is not an exception for a missing password.

Session `created_at` is **not** primary-authentication time: the pinned adapter resets it during rotation. Passwordless enrollment instead needs a session/account-bound primary receipt minted only after the allowlisted operator OIDC callback (`/callback/:id`, matching the configured provider and an actual new session). Refresh and factor rotation cannot create or refresh that receipt. The account must still have that configured provider link and an active session. Local provider removal or an absent provider configuration refuses bootstrap. Remote IdP revocation requires the deployment's actual session/account/deprovisioning path; no outbound introspection is invented here.

After the private enrollment endpoint actually verifies the password/primary authorization, an opaque setup receipt binds the same session, current credential hash or verified provider receipt, and current tenant confirmation window. Confirmation checks it before activating the pending factor. Password changes, missing/old receipts, another/rotated session and removed local provider links fail closed. The application supplies the current policy window; a form cannot lengthen it.

**SAML bootstrap is still unbound.** The next SSO slice must bind the verified SAML callback and live provider revocation to this primary-authentication boundary. Missing primary evidence stays refused. The generated no-credential integration case uses an explicitly trusted auth-role primary-receipt fixture; it does not claim a hosted/provider assertion was verified.

## Opaque metadata and key/expiry assumptions

All three receipts use existing auth-only `identity.verifications`; no new migration or grant was introduced:

- `ensemus-mfa-admit:v1:` stores only an opaque HMAC digest/UUID and fixed `consumed` value. The key covers the actual account, factor kind, accepted code and overlapping 30-second TOTP windows. Three rows are admitted atomically; a partial loser rolls back. Expiry is at the fourth boundary, up to 120 seconds from creation, beyond the configured adjacent-code validity window.
- `ensemus-primary:v1:` binds the actual user/session through an opaque keyed identifier, records the configured primary provider and first successful authentication time, and expires after one hour. Repeating the same session receipt does not update its authentication time.
- Enrollment receipts use a separate keyed session identity and opaque current credential/provider fingerprint. They expire after one hour, while acceptance always applies the shorter current tenant window. Only an actual successful setup can refresh their setup time.

Replicas must use the same auth key, configured provider identity and clock policy. Changing the auth key/provider identity invalidates these bindings; seamless factor-key rotation or cross-key admission is not implemented. Expiry is not writer authority or proof of deletion. Admission correctness does not depend on garbage collection: expiry/cleanup housekeeping for these namespaces must be included in operator maintenance. No raw code, password, TOTP key, recovery code or response token is stored in these receipts, logs, events or URLs. The setup key appears only in the one-time setup response/`otpauth` link, with no external QR service.

## Interface and authored journeys

The source adds sign-in confirmation, account authenticator setup, recovery-code replacement, disable, recent confirmation, company policy and a tenant policy GET/PATCH route. Ordinary forms and React action-state support JavaScript-disabled submission. Labels, pending controls and errors use the existing interface conventions. Scoped CSS uses shared tokens; globals, navigation and tenant/API shared wiring remain untouched. The runtime change only exposes `createAuth().mfa` for the new server actions and must be merged onto the newer joined runtime, not copied over it.

Recovery material is returned only on setup/replacement. A fresh GET never retrieves it, and the plugin's backup-code-view endpoint stays unavailable. The pinned Next 16.4.5 action handler sets `Cache-Control: no-cache, no-store, max-age=0, must-revalidate`; actual response behavior is asserted by the unrun stack/browser cases.

Authored verification includes 25 real-role/plugin integration cases, including the concurrency/crash/upgrade regressions; four actual built-HTTP journeys; and three keyboard/dark/mobile/no-JavaScript/axe browser journeys. All database/plugin integration, HTTP, browser and accessibility executions remain **unrun**. Test-only pinned-library composition lives in `packages/auth/test-support/mfa-router.ts`, outside production exports and unit auto-discovery.

## Commands actually run

In parent-authorized single-process source slots:

- Owned Prettier and focused ESLint passed. An initial unnecessary regex escape was fixed.
- `pnpm exec vitest run --project unit packages/auth/src/mfa.test.ts --maxWorkers 1`: **25 passed**, one file, 1.85 seconds in the final run (including the three new setup-refusal cases).
- `pnpm exec tsc --noEmit -p packages/auth/tsconfig.json`: passed.
- `pnpm exec tsc --noEmit -p packages/database/tsconfig.json`: passed.
- `pnpm exec tsc --noEmit -p packages/application/tsconfig.json`: passed.
- `pnpm exec tsc --noEmit -p tests/tsconfig.json`: passed in the final run, including the pending-key/concurrent-initial-enrollment and rollback-only duplicate-upgrade cases.
- `pnpm exec tsc --noEmit -p apps/web/tsconfig.json`: passed.
- `pnpm exec tsc --noEmit -p tests/browser/tsconfig.json`: passed.

The first tests typecheck found an undeclared direct Better Auth dependency in the integration test. Library composition moved to the auth package's test-support directory, where the pinned direct dependency already exists; the real DB orchestration stayed under integration. No dependency, lockfile or installation change was needed. No Docker, database test, stack/browser test, watch/dev server, install, Next typegen or production build was run.

## Joined gates still owed

The subsequent [company sign-in source report](sso.md) supersedes the interim OIDC callback-time limitation: actual signed-token `auth_time` binding and mandatory native provider-callback factor challenges are now authored. That subsequent batch is unvalidated until its separately recorded checks; the 25-unit results above apply to the committed MFA checkpoint only.

Root must review/compose the narrow approved auth/database/privileged/helper/runtime diffs onto current milestone code, register/rehearse M7 migrations including the authored 0402 uniqueness/secret-preservation guard, and run the real-role/plugin/HTTP/browser/security gates. Source deliberately refuses duplicate rows rather than choosing an arbitrary factor.

Complete SAML primary/bootstrap/revocation binding, the OIDC primary-receipt callback round trip, same-code/distributed-attempt SQL execution, factor-removal/re-enrollment races, signed-out proof cascade, generated-factor confidentiality scanning, no-store headers, no-JavaScript secret flow, rendered/a11y/mobile checks, shared Administration navigation and OpenAPI close. Runtime/private-provider/security evidence and independent outside review remain open. All three commercial modes share this source; only source-level no-required-egress behavior has been checked here.
