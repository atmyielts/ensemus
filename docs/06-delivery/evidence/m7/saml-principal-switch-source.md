# Pending self-link after a native principal switch

Follow-up to `d11e5c6` / ID-04. Source review found that the original purpose cookie plus A's still-live
source session could survive a genuine password sign-in as B in the same browser. A later signed
callback could therefore select A after B had become that browser's current person. The original
102 passing source tests did not cover this case and do not qualify this follow-up.

The native `session.create.after` hook now records only actual created person IDs in the existing
request-local browser flow. Observation is limited to native signup, password, operator OIDC/SAML and
factor-completion endpoint templates. It neither selects a user nor creates/revokes a session or proof.
The private factor router uses the same request-local wrapper. Existing MFA/native admission hooks
remain responsible for actual authentication and cookie forwarding.

After a native operation, a cryptographically valid pending `self_link` proof for a different newly
created person is expired. If that verified proof's metadata is unavailable, it is conservatively
expired too. Invalid/ordinary proof cookies, same-person reauthentication, background session updates
and requests without a native session-creation observation do not clear an unrelated pending attempt.
Native session/challenge cookie bytes are preserved. An early native primary session created after
valid password proof may subsequently be withheld for MFA; expiring an older pending selection then
is conservative invalidation, **not evidence that MFA was passed**. Final native factor completion is
also observed; no factor is bypassed.

The Server Action credential adapter previously forwarded no browser cookies. It now carries only the
bounded exact SAML purpose cookie into its internal native signup/password request. It still forwards
no old native session or arbitrary browser cookies. Actual browser form journeys are necessary to
qualify this adapter seam.

Authored coverage adds ten protocol cases (five primary/factor templates, same-person/background/
unobserved/invalid-proof preservation and metadata outage), two real-native credential-form cases,
and four browser journeys: password B, signup B, real enrolled-factor B, and same-person/background
preservation. In the B cases A's source session is explicitly checked to remain live; the already-open
genuine A assertion must refuse while B remains current. No role SQL changes are part of this patch.

The bounded exclusive source gate on 2026-11-08 passed on its first attempts:

- Prettier and ESLint on the exact five changed TypeScript files.
- `pnpm exec vitest run --project unit tests/unit/saml-self-link.test.ts
  tests/unit/saml-browser-correlation.test.ts packages/auth/src/sso.test.ts
  tests/unit/sso-request-replay.test.ts packages/auth/src/oidc-primary.test.ts
  packages/auth/src/mfa.test.ts --maxWorkers=1 --no-file-parallelism`: **112/112 in six files**, with
  no skipped/disabled cases or warnings in this selected run. Ten cases are new to this checkpoint.
- Serial `@ensemus/auth`, `@ensemus/tests`, `@ensemus/browser-tests` and `@ensemus/web` typechecks.
  Web ran actual `next typegen && tsc --noEmit`.

No install, database, migration, build or browser execution occurred here. The exclusive slot was
released after the final web types. The two new real-native credential-adapter cases and four new
browser journeys remain unrun. Root separately reported **14/14 original 0421 real-role cases passing
on a fresh 68-migration PostgreSQL database**; that is independent baseline evidence, not execution of
this follow-up's new switch cases. 0421 registration/activation remains root-owned.

## Restore audit

Source inspection of the current `infrastructure/scripts/sovereign-restore.mjs` found full database
restoration followed by object restoration and the reconciliation reminder, with no private
verification/session invalidation. Its M6 restore runbook and reconciliation source do not supply one
either. `packages/database/src/auth.ts` consumes an individual IdP bridge; that is not restore-wide
invalidation. Both new prefixes are private and excluded from portable transfer, but the trusted full
database backup includes them and native request state. Restoring a still-live prepared row while
keeping the auth secret and browser cookie can resurrect that pending selection within its TTL.
Five-minute expiry is not restore invalidation. No claim of existing restore protection is made.

Root assigned an actual auth restore invalidator/script composition as the next separate task. That
work must inventory session/primary/pre-auth/recovery implications, preserve enrolled factors and
credentials, and coordinate the distinct material restore-generation guard. It has not been
implemented or executed in this checkpoint.
