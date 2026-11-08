# Native SSO fixture correction — source checkpoint

Source base: root `13ecde0`, branch `codex/sso-native-fixture`. Only test helpers change; no product, auth policy, session/proof seeds or browser-security exception is introduced.

## Observed failures, still open

Root's built `object-sso-recovery` runner timed out twice at 180 seconds before any browser page opened, and a separate non-SSO fixture also timed out. Root's bounded HTTP diagnostic found the first MFA setup POST stalled before headers or database activity; the preceding sign-up, organization creation and MFA GET completed. Root then reproduced that setup stall in actual Chromium with JavaScript disabled. This is not qualified as a test-parser-only failure.

Root observed that native ESM could not import samlify's CommonJS getter export by name. A default import collected in native ESM but failed under a tsx CJS transform. Root's standalone certificate probe completed in approximately 113 ms, so certificate generation was not the observed setup hang.

An allowed low-impact HTTP diagnostic in this checkout created one generated diagnostic account/organization and inspected the actual MFA GET without posting setup. It confirmed the expected four native hidden fields and bound Promise reference, without printing cookies, hidden values, setup secrets or passwords. It did not reproduce a successful MFA setup. Root independently observed the same fields in real Chromium.

## Narrow corrections

- `tests/helpers/saml-idp.ts` uses Node `createRequire(import.meta.url)('samlify')` typed as the installed module. This loads the actual CommonJS getter exports in native ESM and transformed test runtimes, without default/namespace heuristics or any signing-policy change.
- `tests/helpers/sso-stack-fixture.ts` now selects the actual **Confirm and turn on** form from the enrollment POST response and posts its native hidden fields directly. The previous `submit(... /Finish setup/)` performed a fresh GET, losing deliberately ephemeral `useActionState` enrollment data, and searched for a button that does not exist.
- Confirmation uses an actual current generated TOTP and requires the exact same-origin organization security destination with `notice=enrolled`. An arbitrary 303 error redirect no longer counts as successful MFA enrollment.

## Actual checks

Scoped Prettier and ESLint passed for the two changed helper files. No unit/type gate, browser suite or production build was run for this checkpoint. No assurance row, identity brand or SSO/MFA approval was seeded.

The pinned Turbopack native-action hang remains open. Root is comparing the same source with Next's supported webpack build; neither these helper corrections nor the comparison are claimed to fix native setup until observed. Genuine native MFA/SSO, the five recovery journeys and hosted provider/operator qualification remain separate acceptance gates.
