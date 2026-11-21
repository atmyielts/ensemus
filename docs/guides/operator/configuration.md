---
title: Configuration reference
audience: operator
area: op-install
tickets: [FOUND-04]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [packages/config/src/index.ts, infrastructure/compose/compose.yaml, infrastructure/compose/compose.test.yaml, infrastructure/compose/compose.capture.yaml, infrastructure/compose/proxy/Caddyfile, infrastructure/containers/Dockerfile.web, infrastructure/containers/Dockerfile.worker, apps/web/start.mjs, apps/web/next.config.ts, apps/web/src/server/runtime.ts, apps/web/src/instrumentation.ts, workers/workflow/src/main.ts, workers/workflow/src/dispatcher.ts, workers/workflow/src/migrate.ts, workers/workflow/src/setup-token.ts, workers/workflow/src/redrive.ts, workers/workflow/src/ledger-backlog.ts, workers/workflow/src/reapply-ledger.ts, workers/workflow/src/connector-worker.ts, infrastructure/scripts/upgrade-gate.mjs, infrastructure/scripts/parity-gate.mjs, infrastructure/scripts/build-release.mjs, tests/helpers/forms.ts, tests/helpers/stack.ts, docs/05-operations/05-container-deployment-runbook.md, m3-verified-actions:infrastructure/compose/compose.yaml, m3-verified-actions:workers/workflow/src/egress-gateway.ts, m3-verified-actions:apps/web/src/server/api.ts, m4-foundation:packages/config/src/index.ts, m4-foundation:workers/workflow/src/agent-main.ts, m6-foundation:packages/config/src/sovereign.ts, m8-foundation:packages/config/src/index.ts, m8-foundation:workers/workflow/src/ops-erase.ts, hx-foundation:packages/config/src/index.ts]
tests: []
---

# Configuration reference

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

This lists every setting the code reads, which was found by searching for `process.env` and `readSecret` in the code, and for variables in the Compose files. It describes this tree first. Settings that exist only on a branch still being written are in their own section, so you can tell them apart.

## How a setting reaches the code

**Your settings file.** Compose fills in `${NAME:-default}` in `compose.yaml` from `.local/ensemus.env`, as [Installing with Docker Compose](install-compose.md) sets up. A variable in your shell overrides the file.

**Secrets.** The code reads a secret from `NAME_FILE`, which is the path of a mounted file, or from `NAME`. The file wins. `compose.yaml` uses only the file form. Avoid the plain form, because anyone who can inspect the container can read it. A setting that is not in `compose.yaml` does not reach the container, whatever is in your settings file. It needs an override file, as [Connecting an identity provider](identity-providers.md) shows.

**Changing a setting.** Recreate what reads it. Setting it in the file does nothing to a running container:

```sh
compose up -d --wait --wait-timeout 300
```

## Settings you choose

These are the ones you are expected to set. None is a secret.

| Setting | Read by | Required | Default in `compose.yaml` | What it does |
|---|---|---|---|---|
| `ENSEMUS_MODE` | `web` | **Yes.** The code has no default, so outside Compose it must be set | `sovereign` | `cloud`, `byom` or `sovereign`. Any other value is a `ConfigError` |
| `ENSEMUS_PUBLIC_URL` | `web` | **Yes**, in the same way | `https://localhost:8443` | The address people use. It has to be a URL with no slash at the end. Sign-in trusts this origin and no other, and it decides whether cookies are marked `Secure` |
| `ENSEMUS_ALLOW_SIGNUP` | `web` | No | `false` | `true` lets anyone who can reach this deployment create an account and an organization of their own. Joining yours still takes an invitation |
| `ENSEMUS_HOSTNAME` | `proxy` | For anything but `localhost` | `localhost` | The one name the proxy answers to. The name alone, with no scheme or port. It has to match `ENSEMUS_PUBLIC_URL`. Any other name fails at the TLS handshake |
| `ENSEMUS_BIND_ADDRESS` | Compose | No | `127.0.0.1` | The host address the proxy's port is published on. The default reaches nothing beyond this host |
| `ENSEMUS_HTTPS_PORT` | Compose | No | `8443` | The host port for HTTPS |
| `ENSEMUS_TRUSTED_PROXIES` | `proxy` | Only with a proxy of yours in front | Empty | Who may state a client's address. See below |
| `ENSEMUS_NETWORK_PREFIX` | Compose | No | `172.30` | The first two parts of every internal address. Set it before the first start, because changing it later recreates the networks |

