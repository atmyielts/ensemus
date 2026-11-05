# External technical references and verification ledger

These are reference links for an architectural proposal, not evidence of production deployment, certifications or fixed provider prices. Revalidate version compatibility and license terms at implementation and procurement.

## Framework, deployment and contracts

- Next.js official — [Self-hosting guide](https://nextjs.org/docs/app/guides/self-hosting): reverse proxy, multi-instance cache coordination and runtime concerns.
- Next.js official — [Backend-for-Frontend guide](https://nextjs.org/docs/app/guides/backend-for-frontend): Route Handler limits, Server Actions, direct Server Component data access, serverless caveats.
- Next.js official — [Deployment options](https://nextjs.org/docs/app/getting-started/deploying): Node/Docker and standalone output.
- Drizzle ORM — [PostgreSQL Row Level Security](https://orm.drizzle.team/docs/rls): policy representation and role configuration; test on actual DB role/pool.
- PostgreSQL — [Row-Level Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): role bypass exceptions, policy semantics.
- PostgreSQL — [Recursive queries](https://www.postgresql.org/docs/current/queries-with.html): graph/path operations.
- pgvector — [README](https://github.com/pgvector/pgvector): approximate ANN filtering, indexing and recall tradeoffs.
- Docker — [Compose production guidance](https://docs.docker.com/compose/how-tos/production/): production overrides and deployment lifecycle.

## Execution, models and interoperability

- Temporal — [TypeScript SDK](https://docs.temporal.io/develop/typescript): workflows, activities, workers, scheduling and versioning.
- AI SDK — [Provider and Model Management](https://ai-sdk.dev/docs/ai-sdk-core/provider-management): registry and custom providers; does not replace Ensemus egress policy.
- Model Context Protocol — [Specification](https://modelcontextprotocol.io/specification/): tool/resource interoperability; review server trust and authorization.
- OpenTelemetry — [Documentation](https://opentelemetry.io/docs/): distributed trace/metric instrumentation with payload redaction.
- OWASP — [LLM Applications security guidance](https://owasp.org/www-project-top-10-for-large-language-model-applications/): prompt injection, unauthorized tool use, sensitive disclosure risks.

## Deployment/OSS legal due diligence

- Temporal licensing and hosting, Next.js/Drizzle/AI SDK/Valkey/PostgreSQL/pgvector license files, third-party model weights, container distribution and binary dependencies need a release-specific license/SBOM review. Avoid treating this reference file as legal advice or a permanent guarantee of current prices/licensing.

## Source status

Official framework documentation checked 2026-11-05 for the stack rebaseline. Prices are not hardcoded in this suite; vendors may change them. Product targets and commercial conditions remain proposals unless expressly approved as contracts.
