# Explicit native company-account connection — source checkpoint

Backlog ID-04 / ADR-031 D9. Additive to the separately checked browser-correlation checkpoint
`4d1ecfb`; it does not replace that checkpoint's tests or imply a signed callback has passed here.

## Behavior

An already signed-in person explicitly selects **Connect company sign-in to this account**, confirms
consent, and proves the actual current local credential with Better Auth's configured verifier. A
passwordless account instead requires its existing signed primary receipt, with actual provider
authentication time no older than five minutes and current operator/provider trust. The native
endpoint uses authoritative session middleware; no submitted user, session, company, provider or role
ID is accepted. Ordinary **Continue with company sign-in**, local-email verification and global
account-link settings retain their previous semantics.

The existing purpose cookie also signs the explicit `self_link` mode and canonical source tuple.
Both ordinary and explicit callbacks require the exact browser proof, native request/relay, signed
subject/issuer, reviewed provider and current configuration. Missing mode, source, metadata stamp,
expired intent or a mismatched browser refuses without falling back to ordinary sign-in.

The explicit resolver consumes through Better Auth's **transaction-local native adapter** and returns
`link` / `profile: preserve` only after the SQL guard adds its finalization stamp. The native library
then owns Account collision checks, Account/session writes and rollback in that same transaction.
The name, email and local email-verification state are not overwritten. Existing local second-factor,
tenant provisioning and deprovisioning paths remain active.

## SQL and trusted-code boundary

`0421_saml_self_link_authority.sql` is **unregistered and unrun**. No new table, public role grant,
provider egress, environment key or tenant account-link toggle is added. Existing auth-private
verification rows carry bounded short-lived prepared/consumed intents. They remain private and
nonportable; no portable archive/import authority is introduced.

PostgreSQL runs same-kind triggers by name. The source defines:

1. `verifications_0421a_self_link_native`, an auth-invoker guard, which validates the exact immutable
   source tuple, current native session/token fingerprint, locked credential hash or signed-primary
   receipt and reviewed provider configuration. It refuses both prefix transitions, forged stamps,
   stale/revoked state and changed primary identity.
2. `verifications_0421b_self_link_scope`, a fixed-owner, fixed-target metadata trigger, which alone
   calls the private org/member helper, rechecks live confirmed membership/provider/link metadata,
   and adds scope/finalization stamps. It refuses every other relation/trigger name. PUBLIC and auth
   have no EXECUTE privilege on this trigger or its helper. No application/agent body or proof-write
   grant is added.

The preparation selector is `identity.saml_link_preparation`, set only inside a fully owned auth
transaction by the native-verifier helper. **This custom GUC and unchanged fingerprints are not an
independent cryptographic SQL proof that a password was entered.** Password checking is trusted
native application code; SQL revalidates that captured tuple and current authority. The auth role is
already the account/session/credential trust boundary. Browser IDs and app/agent contexts never get
that role. SQL guards do not turn a compromised auth database principal into an untrusted browser.

The metadata helper saves/restores `identity.saml_link_guard_{active,provider,user,org,member,
connection,subject}` on success and failure. Its policy/member try-locks precede metadata row locks,
with NOWAIT where native provider ordering could invert administration. Busy/outage errors refuse
or retry at the caller; they do not weaken current state checks. Native transactions do no external
network I/O.

Source inspection of `infrastructure/compose/postgres/provision.sql` found PUBLIC database privileges
revoked, auth granted CONNECT only, and public schema privileges revoked. No auth CREATE, TEMP or
TRIGGER grant was found in provision/migration source. This is **not an actual-role privilege result**;
the new test asserts the effective privileges and helper denial against the installed database.

## Authored coverage and qualification

Dedicated protocol units cover explicit source selection/profile preservation, missing/stale selection,
wrong browser/mode/session/primary/configuration, unknown fields, missing SQL stamps, canonical jsonb
key ordering and bounded own callbacks. Their transaction adapter is a **unit double**, not native
database acceptance.

The new real-role file creates the source Account/session/password through native signup, then drives
the actual native start/resolver/callback. It includes implicit-link refusal, exact repeat, current
session/member/config/primary loss, forged preparation/finalization, prefix transitions, role/trigger
privileges, app/agent negatives, expired timestamps, and native ownership-collision rollback after an
explicit test-only post-finalization provisioning fault. Existing owner fixture factor setup is used
only to configure the generated provider; it is not a source self-link or assurance seed.

Five browser cases are authored: JS/no-JS explicit connection preserving the original unverified
profile, ordinary implicit refusal, cross-browser refusal, and actual local-factor enrollment/challenge.
Existing object-editor recovery journeys now explicitly connect the native account in the other tab.
Their original draft and expected-version retention checks remain.

The bounded exclusive source gate ran on 2026-11-08:

- Prettier wrote the exact 13 changed TypeScript/TSX files. Initial scoped ESLint found two
  `no-control-regex` violations; those expressions now check control character codes directly. The
  same scoped formatter/linter rerun passed. No security bound was removed.
- `pnpm exec vitest run --project unit tests/unit/saml-self-link.test.ts
  tests/unit/saml-browser-correlation.test.ts packages/auth/src/sso.test.ts
  tests/unit/sso-request-replay.test.ts packages/auth/src/oidc-primary.test.ts --maxWorkers=1
  --no-file-parallelism` passed **75/75 in five files**, including 17 dedicated self-link cases.
- The same bounded command for `packages/auth/src/mfa.test.ts` passed **27/27**. Total: **102/102
  tests in six files**; none were disabled or skipped.
- Serial `pnpm --filter @ensemus/database typecheck`, `@ensemus/auth`, `@ensemus/tests`,
  `@ensemus/browser-tests`, and `@ensemus/web` passed on their first attempts. Web ran actual
  `next typegen && tsc --noEmit`.
- No install, database, migration, build, browser execution or provider activation occurred. The
  exclusive slot was released immediately after the final web type command.

The 14 real-role cases and five new browser cases remain authored/unrun. SQL apply, effective
privileges/real-role tests, clean build, browser journeys,
provider qualification and outside security review remain open. Generated local signed fixtures are
not a real identity-provider qualification. Cloud/BYOM/Sovereign share this source; no live-mode or
operator acceptance is claimed.