### `ENSEMUS_TRUSTED_PROXIES`

It takes addresses or CIDR ranges, separated by spaces. Sign-in allows 10 attempts a minute for each client address, and sign-up allows 5, so this decides who shares an allowance.

- **People connect directly to this proxy:** leave it empty. Whatever `X-Forwarded-For` a client sends is overwritten with the address of its connection.
- **A proxy of yours is in front, and this is empty:** everyone appears to come from your proxy. Ten wrong passwords from anyone then refuse sign-in for everyone for up to a minute, and nothing warns you.
- **A proxy of yours is in front, and this names it:** a connection from a listed address has its `X-Forwarded-For` read from the right, passing over listed addresses. Anything else is treated as a direct client.

If you set it:

- Your proxy must add the address it received the connection from to the right of `X-Forwarded-For`, or replace the header with that address. A proxy that passes on the client's own header lets every client choose its address.
- List only proxies you run, and let only them reach the published port. A wide range trusts everyone on that range.
- List the address this proxy sees, which may not be your proxy's own. Through a port published on the same host, it is normally Docker's gateway on the `edge` network. While your proxy is carrying traffic, the foreign address on port 443 in `compose exec proxy netstat -tn` is the one to list.
- Send `ENSEMUS_HOSTNAME` from your proxy as both the TLS server name and the `Host` header, and have it set `X-Forwarded-Host` and `X-Forwarded-Proto` to the public values.

A value the proxy cannot read stops it from starting. `node infrastructure/scripts/check-proxy.mjs` checks this proxy's behaviour in containers. It cannot check yours.

## Secrets

Each is a file under `.local/secrets`, mounted at `/run/secrets`. [Secrets and key rotation](secrets.md) says how to make and change each one.

| Setting | Read by | Required | File |
|---|---|---|---|
| `DATABASE_URL_APP` | `web`, `worker`, the re-apply command, the connector worker | **Yes** | `db_app_url` |
| `DATABASE_URL_AUTH` | `web` | **Yes** | `db_auth_url` |
| `DATABASE_URL_DISPATCHER` | `dispatcher`, the redrive and backlog commands | **Yes** | `db_dispatcher_url` |
| `DATABASE_URL_MIGRATOR` | `migrate`, the setup code command | **Yes** | `db_migrator_url` |
| `DATABASE_URL_SECRETS` | The connector worker. `compose.yaml` also gives it to `worker`, whose code does not read it | Only for the connector worker | `db_secrets_url` |
| `AUTH_SECRET` | `web` | **Yes** | `auth_secret` |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | `web`, at start, in `start.mjs` | **Yes.** `web` refuses to start without it | `next_server_actions_key` |
| `TEMPORAL_CODEC_KEY` | `worker`, `dispatcher`, the connector worker | **Yes.** It has to decode to 32 bytes | `temporal_codec_key` |
| `OBJECT_STORAGE_ACCESS_KEY` | `web`, `worker`, `migrate`, the re-apply command | **Yes** | `objects_access_key` |
| `OBJECT_STORAGE_SECRET_KEY` | The same | **Yes** | `objects_secret_key` |
| `OBJECT_STORAGE_LEDGER_ACCESS_KEY` | `dispatcher` | **Yes** | `objects_ledger_access_key` |
| `OBJECT_STORAGE_LEDGER_SECRET_KEY` | `dispatcher` | **Yes** | `objects_ledger_secret_key` |
| `SECRET_SEALING_PUBLIC_KEY` | `web`. `compose.yaml` mounts it, and in this tree no code reads it. The code that does is on `m3-verified-actions` | With connections | `sealing_public_key.pem` |
| `SECRET_SEALING_PRIVATE_KEY` | The connector worker. `compose.yaml` also gives it to `worker`, whose code does not read it | Only for the connector worker | `sealing_private_key.pem` |
| `ENSEMUS_OIDC_CLIENT_ID` | `web`, only if a discovery URL is set | With OIDC | Not in `compose.yaml` |
| `ENSEMUS_OIDC_CLIENT_SECRET` | The same | With OIDC | Not in `compose.yaml` |

