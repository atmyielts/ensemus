# Product browser checkpoint, 2026-11-08

The isolated HTTPS preview uses a clean normal production standalone build, the actual native auth
and application roles, and the disposable 68-migration database. Diagnostic preloads are absent.
All companies, users, records and provider material are generated test fixtures. Original platform
databases and unrelated Docker resources are unchanged.

## Current selected gate

The final common run passed **57/57 cases across eleven files** against one normal production build.
It includes billing/support draft conflicts (4), paused-owner native MFA recovery (5), browser guard
controls and private/missing-page boundaries (7), retention/legal holds (3), offboarding (2),
custom-record SAML recovery (5), custom-record forms/privacy/conflicts (6), native SAML browser
correlation (5), explicit native self-link/principal changes/local MFA (9), long-profile sidebar
layouts (4) and saved workflow map/native editing (7). These overlap the earlier runs below.

The latest full unit run passed **5,614 tests**, with two explicit skips across 246 files. Auth,
tests and browser type checks passed after the native factor repair; web types and a clean normal
production build passed after the final native workflow notice repair. The earlier full workspace
type/license gates remain recorded separately. The bounded public-output check found zero unexpected
private paths and zero matches for the task-only action key in 55 public files; this is not a complete
release secret scan.

The final browser log is `.local-m8-browser-current-common-57-final.log` (5.2 minutes). No browser
case was skipped, no diagnostic preload was used, and the actual proof-expiry cases still waited
over 60 seconds. The task-owned generated TLS providers closed during fixture teardown. Actual
desktop/mobile workflow captures are `output/playwright/m8-workflow-current-desktop.png` and
`output/playwright/m8-workflow-current-mobile.png`; the separate rendered review had zero console
errors/warnings. That owned CLI browser was then closed.

After qualification, the host preview server stopped and the saved-ID/exclusive-volume cleanup
removed exactly the two `ensemus-m8-ui-gate` containers, its two data volumes and its network. A
post-check found zero remaining project containers/volumes. No image or unrelated resource was
removed. The separate synthetic PostgreSQL project remains for the next integration stage.

This is selected local interface/authentication qualification. Complete platform journeys, actual
Temporal execution/wake/replay, inherited material lifecycle, restore, provider-backed operations,
independent accessibility/usability and release/hosted acceptance remain open. The workflow check
description used compiler/provider terminology in these captures. A later source-only copy follow-up
replaces it with saved-step/rehearsal guidance; it is not included in the pictured build/checkpoint.

## Earlier bounded checks

An earlier bounded browser run passed ten cases:

- Six custom-record cases: define fields, create, edit and privately remove records with and without
  JavaScript; preserve both original version and typed draft across real conflicting writes until
  explicit reload in both modes; retain the original record draft while completing actual native MFA
  enrollment in another tab without JavaScript; require API write preconditions and deny private
  reads and unauthorized sensitivity lowering.
- Four long-profile sidebar cases: JavaScript and native forms in light and dark themes. At a
  720-pixel desktop height, the brand/account controls remain visible while navigation scrolls
  independently. Native keyboard focus reaches the final navigation item, account and sign-out
  controls. Long email text is contained. The mobile menu remains available without sideways
  overflow. The JavaScript cases also pass the existing WCAG 2.2 AA axe scan.

The first record run exposed the account-name link's undersized touch target. It now uses the shared
control height and spacing. A sidebar diagnostic then observed the correct visible child geometry
but 151 pixels of outer scroll overflow: absolutely positioned empty navigation status announcements
were escaping their links. Positioning the existing navigation links contains those announcements
inside the independently scrolling navigation. No announcement or focus control was removed.

Two record test locators were ambiguous against the actual rendered accessibility tree. The field
type uses its observed combobox role; conflict alerts are scoped to the main region and enrollment
status to its actual text. Native Next route announcements and empty pending statuses remain intact.

## Earlier failures and repairs

The 17-case run ended with ten passes, three failures and four not run. The workflow editor has a
23-pixel narrow-screen overflow and a React hydration mismatch. Its orphan removal and subsequent
save did perform the expected behavior, but the page error still fails acceptance. Workflow and
whole-interface acceptance remain open; the passing subset is not a full browser gate.

The separate account-MFA run first found an outdated empty-tenant halt fixture. The helper now keeps
its generated-company/no-agent-run assertions and invokes the real standing halt/release port, so
the database requires actual stop receipts even when there are no runs. The next run exposed that
the organization-name helper text was nested inside its label. Moving that text outside the label
preserves `aria-describedby` and gives the input the intended accessible name. Rebuilt account-MFA
acceptance is still pending. No session timestamp or assurance row was seeded.

