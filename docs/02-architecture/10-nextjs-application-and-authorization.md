# Next.js App Router: server boundary, rendering and security

## Runtime contract

`apps/web` is a **Node.js** Next.js App Router application exposing all user-facing web UI and public API endpoints. The server runtime uses framework-independent domain packages. A Next.js request must never be the durability boundary for multi-step autonomous work.

| Interface | Use | Forbidden patterns |
|---|---|---|
| React Server Component | Authorized initial data load and composition | HTTP fetch to own Route Handler; leaking secrets in serialized props |
| Server Action | User-initiated, CSRF-protected state mutation; workflow starts go through the outbox | Long-running agent work; trusting hidden form fields for tenant/role |
| Route Handler | Versioned public APIs, integration callbacks, short streaming, webhooks | Unbounded job loops; unauthenticated connector side effects |
| Client Component | Interaction, local state, accessible visual workflows | Secret access, direct DB access, policy decisions |
| Proxy / middleware | Coarse redirects and request hygiene | Sole authorization protection |

**Enforce `server-only`** for DB, auth, model registry, secret vault and privileged domain modules. Run static checks to block imports into client bundles and tests that inspect built output for sensitive environment variable values. `NEXT_PUBLIC_` is public; its values must be safe to disclose.

## Server-side request flow

`HTTP → session/OIDC verify → actor + tenant context (resolved server-side) → input schema parse → domain application service → policy + scoped transaction → DTO serializer → response`.

Authorization is repeated by workers executing on behalf of a principal or service identity; downstream services don't trust a promise that the initiating web route already checked. Request contexts are explicit function parameters, never mutable process globals.

Bind tenant context with `set_config('app.organization_id', $1, true)` inside the same PostgreSQL transaction as the query or command. It is transaction-local like `SET LOCAL`, but takes a bind parameter, which `SET LOCAL` cannot; pool connections must not leak tenant state across requests. Test RLS with the actual runtime role (not owner/superuser). ABAC additionally gates document, project and delegated service permissions. Deny-by-default applies to all external operations.

## Caching and rendering

- Any response depending on tenant, membership, ACL, or confidential business data is dynamic unless a proven authorization-aware cache key and invalidation policy exist.
- Never use a global React/Next `cache` or CDN cache for tenant-sensitive values without request and authorization scoping.
- Multi-replica cache invalidation must be coordinated; do not assume one instance revalidating a tag updates all others.
- No remote runtime font/image fetches for Sovereign offline pages; ship local assets.
- Read queries should use server-side direct calls; do not create HTTP loopbacks that add latency and bypass internal auth context.
- For live progress, prefer authenticated SSE with reconnect/read-model semantics; not every progress event needs a persistent socket.

## Not found without JavaScript

Every page keeps working with scripts off, a 404 included. In Next.js 16.4.5, a page that calls `notFound()` (directly, or through `orNotFound` and the tenant check) is answered with a real 404 whose document is an empty error shell, `<html id="__next_error__">` with an empty `<body>`: no layout or `not-found.tsx` is rendered on the server, because React cannot catch the error on the server, and client JavaScript renders the not-found page into the shell. A browser without JavaScript was shown a blank page (review finding F13). Next.js has no way for a page to keep the 404 and render its own markup: a status set by `notFound()` is the only status a page can set, and anything a page renders instead is a 200.

So the container entrypoint (`apps/web/start.mjs`) installs `apps/web/no-script-not-found.mjs` before the standalone server makes its HTTP server. For a 404 `text/html` response whose document is that exact shell, and nothing else (its opening `<html>` tag carries `id="__next_error__"`; in a built image Next.js writes `data-dpl-id` before it, because every image build sets `ENSEMUS_RELEASE`, which `next.config.ts` makes the deployment ID, so the id is matched wherever it stands among that tag's attributes; matching only `<html id="__next_error__"` missed every shell an image sent, which the scripts-off browser specs found in CI round 8), it holds the body (decoding the compression Next.js applied), writes a `<noscript>` copy of the root not-found page straight after `<body>`, adds `lang="en"`, and sends it uncompressed with its true length. The status and all other headers are unchanged. With scripts on the `<noscript>` is inert and Next.js renders the segment's not-found page exactly as before. Every other response, including streaming pages, event streams, RSC payloads and the real 404 page for an unmatched address, passes straight through from its first byte; a held body that comes to more than 1 MiB is passed on untouched. The words are held to `app/not-found.tsx` by `tests/unit/no-script-not-found.test.ts`; `tests/browser/specs/assistants.spec.ts` and `experience.spec.ts` hold the result with scripts off. `next dev` does not use the entrypoint, so this applies to the built image only. Remove it once Next.js renders the not-found boundary on the server.

## HTTP/API safety

Validate request type, size, JSON shape, path parameters and uploads; rate limit expensive routes per actor and tenant. OAuth callbacks check state/PKCE, webhooks verify signatures and dedupe before updating state. Timeouts and circuit breakers protect external calls. Return sanitized error objects, no raw stack traces, provider responses, or secret values.

## Build and deployment caveats

Use `output: 'standalone'` for compact image output and verify all monorepo dependency tracing. Build once per release; supply environment-specific secrets only at runtime. Do not use static-export mode for this application. Audit Node version compatibility and lockfile in CI; test multi-instance behavior, cache consistency and upgrades across versions.