These secret files are read by the containers themselves, not through the code's settings:

| File | Read by | What it is |
|---|---|---|
| `db_superuser_password` | `postgres`, on an empty data folder, through `POSTGRES_PASSWORD_FILE` | The `postgres` superuser's password |
| `db_migrator_password`, `db_app_password`, `db_auth_password`, `db_dispatcher_password`, `db_secrets_password` | `postgres`, on an empty data folder | The passwords those roles are created with. Each has to match the password in the `_url` file |
| `db_temporal_password` | `postgres` on an empty data folder, `temporal`, `temporal-schema` | Temporal's database password |
| `objects_identity.json` | `objects`, through `-s3.config` | Who may use the store, and what each identity may do |

## Settings `compose.yaml` fixes

These are set to a value in the file, with no variable. You can only change them with an override file, and you should not need to. The code has a default for most of them, and those defaults matter only outside Compose.

| Setting | Read by | Value | Note |
|---|---|---|---|
| `OBJECT_STORAGE_ENDPOINT` | `web`, `worker`, `dispatcher`, `migrate`, the re-apply command | Port 8333 on `objects`, over plain HTTP on the `data` network | The code's default is the same |
| `OBJECT_STORAGE_BUCKET` | The same | `ensemus` | The ledger identity's scope in `objects_identity.json` names this bucket, so the two have to change together |
| `TEMPORAL_ADDRESS` | `worker`, `dispatcher`, the connector worker | `temporal:7233` | The code's default is the same. `web` never has it |
| `TEMPORAL_NAMESPACE` | The same | `default` | `setup-namespace.sh` creates this one name, with 72 hours of history retention. That is a starting value, and ADR-025 says it needs review |

## Settings the images set

Leave these alone. They are part of the image.

| Setting | Where | Value | Why |
|---|---|---|---|
| `NODE_ENV` | Both images | `production` | |
| `NEXT_TELEMETRY_DISABLED` | `web` image | `1` | No outbound telemetry from the framework |
| `HOSTNAME`, `PORT` | `web` image | `0.0.0.0`, `3000` | Where the server listens, for the proxy to reach it |
| `NEXT_RUNTIME` | Set by the framework | | The code reads it, and you never set it |

`ENSEMUS_RELEASE` is a build setting in this tree. `apps/web/next.config.ts` and `Dockerfile.web` use it as the deployment ID, and `build-release.mjs` puts it in the manifest. `compose.yaml` does not pass it, so a `compose build` uses `local`. To set it, use `compose build --build-arg ENSEMUS_RELEASE=<your release name>`.

## Settings for the third-party services

These are set by `compose.yaml` and its scripts, for the images that read them. Changing one can break the stack or its promises.

