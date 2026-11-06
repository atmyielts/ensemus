# Container-first runbook (reference design, not runnable product)

## Objective

Deploy exactly the same Ensemus business capabilities in SaaS Cloud, SaaS BYOM, or customer-operated Sovereign. The smallest supported unit is **two application process classes** (web and durable workers), plus required persistent infrastructure. Having one repo does not mean eliminating Temporal, database, object storage and secrets management.

## Delivery assets

`specifications/deployment/compose.reference.yaml` demonstrates topology; `specifications/deployment/Dockerfile.web.reference`, `Dockerfile.worker.reference`, `env.example`, `release-manifest.example.json`, `SOVEREIGN_OFFLINE_ACCEPTANCE.md` illustrate expected artifacts. They are non-operational templates until application code, infrastructure endpoints and build scripts exist. Do not paste secrets into Compose or check them into Git.

## Standard deployment sequence

1. Install and configure supported PostgreSQL + pgvector, Temporal server with persisted backend and an approved S3-compatible object store. Valkey runs in the stack too, but no code reads or writes it yet (ADR-025 D9), so nothing depends on it today. Provide a key-encryption key for the built-in `SecretBroker`. An external IdP, KMS or vault is optional (ADR-024 D5). Restrict DB/Temporal/object administration to private network.
2. Configure DNS/TLS/reverse proxy; restrict direct access to Next.js and internal worker ports. Set external origin, request limits and trusted proxy headers.
3. Provision runtime secret IDs and per-service DB/Temporal permissions, and the dispatcher's own object-store identity, which reaches only the `tombstone-ledger/` prefix (ADR-026). Without it, deletions still block access but pile up in the ledger backlog. Enable RLS and test non-owner/non-bypass roles; do not install with administrator DB role as app role.
4. Validate migration and version compatibility; back up before any schema mutation. Apply migration once.
5. Deploy pinned `ensemus-web` image (Next.js standalone) and `ensemus-worker` (Node/Temporal) with independent readiness/liveness checks, resource constraints and restart policies.
6. Run isolated tenant authorization, worker registration, inference policy, object store, outbox, secret-canary, and a full Work Unit integration smoke test.
7. Record image digests, license signature, configuration hash, policy version, backup success and operator approval in a local installation record.

## First owner and sign-up

Sign-up is off by default (`ENSEMUS_ALLOW_SIGNUP` is `false`), so a new install has no way for anyone to get an account until the operator makes one. This is how the first owner gets in:

1. Once the stack is up and migrations have run, issue a setup code:

   ```sh
   docker compose -f infrastructure/compose/compose.yaml run --rm --no-deps migrate node dist/setup-token.js
   ```

   It prints the code once. Only a hash of it is stored, and it is never logged.

2. Give the code to the first owner by a private route. It works once, for one account, for 24 hours. Run the command again if it is lost or runs out.
3. They open `/setup` on this deployment and enter the code with their name, email and a password. The code goes in the form, never in a URL.
4. They are signed in and asked to create their organization, where the page states who is responsible for data and models in this deployment's mode (`ENSEMUS_MODE`: `cloud`, `byom` or `sovereign`). They become its owner, and can invite people.

A code makes an account and nothing more. It gives no access to any existing organization, so a code that leaks costs an unwanted empty account, and there is no way to withdraw one before it runs out.

To let someone else in while sign-up is off, invite them from the people page and either issue them a code too, or connect OIDC (`ENSEMUS_OIDC_DISCOVERY_URL`). The invitation page links to `/setup` and returns them to the invitation afterwards. Because the product sends no mail, a password account's address is unproven, so someone who can invite still confirms them on the people page.

Set `ENSEMUS_ALLOW_SIGNUP=true` only if anyone who can reach this deployment should be able to create an account and an organization of their own. Their organizations are isolated from yours, and joining yours still takes an invitation.

## Notifications

In-app is the only channel for now. Approval requests and reminders appear in the person's inbox, and each reminder moves the item back to the top, up to three reminders a day apart. Someone who does not open Ensemus hears nothing until they do. This works the same in an air-gapped install. Email arrives with M3 (`docs/06-delivery/06-end-to-end-delivery-plan.md`), and nothing here sends any today.

## Web process

Ensure supported Node.js LTS, `next start` or standalone server, container-only filesystem for app code, upload to object store rather than local disk, health endpoint, graceful termination, no runtime dependency on Vercel. No loopback fetch from Server Components to own API routes.

## Worker processes

Temporal pollers authenticate independently to Temporal service. Agent/ingestion task queues have concurrency, retry, timeout, heartbeats and per-tenant quotas. No privilege to serve public HTTP. Worker failure should not impact web process memory/CPU beyond shared infrastructure pressure.

## Security and network flows

Ingress: HTTPS only to reverse proxy → web. Internal: web → PostgreSQL, object store and local auth; dispatcher → PostgreSQL, Temporal, and the object store's tombstone ledger alone, with its own scoped identity (ADR-026); worker → PostgreSQL, Temporal, object store and key material as policy. Valkey shares the data network and no code connects to it yet (ADR-025 D9). External egress only for approved provider/connector profiles; explicit blocked-by-default in Sovereign air gap. Do not expose object storage secrets or model API keys to browsers, traces, or generic worker job bodies.

## Outbox and stuck work

