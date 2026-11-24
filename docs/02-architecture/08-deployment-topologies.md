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

## 7. Deployment posture

Owners and administrators can open **Administration → Deployment posture**. The page and
`GET /api/v1/organizations/{organization_id}/tenancy/posture` show the recorded deployment tier,
isolation findings for the running release, and the operator's data-region declarations. Without a
profile the view starts with a shared deployment and an unconfirmed home region.

Use `infrastructure/compose/compose.residency.yaml` with the core Compose file when configuring a
home region. Set `ENSEMUS_HOME_REGION` and the path to the existing declaration JSON in
`ENSEMUS_RESIDENCY_POLICY_HOST_FILE`. The one-shot profile job runs after migration under the migrator
login. The web process and agent worker wait for it and mount the same declaration file read-only. The view withholds the overall in-region statement if the profile and configuration differ,
a surface lacks a matching declaration, or this organization's active models have outside or unknown
regions. Model endpoints and credentials are excluded from the response. Reading this view changes
no routing and makes no outbound requests.

Set the same home region and mount the same read-only policy file on the agent worker.
The worker checks tenant residency requirements before agent model calls, their retries and
fallbacks, Knowledge model calls, and connectivity checks. It rechecks requirements before
dispatch and records denials with a reason code and surface. These checks cover inference and
embeddings. The posture page also reports operator declarations for the remaining surfaces.

Under **Residency requirements**, an owner can set the home region for all data or one classification,
or remove a saved requirement. Administrators can read the requirements. Changes use the native
owner's current session, apply the deployment's administrative verification policy, and create an
audit entry. The form offers the home region when the deployment profile and web configuration agree.
The corresponding API is `GET` and `PUT /api/v1/organizations/{organization_id}/tenancy/residency-requirements`.
A requirement continues to apply until an owner removes it. An absent surface declaration or an
unknown model region blocks a covered request.

## 8. Cross-organization collaboration

On a shared deployment with federation enabled in the runtime configuration and database profile,
owners and administrators can open **Administration → Collaboration**. Each organization starts
with collaboration off. The owner uses the current session and the deployment's administrative
verification policy to turn it on. When billing is enabled, the plan must include
`federation.cross_org`.

The sharing owner defines the scope and copies the one-time invitation token to the other owner.
The recipient reviews the scope and fingerprint before accepting. The sharing owner checks the
recipient's fingerprint, then confirms the grant. Both parties can see the resulting grant.
The sharing workspace's active owners receive an Inbox item when an acceptance is awaiting
confirmation. Opening it takes the owner to the grant. If the owner has already confirmed when
the notice runs, the worker skips it. Repeated delivery never creates duplicate items. The
notice holds only a grant reference.

An owner or administrator on either side can revoke an active grant. Turning off the workspace
switch ends all open grants and records each ending in the outbox in the same transaction.
The existing tenant upkeep sweep records expirations. Offboarding ends remaining grants before
the tenant finishes winding down its work. Both use the same ending event as manual revocation.

The grant API is under `/api/v1/organizations/{organization_id}/federation`. A repeated proposal
with the same request key returns a conflict because the invitation token is issued once. The
original grant remains available in the list. The persisted request receipt contains only the
grant ID.

The bridge database operations bind one grant at a time. A delivery writes the inbound copy,
outbound state and crossing record in one transaction. Revocation and delivery share the grant
lock, and an ended grant is unreadable even before rows are removed. The receiving tenant records
arrivals with idempotent, reference-only events and Inbox items.

The worker records admission before writing an inbound file. It verifies the destination's size
and digest before delivering an item, including when a completed upload lost its response.
After withdrawal or grant closure, it removes inbound rows in bounded batches, then retains the
sender row until it can prove physical absence for every owned object. An admitted upload with
an unknown outcome keeps the reference available for recovery. If a delete loses its response,
the worker checks physical absence without repeating that request.

Workspace owners and admins can queue Work Summaries, Status Updates, and eligible Work files
for an active grant. Publishing a file records a reference and expected checksum from the
sender's artifact. The worker admits the sender snapshot before writing, and verifies that
snapshot before admitting the receiver's copy. Source deletion and publication share an
advisory lock, and a source delete withdraws queued and delivered copies in its transaction.
The Shared items page shows arrivals, their decisions, and the sender's delivery and withdrawal
states. Inbox notices resolve through the receiver's current grant before opening an item.
File downloads repeat the grant check after verifying the bytes. The API lists crossing receipts
with opaque pagination.

Compose exposes the bridge and its provisioning job through the optional `federation` profile.
The worker uses a separate internal network to reach PostgreSQL, Temporal, and object storage.
Before reporting healthy, it checks the deployment flag, the native sender and bridge logins,
the bridge grants, and object storage's ability to prove physical deletion.

Keep federation off on customer deployments until the operator's worker setup has been qualified
with live Temporal and object storage and outside security review is complete. Follow the
[container deployment runbook](../05-operations/05-container-deployment-runbook.md#cross-organization-collaboration)
to enable federation and drain it safely.