| Setting | Service | Note |
|---|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD_FILE` | `postgres` | Used only on an empty data folder |
| `DB`, `DB_PORT`, `POSTGRES_SEEDS`, `POSTGRES_USER`, `POSTGRES_PWD` | `temporal` | `temporal-start.sh` sets `POSTGRES_PWD` from the mounted secret |
| `BIND_ON_IP` | `temporal` | `0.0.0.0`, because it is on two networks |
| `TEMPORAL_VERSION_CHECK_DISABLED` | `temporal` | **Keep this.** With `dynamicconfig.yaml`, it stops the server calling out to check for new versions |
| `SQL_PASSWORD` | `temporal-schema` | `setup-schema.sh` sets it from the mounted secret |
| `TEMPORAL_ADDRESS` | `temporal-namespace` | `setup-namespace.sh` sets a `passthrough:///` address, which avoids a DNS lookup that hangs on an isolated network |

## Settings for the connector worker

`connector-worker.ts` is in this tree and reads these, and `compose.yaml` here has no service that runs it. The profile that starts it is on `m3-verified-actions`. See [The connector worker](connector-worker.md).

| Setting | Read by | Required | Default | What it does |
|---|---|---|---|---|
| `ENSEMUS_CONNECTORS_ENABLED` | `web` | No | `false` | Lets `web` create connections and answer the webhook route. Off, the webhook address answers as if it does not exist. Leave it off unless the worker is running |
| `ENSEMUS_EGRESS_GATEWAY` | Connector worker | No | `egress-gateway:2525` | Where the connector worker sends its traffic |
| `ENSEMUS_EGRESS_TARGET` | Egress gateway, on `m3-verified-actions` | With the profile | None | One `host:port`, and the only way out of the stack. The gateway refuses to start without a valid value |
| `ENSEMUS_SMTP_TLS` | Connector worker | No | `required` | Anything but `none` requires TLS, and a relay that does not offer it is refused. Use `none` only for a relay on a trusted site network |
| `ENSEMUS_SMTP_MESSAGE_ID_DOMAIN` | Connector worker | No | `ensemus.invalid` | The domain in each Message-ID, which is what someone searches a relay's log for |
| `COMPOSE_PROFILES` | Compose | No | Empty | `connectors` starts both services. Use it on every command, because a command without it does not see them |

## Settings on branches still being written

**None of these is in this tree.** They were read from the branch named, and each one may change before it merges. `guides-sweep` checks them again against the merged code. A setting existing does not mean its feature is finished.

| Setting | Branch | Secret | What the code says |
|---|---|---|---|
| `DATABASE_URL_AGENT` | `m4-foundation` | **Yes** | The agent worker's database login. The `ensemus_agent` role behind it has to exist before the migration that needs it |
| `ENSEMUS_PRIVATE_MODEL_ENDPOINTS` | `m4-foundation` | No | A comma-separated list of origins that may be private or plain HTTP. Tenants cannot set it |
| `ENSEMUS_MODEL_CREDENTIALS_REVIEWED` | `m4-foundation` | No | A review reference. With none, a key for a hosted model provider cannot be stored. This is the interlock for the outside review. Do not set it until that review has happened |
| `ENSEMUS_LICENSE_TRUST_ROOT_FILE` | `m6-foundation` | No, public keys only | The file holding the trust root. Without it, a notice appears on one page, and nothing fails to start |
| `ENSEMUS_BUNDLE_MANIFEST_FILE` | `m6-foundation` | No | The installed bundle's manifest, so a deployment can say which release it runs |
| `ENSEMUS_RELEASE` | `m6-foundation` | No | Read at runtime too, there. Default `unreleased` |
| `ENSEMUS_EXPORT_RETENTION_HOURS` | `m6-foundation` | No | How long an export archive stays in the store. A whole number from 1 to 8760, default 24. It is the operator's to set, and is no promise to anyone |
| `ENSEMUS_BILLING_ENABLED` | `m8-foundation` | No | Default `false`. Refused with `ENSEMUS_MODE=sovereign` |
| `ENSEMUS_BILLING_ORGANIZATION_ID`, `ENSEMUS_BILLING_CONNECTION_ID` | `m8-foundation` | No | IDs. Each has to be a UUID |
| `ENSEMUS_PAYMENT_PROCESSOR` | `m8-foundation` | No | A lower-case name |
| `ENSEMUS_BREAK_GLASS_ENABLED` | `m8-foundation` | No | Default `false` |
| `ENSEMUS_BREAK_GLASS_MAX_MINUTES` | `m8-foundation` | No | Required when the one above is `true`. There is no default length |
| `DATABASE_URL_OPERATOR`, `DATABASE_URL_SUPPORT`, `DATABASE_URL_ERASER` | `m8-foundation` | **Yes** | Named by the operations commands there, which are not built yet. The `ensemus_eraser` role cannot log in until an operator lets it |
| `ENSEMUS_OTEL_ENDPOINT` | `hx-foundation` | No | Your own trace collector, as an http or https URL with no credentials, query or fragment. Unset, traces go nowhere |
| `ENSEMUS_OTEL_SAMPLE_RATIO` | `hx-foundation` | No | From 0 to 1. Default 1. Setting it with no endpoint stops the process |

