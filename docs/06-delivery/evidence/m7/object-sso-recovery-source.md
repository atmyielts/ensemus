# Custom editor company-sign-in recovery — source checkpoint

Scope: M7 custom records / KNOW-07, native interface behavior. This follow-up addresses company sign-in becoming required after an object form was opened. It adds no SQL, admission exception, session authority, provider credential or API/OAS operation.

## Mechanism

- The normal workspace layout and ordinary `requireTenant` SSO redirect remain strict. A typed `requireTenantForAction` performs the same native identity, active tenant membership, restore and SSO checks, returning no context on refusal. Only the SSO redirect changes to a typed refusal for the editor's submitted-only response.
- Existing type/record form components use the same actual module action, `useActionState` hook and explicit `/object-editor/[organizationId]/[mode]/[editorId]` permalink on the original and recovery pages. The isolated recovery page is outside the admitted workspace layout. Its route/query carry only validated UUIDs and fixed modes, never draft bodies.
- Denied SSO rendering does not call record/type/schema readers. It renders the same hook in a hold state. Only the current action's allowlisted submitted values may be shown, with explicit another-tab company sign-in and a native retry. A denied no-state GET has no invented editor, private body, saved schema or retry payload. Missing/foreign/revoked membership retains the existing not-found path.
- On successful fresh admission, the recovery page reads the actual current record/type/shape and renders the real editor. Action-returned values retain their original expected version and IDs; reading a newer source does not silently adopt its version. A stale retry refuses until explicit reload.
- `intent` is allowlisted to `save`, `add-field` or `add-relation`. An SSO-blocked Add request retries that same Add request, never an unintended Save. Blank additions, request UUID and original field values remain in the submitted state.
- Refusal values use a plain safe-key object, preserving root's React Flight serialization correction. No local storage, cookie draft, new database draft store, or module-level private-value cache is introduced.

## Pinned runtime source inspection

The installed React server renderer uses `p + permalink` as its postback key when an explicit permalink exists, and checks the actual action signature before restoring state (`react-dom-server.node.development.js`, `createPostbackActionStateKey` / `useActionState`). The installed Next action handler skips page rendering for fetch actions that did not revalidate; native multipart actions decode the form state and render their permalink page. This inspection supports the mechanism; it is not a browser acceptance result.

## Authored coverage

- Four new pure cases cover all four editor/request permalink identities, no invented create nonce, exact submission scope matching, safe plain-object values, original version, valid Add intents and unknown-intent refusal.
- Five new browser journeys in `tests/browser/specs/object-sso-recovery.spec.ts` use the existing generated SAML provider fixture and actual HTTP/native forms. They cover JavaScript and no-JavaScript member record writes when the owner enables SSO after opening, no-state/foreign recovery GETs, actual company sign-in in a second tab, stale native expected version, and JavaScript/no-JavaScript Add connection retries followed by real type creation. Only the exact generated IdP navigation is fulfilled locally; no hosted provider is qualified.

## Executed source checks

Based on root source checkpoint `6dd2ee0` on `codex/m7-object-sso-drafts`:

| Command / scope | Result |
| --- | --- |
| `node node_modules/prettier/bin/prettier.cjs --write` for the 10 changed TypeScript/TSX files | Passed |
| `node node_modules/eslint/bin/eslint.js --max-warnings 0` for the same 10 files | Passed |
| `pnpm exec vitest run tests/unit/web-object-input.test.ts --maxWorkers=1` | 14 passed in 1 file, including 4 new recovery cases |
| `pnpm exec tsc --noEmit -p tests/browser/tsconfig.json` | Passed |
| `pnpm --filter @ensemus/tests typecheck` | Passed |
| `pnpm --filter @ensemus/web typecheck` | Route generation and TypeScript passed |

The serialized slot was released after the final type command. No installation, database, Docker, build, browser execution or live provider operation was performed for this follow-up. All five new browser journeys remain unrun. Native postback recovery and actual provider-policy races are not yet qualified.

## Required integration and remaining gates

Root's newer tenant resolver adds SaaS standing after native/member/restore/SSO admission. Semantic composition must retain its `resolveFor(org, surface)`, core standing assertion, account wrapper and suspended-tenant redirect, adding only the typed SSO mode for the new action helper. This source base predates those standing changes and must not overwrite them.

No Cloud/BYOM/Sovereign runtime result is claimed. The recovery path adds no external dependency; actual sign-in continues to use the configured existing provider. Run the authored generated-provider journeys against the joined built app, and retain real provider/operator qualification as a separate gate.
