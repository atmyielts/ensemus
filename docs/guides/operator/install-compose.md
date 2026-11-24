---
title: Installing with Docker Compose
audience: operator
area: op-install
tickets: [PLAT-15, PLAT-11]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [infrastructure/compose/compose.yaml, infrastructure/compose/compose.public.yaml, infrastructure/compose/proxy/Caddyfile, infrastructure/compose/postgres/10-provision.sh, infrastructure/compose/postgres/provision.sql, infrastructure/compose/temporal/setup-schema.sh, infrastructure/compose/temporal/setup-namespace.sh, infrastructure/containers/Dockerfile.web, infrastructure/containers/Dockerfile.worker, infrastructure/scripts/generate-test-secrets.mjs, packages/config/src/index.ts, packages/telemetry/src/console-guard.ts, apps/web/start.mjs, apps/web/src/app/api/health/ready/route.ts, apps/web/src/app/api/health/live/route.ts, apps/web/src/app/sign-in/page.tsx, workers/workflow/src/migrate.ts, docs/05-operations/05-container-deployment-runbook.md, docs/00-foundation/adr/ADR-025-m1-implementation-decisions.md, tests/stack/platform.test.ts]
tests: []
needs_walkthrough: true
---

# Installing with Docker Compose

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

This installs Ensemus on one host, from a copy of the repository, using `infrastructure/compose/compose.yaml`. It is the same for all three modes, apart from the value of `ENSEMUS_MODE`.

**Read [What you are running](overview.md) first.** It says why you must not store a real credential yet. For a site with no network, this page is not the whole story, so see [Installing with no network](offline-install.md).

## What you need

- Docker Engine with the Compose plugin. The file uses `depends_on` conditions and `--wait`, so it needs Compose version 2.
- A copy of this repository at the commit you are installing, on the host. There is no published image to pull, so the images are built here.
- `openssl`, to make your secrets, or Node.js 24 if you are using the generated test values.
- Network access during the build, for the base images and packages.

No hardware size is given here, because none has been measured. `compose.yaml` limits `web` to 1G of memory, `worker` to 2G and `dispatcher` to 512M. Those are ceilings in a file, not a statement of what you need.

Run every command on this page from the top folder of the repository.

## Step 1: Write your settings

Compose fills in `compose.yaml` from a file of settings. Keep yours in `.local/ensemus.env`. The `.local` folder is ignored by git and stays out of the image builds.

```sh
mkdir -p .local
cat > .local/ensemus.env <<'EOF'
ENSEMUS_MODE=sovereign
ENSEMUS_HOSTNAME=localhost
ENSEMUS_PUBLIC_URL=https://localhost:8443
ENSEMUS_HTTPS_PORT=8443
ENSEMUS_BIND_ADDRESS=127.0.0.1
ENSEMUS_ALLOW_SIGNUP=false
ENSEMUS_TRUSTED_PROXIES=
ENSEMUS_NETWORK_PREFIX=172.30
EOF
```

For a host people reach by name, change three of those together. `ENSEMUS_HOSTNAME` is the name alone, `ENSEMUS_PUBLIC_URL` has the scheme, name and port people use, with no slash at the end, and `ENSEMUS_BIND_ADDRESS` is the address to listen on. For example, `ensemus.example.invalid`, `https://ensemus.example.invalid:8443` and that host's own address. [Configuration reference](configuration.md) explains each setting.

If `172.30.0.0/16` is already in use at your site, set `ENSEMUS_NETWORK_PREFIX` now, such as `172.29`. Changing it later recreates the networks.

## Step 2: Set up the compose command

Every command in these guides uses this helper. Define it in each shell you use:

```sh
compose() { docker compose --env-file .local/ensemus.env -f infrastructure/compose/compose.yaml "$@"; }
```

**Always use the same settings.** A plain `docker compose` without the file falls back to the defaults, which can change the network addresses and the public address of a running install. With the helper, a missing settings file stops the command. Variables in your shell override the file, so check that none of these are set: `env | grep ENSEMUS_`.

