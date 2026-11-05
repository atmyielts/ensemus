# Next.js / Node / supply-chain-specific threat controls

## Threat surface

React Server Components serialize data to browser boundaries; Server Actions are externally callable mutation surfaces; Route Handlers are public HTTP endpoints; workers can read secrets and initiate model/tool egress; image and asset components may contact external origins depending on configuration; supply-chain build steps can access environment variables and package scripts.

## Mandatory controls

1. Use `server-only` and import-boundary tests for DB, vault, OIDC secrets, model adapters, admin policies and privileged query modules. No secret in `NEXT_PUBLIC_*` or client serialized props.
2. Verify session and resource-level authorization on every Server Action, Route Handler, RSC data query and worker action. Middleware/proxy can accelerate redirects but isn't the authority.
3. Enforce CSRF-safe mutation patterns, SameSite/Secure/HttpOnly cookies, origin checks, input/output size limits, safe content-type checks, and secure OIDC state/PKCE flows.
4. Disable cached private payloads in shared CDN; request/tenant-scoped cache only after formal ACL key and revocation design. Test multi-instance Next.js cache behavior.
5. Authenticate SSE/realtime subscriptions and scope event filters by membership and resource permission. RLS applies to status/materialized views too.
6. Constrain Node VM/sandbox: no `eval` or arbitrary dynamic imports for customer tool scripts in application server. Run custom scripts outside web process with network/FS/CPU limits.
7. Treat package scripts and build chain as supply-chain risk: pinned lockfile, reviewed dependency updates, npm provenance where available, SBOM/signatures, strict CI secret scopes.
8. Scrub console logs, Next.js error reporting, model SDK callbacks, instrumentation, network traces and exception tracking. No raw customer secrets, documents, full prompts or provider responses by default.
9. Harden production containers: non-root user, readonly root FS when viable, minimized Linux capabilities, memory/CPU constraints, no public DB ports, mutual auth/internal TLS where appropriate.
10. Sovereign offline profile forbids remote analytics, fonts/CDNs, license validation, update fetch, image-optimization proxy and unnecessary DNS. Enforce with egress firewall, not only config flags.

## Required negative tests

Secret value in `process.env` does not appear in client JS or RSC payload; denied user cannot call Server Action by ID; admin-only handler rejects normal member; cached project cannot be read after membership removal; tenant A cannot subscribe to tenant B work stream; attacker-controlled tool URL cannot reach metadata IP; raw confidential prompt cannot reach unapproved provider even after fallback; worker crash doesn't expose credentials in error output.

## Worker and provider secrets

Secrets are vault-resolved immediately before authorized action, scoped by tenant/connection/profile. Workers should never save secret material in Temporal workflow history, prompt, tool result or business event. Use short-lived lease/refresh; cancel/revoke promptly. Provider allowlists apply to embeddings, transcription, OCR, eval and rerank as well as generation.

## Security acceptance

Run malicious document prompt-injection suite, multi-tenant RLS and cache isolation tests, production-like role tests, build artifact scan for canaries, code/dependency scans, penetration review, crash/failure drills, and supervised Sovereign air-gap egress capture. Security claims require evidence; docs alone are not certification.
