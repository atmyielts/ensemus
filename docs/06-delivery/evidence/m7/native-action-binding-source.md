# Native action binding repair — source checkpoint

Source base: fixture checkpoint `9b9b5a1`, branch `codex/native-action-binding`, following root `13ecde0`. This changes three security action-state bindings and two native HTTP fixtures. It changes no authorization, session, MFA/SSO policy, framework dependency or build command.

## Observed failure and diagnosis

Root's built recovery runner timed out twice at 180 seconds before its first browser page opened. A separate fixture runner also stalled. A bounded HTTP MFA setup POST and an actual Chromium submission with JavaScript disabled reproduced the hang before response headers. JavaScript setup had succeeded. Later inspection found the real pending, unverified factor rows: the action had executed, despite the earlier idle-database observation. Root's process-only instrumentation then observed native `decodeFormState` entry, subscription and readiness without a response.

The same source compiled and typechecked under webpack but reproduced the native POST hang. A process-only diagnostic forcing the request phase back to rendering did not resolve it. Neither bundler choice nor that phase hypothesis is established as the cause. No dependency patch or production build switch is included.

A bounded classic bound security-settings POST using an invalid version returned 303 in 62 ms. A separate local decoder probe completed action decoding, a no-effect diagnostic invocation and form-state decoding in at most 1 ms for both synchronous and asynchronous manifest entries. These comparisons do not constitute MFA enrollment acceptance.

The bounded renderer probe used the actual pinned React 19.3.1 `renderToPipeableStream` and Next 16.4.5 RSC `createServerReference`, a fake action that throws if invoked, a fake organization and a writable sink. It submitted the native form-state tuple to the renderer, capped component renders at 12 and each case at 500 ms. It made no HTTP, database or provider call and generated no authentication proof. Observed results:

| Case | Result | Component renders | Returned state | Duration |
| --- | --- | ---: | --- | ---: |
| Initial GET equivalent, binding inside render | rendered | 1 | idle | 20 ms |
| Native postback, binding inside render | safety-cap shell error | 13 | hook never returned | bounded by render cap |
| Native postback, one binding created before render | rendered | 2 | ready | 1 ms |
| Native postback, unbound module action | rendered | 1 | ready | 0 ms |

The installed RSC client creates a new bound-argument promise on every `.bind()`. During native postback, Fizz's `useActionState` signature check suspends on that promise. Re-running a client component that creates a fresh binding creates another unfulfilled promise; the probe demonstrates repeated suspension. A stable server-supplied binding survives the retry and restores the posted action state.

## Narrow source repair

- `EnrollmentForm` receives its already-bound `enableAction` from the two-factor server page. Its ready-state confirmation also receives the server-bound `finishAction`.
- `RecoveryCodeForm` receives its already-bound `regenerateAction` from that server page.
- `TokenForm` receives its already-bound SCIM `issueAction` from the SSO server page.

The three affected `useActionState` inputs now have typed action props instead of `.bind()` calls inside client render. Existing tenant arguments, native permalink, one-time secret state, submission fields, action implementations and fresh authority checks remain in place. This uses ordinary server-component action references, with no hidden-authority wrapper or memoization assumption.

An audit of all web `useActionState` call sites found these three dynamically bound hook inputs in two client files. Custom-object and Studio forms use stable module actions; generic action-form abstractions receive action props from server parents. Conditional references to existing unbound module actions do not create a bound-argument promise. No speculative change was made to those forms.

The stack MFA and Studio fixtures now post the actual **Confirm and turn on** form from the enrollment POST response and require the exact organization security destination with `notice=enrolled`. Their intentional previous-window TOTP counters are preserved, so the later proof/replay checks keep their original semantics. A fresh GET is not substituted for the deliberately ephemeral enrollment response.

## Checks and remaining acceptance

Scoped Prettier formatting and ESLint passed for all six changed TypeScript files. `git diff --check` passed. No unit, type, build, database or browser suite was run for this repair checkpoint. The renderer and decoder results above are bounded diagnostics, not a browser acceptance claim.

Root will join this repair, run current web/tests types and rebuild clean production output with the normal build configuration and a new owned preview action key. Process-only instrumentation must be removed. Actual JavaScript-disabled setup and confirmation, recovery regeneration, SCIM issuance and the SSO recovery journeys remain unqualified until exercised against that clean build. Provider/operator qualification remains open. The original timeout and failed webpack comparison are retained above.

## Joined runtime checkpoint, 2026-11-08

The joined source passed all workspace type checks and the normal production build. The clean
standalone runtime used a new task-owned action-encryption key and no diagnostic preload. A bounded
native HTTP fixture completed actual MFA setup and confirmation, SSO configuration, exact operator
review, activation and member admission without the former postback suspension. These results
qualify the repaired bootstrap path only. The subsequent callback exposed separate request-replay
and explicit-account-linking work; see [the SAML runtime evidence](saml-fixture-runtime.md).

Complete JavaScript/no-JavaScript enrollment, recovery regeneration, SCIM and SSO browser
qualification remains open. The full joined unit checkpoint passed 5,548 tests with two explicit
skips across 244 files; that count is not browser or provider acceptance.