## Step 3: Make the secrets

The stack reads 22 files from `.local/secrets`. There are two ways to make them.

- **For a real install,** follow [Secrets and key rotation](secrets.md), which gives every command.
- **For a trial with nothing real in it,** run the generator. Its values are random, but the project calls them throwaway and treats them that way, and nothing looks after them:

```sh
node infrastructure/scripts/generate-test-secrets.mjs
```

Either way, check the count. This prints `22`:

```sh
ls .local/secrets | wc -l
```

## Step 4: Check that the settings resolve

```sh
compose config --quiet
```

It prints nothing and exits 0. Then look at what you are about to run, and confirm the addresses and mode are the ones you meant:

```sh
compose config | grep -E 'ENSEMUS_(MODE|PUBLIC_URL|HOSTNAME|ALLOW_SIGNUP)'
```

## Step 5: Build and start

```sh
compose up -d --build --wait --wait-timeout 300
```

Three hundred seconds is what the project's CI allows for the stack to become healthy once the images are built. It is not a measurement of how long this takes on your host.

The order follows from `compose.yaml`. `postgres` starts first and, on an empty data folder only, creates the roles and databases. `objects` comes up. `migrate` applies migrations and creates the bucket. `temporal-schema`, `temporal` and `temporal-namespace` follow. Then `web`, `worker` and `dispatcher` start, and `proxy` starts last, once `web` is healthy.

## Step 6: See that it worked

**Every service is where it should be:**

```sh
compose ps -a
```

| Service | What success looks like |
|---|---|
| `postgres`, `temporal`, `valkey`, `objects`, `web`, `worker`, `dispatcher` | `running`, with `(healthy)` |
| `proxy` | `running`. It has no health check of its own |
| `migrate`, `temporal-schema`, `temporal-namespace` | `exited (0)` |

**Migrations finished.** This prints a line holding `migrate.done`:

```sh
compose logs migrate | grep migrate.done
```

**The site answers over TLS.** The proxy makes its own certificate from its own local authority, and asks nothing from outside. Copy the root out and use it. People's browsers have to trust this root too, or they will see a warning:

```sh
compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./ensemus-root.crt
curl --cacert ensemus-root.crt https://localhost:8443/api/health/ready
```

That prints `{"status":"ready"}`. It means the web tier can reach PostgreSQL. It says nothing about Temporal or the store, so the `compose ps` check above still matters. `/api/health/live` prints `{"status":"ok"}` as long as the process is answering.

**The sign-in page shows up.** Open `https://localhost:8443/sign-in`, or your own address. You see `Sign in to Ensemus`, and below the form, `Given a setup code? Use it here`. If you see `Create an account` instead, sign-up is on.

**The boundaries hold.** Run the checks at the end of [What you are running](overview.md).

### Share a direct public HTTPS link

On a public host that has ports 80 and 443 available, add `infrastructure/compose/compose.public.yaml` to the Compose command for this installation. In the installation's settings file set `ENSEMUS_HOSTNAME` to the public DNS name or IPv4 address, with no scheme or port, and set `ENSEMUS_BIND_ADDRESS=0.0.0.0`. A DNS name must resolve to the host. Run Compose with the same files and project name for later commands.

The overlay publishes ports 80 and 443 on the proxy, sets the app's origin to HTTPS at that address, and uses Let's Encrypt's short-lived profile for automatic certificate issuance and renewal. The proxy must be reachable on those ports and be able to reach Let's Encrypt. Keep the `caddy-data` volume across restarts.

Before sharing the address, open the sign-in page on another network and confirm it loads with a trusted certificate. For a host named `demo.example.invalid`, the page would be `https://demo.example.invalid/sign-in`. If mail is off, create workspace invitations and share their one-time links privately in chat. [Members and invitations](../user/members-and-invitations.md) explains the owner confirmation step.

## Step 7: Let the first person in