An outage of Temporal costs events no attempts, so they wait and are delivered when it returns. An event at fault itself goes dead after 12 attempts. One that keeps getting gRPC UNKNOWN or INTERNAL could be either, so it is given 288 attempts, about a day, before it goes dead the same way. The dispatcher logs each failure as an error code. Once the cause is fixed, put dead events back in the queue with `docker compose exec dispatcher node dist/redrive.js [organization-id]`, which prints a count and no content. The dispatcher also checks every tenant's reminder schedule when it starts. Each tenant's 15-minute upkeep expires overdue approvals, finishes byte deletions the object store refused, removes uploads whose row never arrived, marks work failed when Temporal says the run holding it has closed, and asks again for any plan run nothing has claimed after 5 minutes. Byte deletions that keep failing wait longer each time, up to a day, so they cannot keep others waiting.

## Backup and restore

**This is the M2 scope: the PostgreSQL database, and deleted files staying deleted.** A full backup and restore of PostgreSQL, Temporal and the object store together, with a drill, comes in M6 (`OPS-02`). Until then, restoring from these steps loses whatever was done after the backup, and Temporal may remember plan runs the restored database does not have. Nothing here is automated or scheduled, and no recovery time is promised. Why it works this way is in [ADR-026](../00-foundation/adr/ADR-026-tombstones-survive-restore.md).

In the commands below, `compose` means `docker compose -f infrastructure/compose/compose.yaml`.

### Take a backup

```sh
compose exec -T postgres pg_dump -U postgres -d ensemus -Fc -f /tmp/ensemus.dump
compose cp postgres:/tmp/ensemus.dump ./ensemus.dump
compose exec -T postgres rm /tmp/ensemus.dump
```

Keep the dump somewhere encrypted and away from this host. It holds customer data, including the names of files deleted since it was taken, until it expires. Do not back up or roll back the `tombstone-ledger/` prefix of the object store along with an older dump: it is what protects you from that dump.

### Check that deletions are reaching the ledger

```sh
compose run --rm --no-deps dispatcher node dist/ledger-backlog.js
```

This prints how many deletions have not reached the ledger (`queued`, and `dead` if any went dead) and how long the oldest has waited (`oldestSeconds`). **These are the deletions a restore could not put back if the database were lost now.** The dispatcher also logs `tombstone_ledger.backlog` every minute while any are waiting. Normally the count is zero. A store outage costs them no attempts, and they are written when it ends.

### Restore

1. Stop everything that uses the database:

   ```sh
   compose stop proxy web worker dispatcher
   ```

2. Put the dump in the container and restore it into the running database. It runs in one transaction, so a failure changes nothing:

   ```sh
   compose cp ./ensemus.dump postgres:/tmp/ensemus.dump
   compose exec -T postgres pg_restore -U postgres -d ensemus --clean --if-exists --single-transaction --exit-on-error /tmp/ensemus.dump
   compose exec -T postgres rm /tmp/ensemus.dump
   ```

3. If this release has migrations newer than the dump, apply them:

   ```sh
   compose run --rm --no-deps migrate
   ```

4. Re-apply the tombstone ledger. **Do this before anyone is let back in.**

   ```sh
   compose run --rm --no-deps worker node dist/reapply-ledger.js
   ```

   It prints counts and no names: `entries`, `tombstonesAdded`, `artifactsRemoved`, `bytesRemoved`, `organizationsMissing`, `invalid` and `failed`. It exits non-zero if `failed` or `invalid` is above zero. For `failed`, fix the cause and run it again. Access is already blocked, and running it again is always safe. For `invalid`, an object under `tombstone-ledger/` is not a valid entry, so look at it before deciding anything: that tenant stays refused until it is resolved.

5. Start everything:

   ```sh
   compose up -d
   ```

If step 4 is skipped or fails, the product protects itself: anyone in an organization whose database is behind the ledger lands on a page saying it is being restored (503), and the API answers 503 `RESTORE_PENDING`, until the re-apply succeeds. A web process left running through a restore can take up to 30 seconds to notice, which is why step 1 stops it. Other organizations are not affected.

### What this does not bring back or remove

- A deletion that was still in the backlog when the database was lost comes back as a name, usually without its bytes, so it cannot be downloaded. Someone has to delete it again. Nothing records which ones these were, so check the backlog regularly, and tell the people affected about the restore point.
- Work and files added after the backup are lost, and the bytes of those files stay in the store with nothing pointing at them, until `OPS-02`.
- The restored dump itself still holds what was deleted, until it expires.

`tests/stack/restore.test.ts` runs these steps against real containers, including the file coming back when the ledger is not re-applied.

## Upgrades and rollback

Plan runs must drain before upgrading across migration 0004 (commit 4c207fd) to any later release. A run started before `work_units.run_id` existed replays correctly and then ends without moving its work and without reporting it (`docs/02-architecture/04-work-kernel.md`). Before such an upgrade, let every plan run finish or stop it, and check that no work is `running` or `awaiting_approval` under a plan. No deployment of that code is known to exist.

`pnpm test:upgrade` is how a release proves it can take over paused work. It builds the images of an earlier commit (the merge-base with `main`, or `--from <ref>`) in a temporary worktree, opens a plan through that release's own pages until its approval is paused, upgrades to the current images with their migrations, approves, and checks that the same run reaches Checking and that a person can finish it. It runs as its own Compose project on port 18443 and removes everything it made. It refuses a base that has no stack, no page that can run a plan, or that is older than migration 0004.

Dry-run migration and replay tests in staging using production-like data/roles; back up; release compatible DB changes; deploy compatible workers and web versions; canary and verify; delay destructive schema contraction. Rollbacks can be limited by irreversible database changes and Temporal workflow history version compatibility; an operator must receive those limitations before upgrade.

## Performance and cost validation

Run reference load against web and workers separately. Profile event-loop delay, CPU/RSS, DB pool contention, Temporal task lag, model quotas, per-task cost, retrieval recall, and worker retry storms. Compare one-host and scale-out profiles. Do not claim fixed concurrent capacity without measured hardware, dataset and provider assumptions.
