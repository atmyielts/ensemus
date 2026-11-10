# Custom-record editor continuation, 2026-11-08

The native editor now starts with one field and adds fields or record connections on request, with or
without JavaScript. An add request retains entered values, unchecked choices, blank added rows and the
original request key. It performs no database mutation. Technical keys are optional advanced settings;
the native action generates bounded unique keys while the strict API parser keeps requiring explicit
keys. Saved field keys and types remain fixed.

Refused edits retain their original version and typed values. A version conflict does not silently
adopt the current database version; a person must explicitly choose the native GET reload link to
discard their draft. Identity refusal offers verification in another tab, preserving the original
form. The inline record disclosure reopens from server action state after a no-JavaScript refusal.
All equivalent controls use shared buttons, links, labels and feedback styles.

Local source gate: scoped Prettier and ESLint passed, 10 object-input units passed, and sequential
browser-test, web route generation/web types and tests types passed. The subsequent disclosure fix
also passed scoped formatting/lint and web route generation/types. Authored browser sources cover field additions and
generated keys in both JavaScript modes, retained conflict drafts through repeated saves and explicit
reload in both modes, and actual native TOTP enrollment in a separate tab followed by resubmission.
These browser journeys have not run. No build, provider, full runtime, database or hosted qualification
is claimed by this editor checkpoint.

Read-only review found an additional open case: when SSO admission becomes stale while a form is
open, the tenant loader redirects before the action can return retained form state. The late-effect
SSO refusal branch does not solve that earlier redirect. A follow-up must preserve draft input without
weakening tenant/SSO body-read authority, and prove the full no-JavaScript response as well as JavaScript.
