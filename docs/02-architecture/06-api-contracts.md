# API, Server Action and external contract design

## Interfaces

**Internal UI read:** React Server Components call server-only application services directly; there is no own-API HTTP round trip. **UI mutation:** Next.js Server Actions for ordinary user-initiated mutations, with the same domain policy checks as public APIs. **External interface:** versioned `/api/v1/*` Route Handlers for public clients, callbacks, integrations and third-party apps. **Workers:** shared TypeScript service packages / Temporal Activities, not a hidden FastAPI service.

## Public contract rules

- Cookie-based sessions for browser UI, secure token/scopes for approved API consumers; do not accept a caller-chosen tenant without verifying membership.
- Runtime Zod validation at every boundary; stable typed DTOs; data-minimized serialization and explicit response filtering.
- Pagination, request ID, idempotency key, error code and documented rate-limit responses on relevant endpoints.
- `POST /work-units` commits state/outbox and returns `202` for asynchronous activities with a resource URL. Never wait for a large model task to finish in the business mutation request.
- `GET /work-units/{id}` and authorized status subscriptions expose durable status, timestamps, outcomes, reasons and evidence; raw internal model chain-of-thought is not exposed.
- `POST /approvals/{id}/decision` validates actor, exact action payload hash, policy version and review state; no stale approvals.
- Webhook receivers verify signatures, timestamps, payload limits, replay prevention and canonical mapping.
- OpenAPI 3.1 is the public REST contract. Server Actions are private frontend interfaces and still require validation/authorization.

## Consistency

Business mutation response means *committed*, not necessarily *externally executed*. Async execution is separate. Expose clear `queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `outcome_unverified` statuses; don't fabricate completion based on tool intent. External API calls are idempotent where possible.

## Versioning

Additive `/api/v1` changes permitted; breaking changes require `/api/v2`, migration docs and deprecation periods. Events include `schema_version`; consumers reject unknown major versions. Agents/tools have versioned contracts and explicit compatibility matrices. Sovereign updates must respect long-lived installed releases.

## Documentation

See `specifications/openapi.yaml` for a **representative contract**, not a claim that implementation exists. TypeScript packages should generate/validate matching runtime schemas, and CI must detect drift between OpenAPI, Zod contracts and request handlers.