## Test-only settings

**These are not options for a real install.** They are for the project's own tests and gates, and several of them weaken what the product does.

| Setting | Used by | What it does |
|---|---|---|
| `ENSEMUS_TEST_BASE` | `tests/helpers/forms.ts`, the gates | The address tests talk to |
| `ENSEMUS_TEST_PG_PORT` | `compose.test.yaml`, `tests/helpers/stack.ts` | The host port tests reach PostgreSQL on |
| `ENSEMUS_TEST_TEMPORAL_PORT` | `compose.capture.yaml`, `tests/replay` | The host port tests reach Temporal on |
| `ENSEMUS_TEST_SMTP_CONTROL_PORT` | `compose.test.yaml` on `m3-verified-actions` | The control port of a test mail sink |
| `ENSEMUS_COMPOSE_AIRGAP` | `tests/helpers/stack.ts`, the gates | Adds the overlay that makes outside lookups unreachable |
| `ENSEMUS_UPGRADE_PORT` | `upgrade-gate.mjs` | The port for the gate's own stack. Default 18443 |
| `ENSEMUS_PARITY_MODE` | `parity-gate.mjs`, `tests/parity/harness.ts` | The mode a parity run expects |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `tests/helpers/forms.ts`, set to `0` | Turns certificate checks off for tests. **Never set this on anything real** |
| `DISPATCH_URL`, `KILL_ON` | A test fixture | Crashes a dispatcher on purpose |

`compose.test.yaml` as a whole is test-only. It publishes the database, the store and Temporal to localhost, turns sign-up on by default, adds a second web replica and adds a mock identity provider. `compose.capture.yaml` is test-only too.

## When a setting is wrong

| What you set | What happens |
|---|---|
| `ENSEMUS_MODE` missing or unknown, `ENSEMUS_PUBLIC_URL` not a URL or ending in a slash | The first request fails, and so does the health check. The real message names the setting, but the log keeps only `errorCode` `ConfigError`, because the web tier strips error text from its logs |
| A required secret missing, or its file empty | The same `ConfigError`, in `web`. A worker logs `worker.crashed` with `errorCode` `ConfigError` and exits |
| `ENSEMUS_OIDC_DISCOVERY_URL` set, with no client ID or secret | The same. **Every request fails, not only sign-in** |
| `TEMPORAL_CODEC_KEY` not 32 bytes | The process exits, and the log gives `errorCode` `Error` |
| `next_server_actions_key` missing | `web` exits with `Refusing to start: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY_FILE is not set.` |
| `ENSEMUS_TRUSTED_PROXIES` unreadable | `proxy` will not start, and who is trusted does not widen |
| `ENSEMUS_ALLOW_SIGNUP` anything but `true` or `false` | `ConfigError`, as above. It does not fall back to on or off |

A config error names the setting and never its value, so a secret cannot reach a log this way.
