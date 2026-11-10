# Account discovery and form recovery — source checkpoint

Source base: root `7ed2693`, branch `codex/account-ux`. Prior Account identity and SAML transport checkpoints remain preserved separately. This addresses the three remaining concrete P2 findings from the Account source audit, using the shared interface system.

## Source behavior

- The existing Account `DestinationList` now exposes **Data retention** to actual `retention.manage` roles and **Legal holds** to actual `legal_hold.manage` roles. Owners can find the first hold without already having an active hold; administrators can reach retention without being shown owner-only holds. Pages continue to authorize independently. No navigation destination, role grant, sidebar or global style is invented.
- The shared Account action notice offers **Reload and discard my draft** on `VERSION_CONFLICT`, using the existing plain-GET `ReloadLink`. It explains that current details remain unsaved, retry still uses the original version, and reloading discards those details. Billing and support action-state handlers, values and versions remain unchanged; there is no automatic rebase, merge, reload or persisted browser draft.
- Offboarding cancellation and hold release use one shared native, required reason selector. Both start at an empty **Choose a reason** option. The explicit plain-language customer request maps to existing valid `CUSTOMER_REQUEST` audit code. No new legal reason, default legal assertion, audit payload, server policy or API contract is introduced. The existing consequence checkbox and fresh server authorization/version checks remain required.

## Authored regression source

- Existing destination unit cases cover owner/admin/member/unknown role routes and now validate the actual reason values against the existing cancellation/release schemas, including empty-code refusal.
- Four new actual browser cases use two real editing tabs to create billing and support conflicts, with and without JavaScript. They retain the submitted draft and exact original version through repeated refusal, then require an explicit reload/discard before showing the other tab's committed version. No version field is forged and no DAL or success state is mocked.
- Existing native lifecycle journeys now discover retention and legal holds from Account and assert the reason selector is initially empty before explicitly choosing it. The member denial remains; an added administrator journey discovers retention and remains denied owner-only holds. Existing native offboarding cancellation selects its explicit plain-language reason.

## Actual validation

Source authored only. No formatting, lint, unit, type, database, build or browser command has run for this checkpoint; root currently owns the heavy validation slot. All new/updated browser journeys remain unrun. Source UI and test definitions do not qualify current rendered behavior, actual lifecycle effects or a deployment.

No application service, API handler, admission rule, migration, schema, core navigation/CSS, M6 inventory/cursor or SAML fixture/dependency file is changed.
