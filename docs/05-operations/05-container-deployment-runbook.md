# Container-first runbook (reference design, not runnable product)

## Objective

Deploy exactly the same Ensemus business capabilities in SaaS Cloud, SaaS BYOM, or customer-operated Sovereign. The smallest supported unit is **two application process classes** (web and durable workers), plus required persistent infrastructure. Having one repo does not mean eliminating Temporal, database, object storage and secrets management.

## Delivery assets

`specifications/deployment/compose.reference.yaml` demonstrates topology; `specifications/deployment/Dockerfile.web.reference`, `Dockerfile.worker.reference`, `env.example`, `release-manifest.example.json`, `SOVEREIGN_OFFLINE_ACCEPTANCE.md` illustrate expected artifacts. They are non-operational templates until application code, infrastructure endpoints and build scripts exist. Do not paste secrets into Compose or check them into Git.

## Standard deployment sequence

1. Install and configure supported PostgreSQL + pgvector, Temporal server with persisted backend and an approved S3-compatible object store. Valkey runs in the stack too, but no code reads or writes it yet (ADR-025 D9), so nothing depends on it today. Provide a key-encryption key for the built-in `SecretBroker`. An external IdP, KMS or vault is optional (ADR-024 D5). Restrict DB/Temporal/object administration to private network.
2. Configure DNS/TLS/reverse proxy; restrict direct access to Next.js and internal worker ports. Set external origin, request limits and trusted proxy headers (see [Hostname and client addresses](#hostname-and-client-addresses)).
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

To let someone else in while sign-up is off, invite them from the people page and either issue them a code too, or connect OIDC (`ENSEMUS_OIDC_DISCOVERY_URL`). The invitation page links to `/setup` and returns them to the invitation afterwards. Because the product sends no account or notification mail, a password account's address is unproven, so someone who can invite still confirms them on the people page.

Set `ENSEMUS_ALLOW_SIGNUP=true` only if anyone who can reach this deployment should be able to create an account and an organization of their own. Their organizations are isolated from yours, and joining yours still takes an invitation.

## Notifications

In-app is the only channel for now. Approval requests and reminders appear in the person's inbox, and each reminder moves the item back to the top, up to three reminders a day apart. Someone who does not open Ensemus hears nothing until they do. This works the same in an air-gapped install. Notification email is not built, and has consent questions of its own. What M3 adds is different: outbound email as an action someone approves, and only with the connectors profile on (see [Connectors and outbound actions](#connectors-and-outbound-actions)). No approval request or reminder goes by email.

## Web process

Ensure supported Node.js LTS, `next start` or standalone server, container-only filesystem for app code, upload to object store rather than local disk, health endpoint, graceful termination, no runtime dependency on Vercel. No loopback fetch from Server Components to own API routes.

## Worker processes

Temporal pollers authenticate independently to Temporal service. Agent/ingestion task queues have concurrency, retry, timeout, heartbeats and per-tenant quotas. No privilege to serve public HTTP. Worker failure should not impact web process memory/CPU beyond shared infrastructure pressure.

## Security and network flows

Ingress: HTTPS only to reverse proxy → web. Internal: web → PostgreSQL, object store and local auth; dispatcher → PostgreSQL, Temporal, and the object store's tombstone ledger alone, with its own scoped identity (ADR-026); worker → PostgreSQL, Temporal, object store and key material as policy. Valkey shares the data network and no code connects to it yet (ADR-025 D9). With the connectors profile on: connector worker → PostgreSQL, Temporal and the egress gateway, on an internal network with no route out; egress gateway → the one relay an operator named, holding no secret. External egress only for approved provider/connector profiles; explicit blocked-by-default in Sovereign air gap. Do not expose object storage secrets or model API keys to browsers, traces, or generic worker job bodies.

Internal service names are pinned to fixed addresses in `compose.yaml`. Docker forwards the name of a stopped container to the host resolver, so without the pins an outage would send internal names off the network. The default range is `172.30.0.0/16`. If your site already uses it, set `ENSEMUS_NETWORK_PREFIX` (for example `172.29`) before the first start; changing it later recreates the networks. The air-gap gate stops each service in turn and fails on any lookup that leaves. It also fails if requests through the proxy to either web replica do not get the answer that outage should give, or if the running stack is not on the watched range. Valkey has no client yet, so its round only shows that nothing else breaks.

**Scaling web.** Because `web` has a fixed address, `docker compose up --scale web=2` does not work on the shipped `compose.yaml`: the second container asks for the address the first holds and fails to start. There is no shipped way to run more web replicas today. To add one, define it as a service of its own with its own address on the `edge` network, pin that name in `proxy`, and add it to the upstreams in `proxy/Caddyfile`. `web-2` in `compose.test.yaml` is the working example of the service and its pin, and `proxy/Caddyfile.test` routes to it, for tests only. The deployed `Caddyfile` knows one upstream, so a replica you add gets no traffic until you change it.

## Hostname and client addresses

**`ENSEMUS_HOSTNAME`** is the one name the proxy answers to. It defaults to `localhost`, and a request for any other name fails at the TLS handshake, so a real deployment has to set it. Give the name alone, with no scheme or port, and use the same name in `ENSEMUS_PUBLIC_URL`, which also carries the port people use. The certificate comes from the proxy's own local authority (`tls internal`) and nothing is requested from outside, so whatever connects has to trust that authority. Its root is `/data/caddy/pki/authorities/local/root.crt` in the `proxy` container.

**`ENSEMUS_TRUSTED_PROXIES`** says who may state a client's address. Sign-in is limited to 10 attempts a minute and sign-up to 5, for each client address, so what the proxy tells the app decides who shares an allowance. It takes addresses or CIDR ranges separated by spaces, and it defaults to empty.

- **Clients connect directly to this proxy:** leave it empty. Any `X-Forwarded-For` a client sends is overwritten with the address of its connection, so a client cannot forge an address, and each address has its own allowance.
- **A host-level reverse proxy or load balancer of yours is in front, and this is empty:** forged addresses are still overwritten, but every person now has your proxy's address and they all share one allowance. **Ten wrong passwords from anyone refuse sign-in for everyone for up to a minute.** Nothing warns you when this happens.
- **Your proxy is in front, and this names it:** for a connection from a listed address, the proxy reads `X-Forwarded-For` from the right, passes over listed addresses, and tells the app the first address that is not listed. A connection from anywhere else is treated as a direct client, and what it claims is overwritten.

When you set it:

- **Your proxy must add the address it received the connection from, to the right of `X-Forwarded-For`, or replace the header with that address.** In nginx that is `$proxy_add_x_forwarded_for` or `$remote_addr`. A proxy that passes on the client's own header unchanged lets every client choose its address, so it can escape the limit or use up someone else's allowance.
- **List only proxies you operate, and let only them reach the published port** (`ENSEMUS_BIND_ADDRESS`, `ENSEMUS_HTTPS_PORT`). Anyone who can connect from a listed address can state any client address. A wide range such as `private_ranges` also trusts every ordinary user on that range.
- **List the address this proxy sees, which may not be the one your proxy has.** Through a port published on the same host, it is normally Docker's gateway on the `edge` network, and not `127.0.0.1`. Do not guess: while your proxy is carrying traffic, the foreign address on port 443 in `docker compose -f infrastructure/compose/compose.yaml exec proxy netstat -tn` is the one to list.
- **Send `ENSEMUS_HOSTNAME` from your proxy as both the TLS server name and the `Host` header.** A listed proxy's `X-Forwarded-Host` and `X-Forwarded-Proto` are passed on to the app as well, so have it set those to the public values.
- A value the proxy cannot read stops it from starting, so a mistake here shows at the next `up` and does not widen who is trusted.

`node infrastructure/scripts/check-proxy.mjs` runs the deployed `Caddyfile` in containers with no network and proves what this proxy does with both settings and with a forged address, whether or not the connection is listed. It cannot prove what your own proxy does. It runs in CI.

## Outbox and stuck work

An outage of Temporal costs events no attempts, so they wait and are delivered when it returns. An event at fault itself goes dead after 12 attempts. One that keeps getting gRPC UNKNOWN or INTERNAL could be either, so it is given 288 attempts, about a day, before it goes dead the same way. The dispatcher logs each failure as an error code. Once the cause is fixed, put dead events back in the queue with `docker compose exec dispatcher node dist/redrive.js [organization-id]`, which prints a count and no content. The dispatcher also checks every tenant's reminder schedule when it starts. Each tenant's 15-minute upkeep expires overdue approvals, finishes byte deletions the object store refused, removes uploads whose row never arrived, marks work failed when Temporal says the run holding it has closed, and asks again for any plan run nothing has claimed after 5 minutes. Byte deletions that keep failing wait longer each time, up to a day, so they cannot keep others waiting.

## Connectors and outbound actions

**Off by default, and no install needs it.** With no profile there is no connector worker and no gateway, the stack makes no outbound attempt, the web tier refuses to create a connection, and the webhook route answers 404. Why it is built this way is in [ADR-027](../00-foundation/adr/ADR-027-verified-external-actions.md). **That ADR needs an outside security review before any real credential is stored.** Until then, use generated test values against a test relay only. No real provider has been used.

### Turning it on

Set these in the environment Compose reads, and start the stack with the profile:

| Setting | What it does |
|---|---|
| `COMPOSE_PROFILES=connectors`, or `--profile connectors` | Starts `connector-worker`, `egress-gateway` and the four provider-route gateways below. Use it on every Compose command, because a command without it does not see those services |
| `ENSEMUS_CONNECTORS_ENABLED=true` | Lets `web` create connections and answer the webhook route. Leave it false unless the worker is running, so that no row waits for a worker that is not coming |
| `ENSEMUS_EGRESS_TARGET=host:port` | The one relay the gateway forwards to. The gateway refuses to start without it, and it is the only way out of the stack |
| `ENSEMUS_SMTP_TLS` | Anything but `none` means TLS is required, and a relay that does not offer it is refused rather than used in the clear. Set `none` only for a relay on a trusted site network. The test overlay is the only place in this repository that sets it |
| `ENSEMUS_SMTP_MESSAGE_ID_DOMAIN` | The domain in each Message-ID, `<{action id}@{domain}>`. It is what someone searches the relay's log for |

**Who can reach what.** `connector-worker` holds the credentials and sits on the `connectors` network alone, which is internal, so it reaches PostgreSQL, Temporal and the gateway and nothing else. `egress-gateway` holds no secrets and is on `connectors` and `outbound`. `web` is on neither. On a Sovereign site, make the target an on-site relay, and have the site's firewall limit `outbound` to it. An air-gapped install with no relay runs no profile.

**Turning it off.** Remove the profile and set `ENSEMUS_CONNECTORS_ENABLED` back to false. Unsent actions stay `ready`, and they wait until it is on again. Nothing goes out.

### Google Workspace and Microsoft 365

An admin connects these by consent, from the connections page ([ADR-038](../00-foundation/adr/ADR-038-workspace-suites.md)). **That ADR, and migrations `0560` to `0562`, need an outside security review before any real Google or Microsoft account, client or token is used.** Until then, use generated values against local fakes only. The profile also starts one gateway per provider route, and each works like `egress-gateway`: no secret, no database, one target, ciphertext only.

| Setting | Read by | What it does |
|---|---|---|
| `ENSEMUS_EGRESS_GOOGLE_API_TARGET`, `ENSEMUS_EGRESS_GOOGLE_OAUTH_TARGET` | `egress-google-api`, `egress-google-oauth` | `www.googleapis.com:443` and `oauth2.googleapis.com:443`, or a site relay to each. Empty means that gateway does not start, and requests on its route fail with a code |
| `ENSEMUS_EGRESS_MS_GRAPH_TARGET`, `ENSEMUS_EGRESS_MS_LOGIN_TARGET` | `egress-ms-graph`, `egress-ms-login` | `graph.microsoft.com:443` and `login.microsoftonline.com:443`, or a site relay to each. The same rule |
| `ENSEMUS_GOOGLE_CLIENT_ID`, `ENSEMUS_MICROSOFT_CLIENT_ID` | `web`, `connector-worker` | Your own app's public client ID for each provider. Empty by default, and then admins can only connect with an app of their own. Compose hands the same value to the worker as `ENSEMUS_OAUTH_GOOGLE_CLIENT_ID` and `ENSEMUS_OAUTH_MICROSOFT_CLIENT_ID`, because the code exchange must name the app the consent screen named |
| `ENSEMUS_OAUTH_GOOGLE_CLIENT_SECRET_FILE`, `ENSEMUS_OAUTH_MICROSOFT_CLIENT_SECRET_FILE` | `connector-worker` only | The path, inside the container, of a file holding that app's client secret. Mount the file into `connector-worker` with a Compose overlay of your own. Never put the secret in the environment and never give it to `web`. A client ID with no secret stops the worker at start |
| `ENSEMUS_PUBLIC_URL` | `web`, `connector-worker` | Providers send the admin back to `ENSEMUS_PUBLIC_URL` followed by `/api/v1/oauth/callback`, for example `https://ensemus.example.com/api/v1/oauth/callback`. Register exactly that address as the redirect URI in each app. The worker names the same address when it redeems the code, and a provider refuses the exchange if the two differ |

Turn on `ENSEMUS_CONNECTORS_ENABLED` as for any connector. Microsoft issues a new refresh token on every refresh; the worker reseals it in place under the connection's existing secret, and a refresh that loses a race to another one is refused rather than written.

### The `unknown` queue, and who watches it

`unknown` means an attempt could have gone through and the provider cannot say. For email that is every timeout after the end of a message. Ensemus never retries one and never guesses. A person has to look.

- **Who is told:** the accountable owner and whoever asked, in their inbox, once and at once. Nothing is emailed, and M3 adds no alert to an operator. An unknown action nobody opens stays unknown.
- **Who answers:** the accountable owner, and organization owners and admins who can see the work, on the organization's external actions page under `Needs a decision`. They search the relay's log for the Message-ID shown, then say what they found. **There is no send button here.** Saying it was not sent ends it as failed, and asking again takes a new approval.
- **What you do as an operator:** give those people access to the relay's log, because the answer is only there. Watch how many are waiting and how old they are. This prints counts and no content:

  ```sh
  compose exec postgres psql -U postgres -d ensemus -c \
    "select organization_id, count(*), min(updated_at) from integrations.external_actions
     where status = 'unknown' group by 1"
  ```

  An action stuck in `sending` or `reconciling` for more than a few minutes means the connector worker is not running. Temporal holds its run, and nothing is lost: it carries on when the worker returns. An action with no worker for an hour ends failed with `CONNECTOR_UNAVAILABLE`, which never reached anyone.

**The cost.** Every timeout after the commit point takes a person's time, including the false ones, such as a crash just before the first byte. How often this happens has not been measured, because no real relay has been used.

### Webhooks that cannot be applied

The web tier stores what arrives and answers 202 without believing it, so a sender cannot tell at HTTP level that its signature failed. The outcome is on the delivery row. Bodies are dropped at every ending, and a delivery never retries itself into a loop.

```sh
compose exec postgres psql -U postgres -d ensemus -c \
  "select organization_id, endpoint_id, state, reject_code, count(*)
   from integrations.webhook_deliveries group by 1, 2, 3, 4"
```

| What you see | What it means | What to do |
|---|---|---|
| `rejected`, `BAD_SIGNATURE` or `SIGNATURE_MISSING` | The sender's secret or code is wrong, or someone who is not the sender has the URL | Check the sender. If nobody you know sent it, replace the endpoint |
| `rejected`, `TIMESTAMP_OUTSIDE_WINDOW` | A replay, or a sender's clock more than the window off (5 minutes by default) | Check the sender's clock. It is safe to ignore a replay |
| `rejected`, `MALFORMED_PAYLOAD` | It was signed correctly and it makes no sense. This is the poison case. It ended here, and is not retried | Tell the sender. They need to send a corrected event |
| `rejected`, `SECRET_UNAVAILABLE` | **Not the sender's fault.** The worker could not open the signing secret. The bytes are gone | Fix the sealing key first. Then the sender has to send it again, with a new event ID if the old one was applied |
| `rejected`, `NOT_PROCESSED_IN_TIME` | Nobody verified it within 24 hours, usually because the connector worker was down | Start the worker. The sender has to send it again |
| `duplicate` | That event ID was already applied, so nothing happened | Nothing is needed |
| `received`, and old | The worker or Temporal is down, or the event is dead in the outbox | Check the worker. Put dead events back with `redrive.js`, as above |

A sender getting 429 has hit that endpoint's rate or backlog limit. These limits are starting values, not measurements. Someone with a leaked URL can fill that endpoint's window and delay genuine callbacks. The cure is to make a new endpoint and move the sender to it. The specification has no route to disable the old one yet, so an operator does it directly, which takes effect at once:

```sh
compose exec postgres psql -U postgres -d ensemus -c \
  "update integrations.webhook_endpoints set state = 'disabled' where id = '<endpoint id>'"
```

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

This prints how many deletions have not reached the ledger (`queued`, and `dead` if any went dead) and how long the oldest has waited (`oldestSeconds`). **These are the deletions a restore could not put back if the database were lost now.** The dispatcher also logs `tombstone_ledger.backlog` every minute while any are waiting. Normally the count is zero. A store or Temporal outage costs them no attempts. A store outage holds them until it ends, and a Temporal outage does not hold them at all.

### Restore

**If you run the connectors profile, read this first. The code does not enforce it.** A restore to before a send loses the attempt row, and that action goes back to `ready`. If Temporal still has the finished run, it stops a second send. If Temporal was restored too, the same mail can go again (ADR-027 D2). So stop the connector worker before anything else, and clear `COMPOSE_PROFILES` from your shell, so that step 7 does not start it again:

```sh
compose --profile connectors stop connector-worker
unset COMPOSE_PROFILES
```

Then, after step 7, keep it stopped until someone has reviewed every action that was not settled at the backup's time, using [the list after these steps](#after-a-restore-with-the-connectors-profile). `OPS-02` in M6 is where this gets a real answer.

1. Stop what people reach the database through, and leave the dispatcher running:

   ```sh
   compose stop proxy web
   ```

2. **If the database you are replacing is still running, drain the ledger backlog first.** The restore replaces the outbox, so a deletion still waiting there is destroyed with it, and that file comes back with nothing to say it was deleted. Put any dead events back in the queue, then check until both counts are zero:

   ```sh
   compose exec dispatcher node dist/redrive.js
   compose run --rm --no-deps dispatcher node dist/ledger-backlog.js
   ```

   If it will not drain, for example because the object store is down, fix that if you can. If you have to go on anyway, note the `queued` and `dead` counts. Those deletions will come back, as the section below describes, and the people affected need telling. Skip this step if the database has been lost.

3. Stop everything else that uses the database:

   ```sh
   compose stop worker dispatcher
   ```

4. Put the dump in the container and restore it into the running database. It runs in one transaction, so a failure changes nothing:

   ```sh
   compose cp ./ensemus.dump postgres:/tmp/ensemus.dump
   compose exec -T postgres pg_restore -U postgres -d ensemus --clean --if-exists --single-transaction --exit-on-error /tmp/ensemus.dump
   compose exec -T postgres rm /tmp/ensemus.dump
   ```

5. If this release has migrations newer than the dump, apply them:

   ```sh
   compose run --rm --no-deps migrate
   ```

6. Re-apply the tombstone ledger. **Do this before anyone is let back in.**

   ```sh
   compose run --rm --no-deps worker node dist/reapply-ledger.js
   ```

   It prints counts and IDs, and no names: `entries`, `tombstonesAdded`, `artifactsRemoved`, `bytesRemoved`, `organizationsMissing`, `invalid`, `unconfirmed` and `failed`. It exits 1 if `failed`, `invalid` or `unconfirmed` is above zero, 2 if it refused to start because an argument was not one it can take, and 0 only when nothing is left to do. For `failed`, fix the cause and run it again. Running it again is always safe. For `invalid` and `unconfirmed`, see the next section: those tenants stay refused until you decide.

7. Start everything:

   ```sh
   compose up -d
   ```

If step 6 is skipped or fails, the product protects itself: anyone in an organization whose database is behind the ledger lands on a page saying it is being restored (503), and the API answers 503 `RESTORE_PENDING`, until the re-apply succeeds. This holds while the object store can answer the check. If it cannot, the gate stays as it was, or open for a process that has just started, so keep the web tier stopped until step 6 has succeeded. A web process left running through a restore can take up to 30 seconds to notice, and longer if the store is slow, which is why step 1 stops it. Other organizations are not affected.

### After a restore with the connectors profile

List what the restored database says is not settled, which prints IDs and no content:

```sh
compose exec postgres psql -U postgres -d ensemus -c \
  "select organization_id, id, status, updated_at from integrations.external_actions
   where status in ('ready', 'sending', 'reconciling', 'unknown') order by updated_at"
```

For each one that could have gone after the backup, search the relay's log for `<{id}@{your Message-ID domain}>`. Nothing in Ensemus does this for you, nothing stops you skipping it, and the worker can send as soon as it starts. If a `ready` action did go, cancel its work or tell its owner before you go on, since nothing else will stop it. Start the worker only once that review is done:

```sh
compose --profile connectors start connector-worker
```

### When the re-apply asks you to decide

The re-apply does not destroy a file that still has its row and its bytes on the ledger's word alone, because an entry can be forged by anyone holding the dispatcher's credential ([ADR-026](../00-foundation/adr/ADR-026-tombstones-survive-restore.md), D3). It logs `tombstone_ledger.entry_unconfirmed` with a `ledgerEntry`, changes nothing for that file, and leaves its tenant refused. Decide for each one:

- **You restored a backup older than this deletion**, and the object store went back too, or a purge had not finished. The deletion is real, so confirm it:

  ```sh
  compose run --rm --no-deps worker node dist/reapply-ledger.js --confirm <ledgerEntry>
  ```

  A restore where bytes survived can leave many of these. To confirm them in one run, list them in a file, one `ledgerEntry` to a line, and mount the file into the command. The path has to be absolute, and the file readable by everyone, because the command does not run as root:

  ```sh
  compose run --rm --no-deps -v "$PWD/confirm.txt:/tmp/confirm.txt:ro" worker node dist/reapply-ledger.js --confirm-file /tmp/confirm.txt
  ```

  Each line says that this one deletion is real, exactly as `--confirm` does, so it has to be a whole `ledgerEntry`. There are no patterns and no way to name everything in a tenant. A line that is anything else, an empty file or a file it cannot read stops the command with exit status 2 before it has changed anything. An entry the list leaves out stays `unconfirmed`, and the command exits non-zero. **The list is what stands between a forged entry and a live file.** The `tombstone_ledger.entry_unconfirmed` lines are a place to start it, but copied as they are they confirm any forgery among them. Keep an entry only if the file's deletion fits what you know, such as the tenant, what its people say they deleted, and the time of the backup. If an entry cannot be accounted for, treat it as the next case.

- **You did not restore anything**, so nothing can be behind the ledger and this entry is not a deletion. Do not confirm it, because that destroys a live file. Move it aside, which also lets the tenant back in:

  ```sh
  compose run --rm --no-deps worker node dist/reapply-ledger.js --quarantine <ledgerEntry>
  ```

  Then treat `objects_ledger_*` as stolen: rotate the credential, and tell the security owner. The object is kept under `tombstone-ledger-quarantine/` for them.

`invalid` means an object under `tombstone-ledger/` is not a valid entry. The command logs `tombstone_ledger.entry_invalid` with a `ledgerEntry` if the object's key names one. Look at the object, then quarantine it the same way. If no `ledgerEntry` was logged, its key names nothing and no tenant is refused because of it. Find it by listing the prefix, and pass its whole key to `--quarantine`. Quarantining an object whose key names a real deletion brings that file back, so if the body is damaged and the deletion is real, delete the file again once the tenant is back in.

All of these options can be repeated and combined, and the command re-applies everything else in the same run.

The same applies if a tenant is refused with no restore behind it, which is what a forged entry looks like from outside.

### What this does not bring back or remove

- A deletion that was still in the backlog when the database was lost comes back as a name, usually without its bytes, so it cannot be downloaded. Someone has to delete it again. Nothing records which ones these were, so check the backlog regularly, and tell the people affected about the restore point.
- Work and files added after the backup are lost, and the bytes of those files stay in the store with nothing pointing at them, until `OPS-02`.
- The restored dump itself still holds what was deleted, until it expires.

`tests/stack/restore.test.ts` runs these steps against real containers, including the file coming back when the ledger is not re-applied.

## Upgrades and rollback

Plan runs must drain before upgrading across migration 0004 (commit 4c207fd) to any later release. A run started before `work_units.run_id` existed replays correctly and then ends without moving its work and without reporting it (`docs/02-architecture/04-work-kernel.md`). Before such an upgrade, let every plan run finish or stop it, and check that no work is `running` or `awaiting_approval` under a plan. No deployment of that code is known to exist.

If a run did cross that migration, its work is left `running` or `awaiting_approval` with an empty `run_id`, and a person has to move it by hand: the page offers the ordinary buttons. The periodic check deliberately does not fail such work when its workflow has closed. A person starting planned work by hand leaves exactly the same row, with no workflow behind it, so the check would fail work that somebody is doing. Nothing recorded on the row tells the two apart.

`pnpm test:upgrade` is how a release proves it can take over paused work. It builds the images of an earlier commit (the merge-base with `main`, or `--from <ref>`) in a temporary worktree, opens a plan through that release's own pages until its approval is paused, upgrades to the current images with their migrations, approves, and checks that the same run reaches Checking and that a person can finish it. It runs as its own Compose project on port 18443 and removes everything it made. It refuses a base that has no stack, no page that can run a plan, or that is older than migration 0004.

Dry-run migration and replay tests in staging using production-like data/roles; back up; release compatible DB changes; deploy compatible workers and web versions; canary and verify; delay destructive schema contraction. Rollbacks can be limited by irreversible database changes and Temporal workflow history version compatibility; an operator must receive those limitations before upgrade.

## Performance and cost validation

Run reference load against web and workers separately. Profile event-loop delay, CPU/RSS, DB pool contention, Temporal task lag, model quotas, per-task cost, retrieval recall, and worker retry storms. Compare one-host and scale-out profiles. Do not claim fixed concurrent capacity without measured hardware, dataset and provider assumptions.