Sign-up is off by default, so nobody can get an account until you issue a code. See [The first owner and setup token](first-owner.md).

## Step 8: Write down what you installed

Keep a local record, away from this host, of:

- the commit you installed, from `git rev-parse HEAD`
- the image IDs, from `docker image inspect ensemus/web:local ensemus/worker:local --format '{{.Id}}'`
- your `.local/ensemus.env`
- the date of your first good backup, from [Backup and restore](backup-and-restore.md)

You will need these for [Upgrading a release](upgrade.md) and [Rolling back a release](rollback.md).

## When it does not work

| What you see | What it means | What to do |
|---|---|---|
| `Couldn't find env file` | You are not in the top folder, or Step 1 was skipped | Change folder, or write the file |
| An error naming a path under `.local/secrets` | A secret file is missing | Make it. `ls .local/secrets` should show 22 files |
| An error about an overlapping address pool | `172.30.0.0/16` is already in use | Set `ENSEMUS_NETWORK_PREFIX`, then start again |
| `compose logs web` says `Refusing to start: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY_FILE is not set.` | The Server Action key is missing or empty. This is on purpose, and it will not fall back to the key built into the image | Check `next_server_actions_key` |
| `web` stays unhealthy, and its log has `errorCode` `ConfigError` | A required setting or secret is missing or invalid. The log leaves out which one | Check `ENSEMUS_MODE`, then `ENSEMUS_PUBLIC_URL` for a slash at the end, then every file `web` reads, using [Configuration reference](configuration.md) |
| `migrate` shows `exited (1)`, and its log has `migrate.failed` | Look at its `errorCode`. Web, worker and dispatcher wait for this job and will not start | `28P01` means a password in `.local/secrets` does not match the database. See below |
| `worker` keeps restarting, and its log has `worker.crashed` | Look at its `errorCode`. A wrong-length `temporal_codec_key` stops it here | Check the file against [Secrets and key rotation](secrets.md) |
| `compose logs proxy` shows a configuration error | The proxy cannot read `ENSEMUS_TRUSTED_PROXIES` or `ENSEMUS_HOSTNAME` | Correct the value. A bad value stops it, and does not widen who is trusted |
| The connection fails during the TLS handshake | The name you asked for is not `ENSEMUS_HOSTNAME`. The proxy answers to one name | Use that name, or change the setting |
| `curl: (60)`, or a browser warning | The client does not trust the proxy's local authority | Use the root from Step 6 |
| The page loads, and every form fails | `ENSEMUS_PUBLIC_URL` does not match the address in the browser. Sign-in refuses requests from any other origin | Make them match |
| Sign-in says `Too many attempts from here. Wait a minute, then try again.` for everyone | A proxy of yours is in front of this one, and everyone shares its address | See `ENSEMUS_TRUSTED_PROXIES` in [Configuration reference](configuration.md) |

**The database is only set up once.** `postgres` creates its roles from your password files on an empty data folder, and never again. If you change those files afterwards, nothing updates the database, and connections fail. To change a password on a running install, see [Secrets and key rotation](secrets.md). If first boot went wrong and **there is nothing in this install you want to keep**, remove the data and start over:

```sh
compose down -v
```

**Never run `compose down -v` on an install you care about.** The `-v` deletes the database, the file storage and the proxy's certificate authority.

## Day to day

```sh
compose stop
compose up -d --wait --wait-timeout 300
compose logs --tail 40 web worker dispatcher
```

`stop` keeps everything. Each `up` runs the three one-shot jobs again, which is safe, because each one finds nothing to do.

## What this page leaves out

- **Sending email and webhooks.** These need the `connectors` profile. See [The connector worker](connector-worker.md).
- **More than one web replica.** `web` has a fixed address, so `--scale web=2` cannot work. See [Scaling and load](scaling-and-load.md).
- **A hosted service.** See [Hosted environments](hosted-environments.md).
- **Verifying a release before installing.** See [Verifying a release](verify-a-release.md).
