# Product browser checkpoint, 2026-11-08

The isolated HTTPS preview uses a clean normal production standalone build, the actual native auth
and application roles, and the disposable 67-migration database. Diagnostic preloads are absent.
All companies, users, records and provider material are generated test fixtures. Original platform
databases and unrelated Docker resources are unchanged.

## Passing scope

The current joined browser run passed ten cases:

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

## Open findings

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