Logs retained locally: `.local-m8-browser-record-create.log`,
`.local-m8-browser-record-map-sidebar-qualified.log`,
`.local-m8-sidebar-frame-diagnostic.log`, `.local-m8-browser-record-map-sidebar-final.log`,
`.local-m8-browser-account-mfa-first.log` and `.local-m8-browser-account-mfa-real-standing.log`.

Provider-backed SSO recovery, actual Temporal execution/wake/replay, complete lifecycle/restore,
independent accessibility review and release/hosted acceptance remain open.

## Recovery qualification history

The subsequent 50-case run stopped after **11 passes, three failures and 36 not run**, with one
additional unclassified runner error. It is not a passing whole-browser gate. Passing cases cover
all four billing/support draft-conflict modes, all four paused-owner MFA enrollment/actual expired
proof renewal modes, account identity recovery boundaries, member retention/hold denial and the
JavaScript custom-record SAML recovery journey. Each expired-proof test really waited beyond the
configured 60-second proof lifetime; no assurance timestamps were seeded.

Both lifecycle failures came from exact link-name selectors that ignored the shared destination
description in the actual accessible name. The real links were present. Positive and denied
discovery selectors now include the complete destination-name pattern. The native release-reason
selector also uses its actual combobox role; the blank-first and explicit-choice assertions remain.
All three lifecycle cases passed in the focused rerun.

The native custom-record SAML recovery failed before the generated provider page became available:
the real form's HTTP redirect was not intercepted, and the browser attempted DNS for the fake host.
Playwright routing handles the first request rather than each redirect target. The generated test
provider now uses an actual ephemeral HTTPS loopback listener, real SAML schema/signature operations
and a per-browser generated-provider selection cookie. It seeds no Ensemus account, membership,
assurance or SAML link. Only its exact live document origin/path is admitted by the browser fence;
all request events, including redirects, are checked. Teardown closes only those owned listeners.

The focused rerun passed **10 cases**: six browser guard/denial controls, all three lifecycle cases
and native custom-record SAML recovery. The existing two real XSD/signature units, all eight changed
TypeScript paths' formatting/lint, and tests/browser type scopes passed. Initial lint required a
single `let`-to-`const` cleanup in the new fixture; the full scoped rerun passed. The subsequent
**56-case** combined browser gate is running. No production guard was relaxed to obtain this result.

The production build includes the workflow SVG title/spacing, narrow details layout, account action
links, checkbox targets and billing/support label fixes. The workflow title mismatch was reproduced
against the installed React server renderer and absent in the focused development rerender; the
complete production workflow/browser qualification remains pending.

Logs: `.local-m8-browser-current-native-recovery.log`, `.local-m8-browser-native-tls-first.log`,
`.local-m8-browser-tls-source-gate-rerun.log` and `.local-m8-browser-current-tls-native-recovery.log`.
Separate diagnostic logs preserve the native SAML recovery failure without request/assertion bodies.

## Final native compatibility and workflow repairs

The real local-factor SAML journey exposed a native generator compatibility bug. The installed SDK
uses a 64-character alphabet including `-` and `_`; the bridge accepted only its 62 alphanumeric
characters. A metadata-only audit of the failing generated attempt found native MFA enabled, one
native challenge, no promoted bridge, and a true native-alphabet/false old-matcher result. No cookie,
factor secret or challenge value was printed. The new compatibility unit failed before the change;
the exact namespace/length check now accepts the real alphabet. Signed cookies, actual challenge
rows, account/provider checks and bridge consumption remain required. Focused validation passed
39 tests in three actual files; the later full unit run passed 5,614. All fourteen native SAML
browser cases subsequently passed, including actual local factor completion.

The workflow accessibility failure was reproduced on rendered nodes: the nested SVG title was
counted as a second copy of the visible label, while the accessible name contained one copy.
Removing the redundant node title preserves the complete link name, every visible label and all
connection descriptions. The original unmodified axe check passes. Native orphan repair also
needed a saved-page notice because the repaired form disappears from the postback tree. Its
explicit no-JavaScript form marker now redirects after the authorized recorded mutation; JavaScript
still receives the actual receipt and preserves other pending values and version checks.

The penultimate common run passed 56 cases and failed one generated enrollment near a real TOTP
boundary (HTTP submission began at `17:54:29.913Z`). Positive fixtures that deliberately use the
previous code now wait for the real clock boundary if fewer than five seconds remain. No production
clock, proof timestamp, replay rule or factor acceptance window changed. The final complete rerun
passed all 57 cases. The browser guard now also observes new tabs, with a deliberate-error control,
and checks redirect destinations without logging query/cookie/assertion material.
