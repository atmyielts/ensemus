# Account identity recovery — source checkpoint

Source base: root `6c8f319`, branch `codex/account-step-up`. This follows the bounded source audit of Account, billing, support, lifecycle and export UI against the shared interface system. It does not qualify those journeys or a hosted operator/provider.

## Concrete gap

An owner with expired or absent MFA proof can be refused by `requestOffboarding` when administrative MFA is enabled. The old request form displayed the refusal without a verification destination. The existing workspace confirmation and enrollment pages use core admission, so a suspended owner following them was sent back to Account. An unenrolled suspended owner could not set up the factor needed for the authorized account request.

## Source behavior

- Fixed `/account/confirm` and `/account/two-factor` server pages and separate server actions use unchanged `requireAccountTenant` admission. It still resolves a native same-user session and active membership, applies the restore gate and required company sign-in, and restricts lifecycle admission to the account surface. Core confirmation, enrollment and lifecycle admission remain unchanged.
- The confirmation form is shared with the core page, but each server parent supplies its own stable bound action. No submitted surface selector or broad serving context is exposed.
- Account enrollment calls the actual native MFA enable and confirmation operations, including their password/primary-proof, rate-limit, factor, session rotation and proof checks. Its only application adapter returns the current security policy through the existing fresh-member policy reader under the narrow account scope. No policy mutation, factor disable, reset or recovery-code regeneration is added to Account.
- Secret setup material remains in the enrollment POST state only. Codes and passwords have no retained input/default state, URL, log or browser storage. A fresh enrollment GET displays no setup secret or recovery code. Existing pending setup must be finished with its saved key or reset by the operator; it is never silently replaced.
- Exact allowlisted same-organization account destinations survive confirmation. Core/data/import paths, other organizations, unknown routes, query/hash payloads, path traversal and external URLs fall back to Account. Enrollment's native permalink includes only its validated return destination.
- Five existing action-state forms (offboarding, legal hold, retention, support, billing details) share an explicit MFA recovery notice. It opens verification in another tab and leaves the original submitted safe values and original version in place. The original request is never automatically submitted or upgraded to the latest version. Its existing submit button runs fresh authorization again after the person chooses to retry. This adds no MFA requirement to ordinary account actions.

## Authored regression coverage

`tests/unit/web-step-up.test.ts` adds actual account destination/record-path allowlist and adversarial return cases, alongside the existing core return tests.

`tests/browser/specs/account-mfa.spec.ts` authors five actual native/browser cases:

1. JavaScript and no-JavaScript suspended, unenrolled owners retain their submitted offboarding draft while enrolling in another tab. A second actual owner enables the policy through the shipped HTTP API; no policy/proof row is fabricated. The test confirms actual MFA with generated TOTP, checks response no-store and fresh-GET secret absence, verifies core stays closed, and only then explicitly retries the original request.
2. JavaScript and no-JavaScript suspended owners with genuinely expired proof verify in another tab and retry their retained draft. These cases wait beyond the real 60-second policy age; they do not edit proof timestamps or mint assurance rows.
3. Foreign-tenant access remains missing, and external/core/data return destinations stay on the account surface.

The actual offboarding halt binding must be configured for successful request cases. A missing binding is a failed/unavailable gate, never a fake success or conditional skip. Test-created names use the existing generated account test guard; standing changes use the actual application-role service and assert there are no agent runs.

## Actual validation

The exclusive bounded source slot completed successfully, one heavy process at a time:

- Prettier and ESLint passed for all 16 changed TypeScript/TSX files.
- `pnpm exec vitest run --project unit tests/unit/web-step-up.test.ts --maxWorkers=1`: **47 passed**, one file (including existing core return coverage).
- Sequential `pnpm --filter @ensemus/application typecheck`, `@ensemus/tests typecheck`, `@ensemus/browser-tests typecheck` and `@ensemus/web typecheck`: **all passed**, including real Next route generation. Every command passed on its first attempt; no repair, install or rerun was needed.
- `git diff --check` passed before the source checkpoint.

No SQL, database, build, browser execution or activation was performed for this follow-up. The new browser cases, administrative MFA while suspended and end-to-end offboarding effects remain unrun. Source checks do not qualify those outcomes. The slot was explicitly released to root after the final web typecheck.

No schema, migration, secret/config, global navigation or CSS change is included. The audit's separate missing retention/legal-hold discovery, explicit conflict reload and raw reason-code usability findings remain outside this recovery checkpoint.
