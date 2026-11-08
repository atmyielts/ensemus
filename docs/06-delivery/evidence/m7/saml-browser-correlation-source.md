# SAML browser correlation — separate source checkpoint

Base: root `7ed2693`, branch `codex/saml-browser-correlation`. Unfinished explicit self-link work is preserved separately at `cafaa2c` on `codex/sso-self-link`; it is not included or qualified here. Account P2 source `1917cc3` also remains separate.

## Verified source gap

Installed `@better-auth/sso` 1.7.17 `dist/index.mjs:2679–2691` calls `parseGenericState` with `skipStateCookieCheck: true` for the cross-site SAML POST. Its valid AuthnRequest and RelayState do not alone bind the callback to the browser that initiated it. This checkpoint closes that independent boundary for every native SAML start, without selecting a user or weakening implicit-link refusal.

## Source behavior

- After the actual native SAML endpoint generates its redirect, a bounded parser reads that native-generated AuthnRequest ID and RelayState hash. The guard locates the exact native `saml-authn-request:` verification row, validates its provider and current reviewed configuration, then records a short-lived correlation in existing auth-private `identity.verifications` under `ensemus-saml-browser:v1:`. The original native request, state and signature verifier remain authoritative.
- A purpose-separated signed `__Host-ensemus-saml-browser` cookie carries signed `signin` mode, opaque correlation ID, binding hash and random browser proof. It is `Secure; HttpOnly; SameSite=None; Path=/`, lasts at most five minutes, and is capped by the actual native request expiry. Only the proof hash is stored. General session/challenge cookie policies remain unchanged.
- After the real library verifies the signed protocol input, the existing resolver requires the current browser proof, exact request/relay/provider/issuer/configuration, live prepared row and native envelope subject. Missing, expired, unknown-mode or mismatched input refuses before account/session finalization; it never falls through to `continue`.
- A successful correlation makes an exact value/expiry conditional prepared-to-consumed update through the resolver's supplied native transaction adapter. It rechecks expiry after acquiring that UPDATE lock. Native account/session failure rolls correlation consumption back in the library's same transaction. The resolver still returns only `continue`; it never returns `link` or changes `emailVerified`, global linking flags, membership or assertion-role handling.
- Only a matched attempt's purpose cookie is expired. An unrelated failed callback does not erase the browser's other valid attempt. Existing native session/MFA cookie headers are preserved. All callback state is request-local; no tenant/token cache, log payload, network fetch or Temporal field is introduced.

## Authored regression scope

Protocol units cover missing/cross-browser/tampered/expired/consumed proof, request/relay/provider/issuer/subject/config mismatches, unreviewed configuration, unknown fields/mode, expiry after an UPDATE wait, cookie attributes/native cookie preservation, native redirect bounds and one-time successful `continue`. Their native-adapter doubles are unit fixtures, not SQL or signed sign-in acceptance.

Five actual browser cases are authored: JS/no-JS native IdP-first identity creation followed by a real invitation/confirmation and returning exact-account sign-in; valid signed login-CSRF from another browser; mismatched attempt preserving that browser's own valid attempt; and an actual expired correlation row denying a still-valid signed callback. The expiry helper only moves one identified native-generated test row into an expired state; it never creates a passing proof, Account or assurance. The positive journey deliberately avoids silently linking an existing unverified password account. Role claims remain untrusted.

## Validation and remaining work

The granted exclusive source gate completed, serially:

- Scoped Prettier and ESLint passed for all eight changed TypeScript files.
- `pnpm exec vitest run --project unit tests/unit/saml-browser-correlation.test.ts packages/auth/src/sso.test.ts tests/unit/sso-request-replay.test.ts --maxWorkers=1 --no-file-parallelism`: **56 passed across three files**, including all 22 new correlation units.
- Sequential `pnpm --filter @ensemus/auth typecheck`, `@ensemus/tests typecheck` and `@ensemus/browser-tests typecheck`: **all passed**.
- `git diff --check` passed before the checkpoint.

Every command passed on its first attempt, with no install, repair or rerun. The slot was explicitly released after the final typecheck. No database, SQL, migration, build, browser execution or provider check ran. All actual signed callback/browser cases remain unrun, and these source checks do not qualify a deployment or provider.

No migration, new table, RLS grant, GUC, schema/journal or new dependency is included. Existing auth-private verification exclusion/restore semantics apply to the new short-lived prefix. Explicit native self-link consent, source-session/primary/membership finalization guards and reserved **0421** remain a separate unfinished chain; ordinary unverified password accounts are still refused until that chain is implemented and qualified. Root's dirty IdP/XSD/certificate fixtures and M6 inventory/cursor edits are untouched.
