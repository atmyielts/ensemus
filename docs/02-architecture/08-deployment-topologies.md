# Deployment topologies and installation profiles — one release, three modes

## 1. Packaging rule

**One repository, common contracts, shared image release, multiple processes.** The deployable application has `web` (Next.js Node server) and separate worker processes (`workflow-worker`, `ingestion-worker`, `event-dispatcher`; small deployments may combine worker roles **into one worker container** without combining them with web). Supporting services include PostgreSQL+pgvector, Temporal service and persistence, Valkey, S3-compatible storage, TLS proxy, and minimal health telemetry. Identity and secrets are built in (ADR-024 D5), with an external identity provider and KMS or vault as options.

Next.js Docker/Node deployment is first-class. Avoid features that require Vercel or any hosted vendor to make core work. Images must be reproducible and signed; ship image digests, SBOM, license notices, migration metadata and restore instructions.

## 2. Profiles and responsibility

| Aspect | Cloud: subscription with AI | BYOM: platform subscription | Sovereign: perpetual + optional maintenance |
|---|---|---|---|
| Web/workers | Ensemus-hosted | Ensemus-hosted | Customer-hosted |
| PostgreSQL, Temporal, storage | Ensemus operated | Ensemus operated | Customer operated |
| Models and inference | Ensemus-managed approved provider accounts / metered allowance | Customer-approved keys/endpoints billed by model provider | Customer-approved keys/private models |
| Customer data access | Scoped Ensemus operations under agreement | Same SaaS trust boundary; BYOM does **not** imply privacy from Ensemus hosting | Local operators control runtime, secrets, backups and access |
| Activation | Online entitlement system | Online entitlement system | Signed offline perpetual license; **no heartbeat** |
| Cloud telemetry | Restricted and redacted | Restricted and redacted | Default local only; diagnostic exports opt-in |
| Maintenance | Included in ongoing SaaS | Included in ongoing SaaS | Separate optional support/update contract |

Cloud includes disclosed AI allowance, not unlimited free inference. BYOM does not automatically mean that arbitrary internal endpoints are reachable; use allowlisted/validated routing with approved connectivity. Sovereign customers pay their own infrastructure and models. Both terms and software export must be reviewed legally.

## 3. Small production installation (single host)

- Reverse proxy terminates TLS and forwards to one Next.js container.
- A distinct Node worker container polls Temporal and runs bounded agent Activities.
- A small event-dispatcher and ingestion process can run in that worker container at first; separate only after contention is measured.
- PostgreSQL, Temporal and object storage may be managed services in Cloud; Sovereign runs approved local equivalents.
- Valkey is cache/rate-limit utility, **not** the only durable queue or approval store.
- No `.env` containing secrets in source control, image layers or public bug bundles. Mount customer secrets from host vault or secret runtime facility.
- Limit network egress: web to DB/objects/auth/Valkey, with no path to Temporal (ADR-024 D3); workers to explicitly permitted connectors/providers; database and Temporal endpoints not exposed publicly.

## 4. Scaling

Scale stateless web replicas separately from Temporal task-queue workers. Keep Next.js deployment identities and any cross-instance cache coordination consistent; avoid globally caching per-tenant sensitive output. Partition task queues by latency/class (interactive, connector I/O, bulk processing) when benchmarks show contention. Autoscaling queues without provider rate-budget controls only moves the bottleneck.

## 5. Sovereign and air-gap

For offline sites, every necessary dependency is local: identity, license verifier, DB, pgvector, Temporal, object store, model inference, storage for keys, and audit/monitoring. Disable all external error reporting, analytics, update checks, font/CDN fetches, image optimizers that proxy to internet, and dependency downloads at runtime. Prove zero unsolicited egress in an isolated acceptance environment.

The customer can continue using the purchased version after maintenance expires. Upgrade rights, bug-fix eligibility and supported release branches follow a separately negotiated maintenance contract. The binary/license must **not** deliberately stop working when support ends.

## 6. Deployment lifecycle

1. Verify release signatures/SBOM, license, database compatibility, free disk and encrypted backups.
2. Preflight inbound/outbound networking and provider/secret policies.
3. Run reviewed SQL migrations via one migration job, never concurrently from every web replica.
4. Deploy compatible workers before/after API according to the workflow-version compatibility plan; use expansion/contraction for schemas.
5. Health-check TLS, authentication, RLS, outbox dispatch, Temporal worker polling, model policy and object read/write.
6. Run smoke tests on all three modes; offline install includes egress-denial test.
7. Publish operator release notes, rollback caveats, hashes and verified test results.

See `05-operations/05-container-deployment-runbook.md`, `specifications/deployment/`, and `07-commercial/01-license-and-maintenance.md`.
