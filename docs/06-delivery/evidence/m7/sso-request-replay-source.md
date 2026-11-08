# SAML request replay across fetch implementations — source checkpoint

Source base: root `b621e0c`, branch `codex/sso-request-replay`. The prior Account recovery checkpoint `b83185b` remains a separate preserved branch. This repair owns only the SAML guard, a dedicated regression file and this evidence; root's in-flight generated IdP/XSD/ACS/certificate helper changes and test-only validator dependencies are untouched.

## Reproduction and scope

Root's actual callback returned `400 SSO_REFUSED` after its generated assertion passed local XSD/RSA and envelope checks. Root's process-only instrumentation identified a `TypeError` inside Node's Request constructor at the guard's replay step, after body inspection. The live Next Request came from a different implementation with incompatible private state. Those instrumented observations do not qualify a clean sign-in and must not remain in acceptance runtime.

A bounded local diagnostic in this checkout used the actual installed `next/dist/compiled/@edge-runtime/primitives/fetch` Request with a fake URL and generated, non-SAML body. It confirmed the input is not a Node global Request. Passing it to `new Request(foreignRequest, {body})` threw `TypeError`; constructing from its public URL, method, header entries, bytes and signal succeeded. No HTTP, database, signature/proof mutation or provider call occurred. The diagnostic printed only case names, booleans and error class.

A second bounded diagnostic used the actual Next edge AbortController. Aborting it after reconstruction made both the source and replay signals aborted, with the same generated cancellation reason. No signal compatibility shim was necessary for the actual pinned implementation.

## Narrow repair

`guardSamlRequest` reconstructs a Node Request from the already-inspected public URL, original method, all public header entries, the exact bounded body bytes and the original compatible signal. It never passes a foreign Request or Headers object to a native constructor. Cookie/correlation, Origin, Content-Type and other original headers are retained.

The body caps, media/envelope parsing, duplicate/declaration rejection, hash and generic refusal remain unchanged. This fence still does not verify SAML signatures, audience, correlation or replay; the existing pinned verifier and admission path remain required. No permissive parsing or successful-sign-in fallback is added.

## Authored regressions and validation

`tests/unit/sso-request-replay.test.ts` uses the actual Node and pinned Next edge Request implementations, not a Request-shaped mock. It authors exact form/JSON byte and URL/method/header retention, split streamed bodies, actual foreign-signal cancellation before and after replay, declaration/duplicate/encoded-size/raw-body-size refusal, and untouched non-ACS requests. Its deliberately unsigned synthetic XML tests only the input envelope fence; it is not valid-signature or live-provider evidence.

The granted exclusive source slot completed, one heavy process at a time:

- Scoped Prettier and ESLint passed for the two changed TypeScript files.
- `pnpm exec vitest run --project unit tests/unit/sso-request-replay.test.ts packages/auth/src/sso.test.ts --maxWorkers=1`: **34 passed across two files**, including all 13 dedicated cross-implementation replay cases and the existing SSO coverage.
- Sequential `pnpm --filter @ensemus/auth typecheck` and `pnpm --filter @ensemus/tests typecheck`: **both passed**.
- `git diff --check` passed before the source checkpoint.

All commands passed on the first attempt; no install, repair or rerun was needed. The slot was explicitly released after the final typecheck. No full suite, database, build or browser command ran for this checkpoint. Root must remove instrumentation, rebuild cleanly and exercise the real callback separately. The previous actual callback failures remain open until that clean result is observed; unit transport/envelope success is not signed assertion or provider acceptance.
