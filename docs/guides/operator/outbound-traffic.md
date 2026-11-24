---
title: Outbound traffic and telemetry
audience: operator
area: op-sovereign
tickets: [SEC-05, PLAT-16]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [infrastructure/compose/compose.yaml, infrastructure/compose/compose.airgap.yaml, infrastructure/compose/proxy/Caddyfile, infrastructure/compose/temporal/dynamicconfig.yaml, infrastructure/containers/Dockerfile.web, infrastructure/scripts/air-gap-gate.mjs, infrastructure/scripts/air-gap-rules.mjs, packages/telemetry/src/index.ts, apps/web/src/server/runtime.ts, docs/specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md, docs/06-delivery/evidence/M1-report.md, infrastructure/compose/compose.yaml, infrastructure/scripts/air-gap-gate.mjs, workers/workflow/src/egress-gateway.ts, workers/workflow/src/connector-worker.ts, packages/connectors/src/email/index.ts, apps/web/src/server/api.ts, docs/00-foundation/adr/ADR-027-verified-external-actions.md, docs/05-operations/05-container-deployment-runbook.md, packages/intelligence/src/net/guard.ts, packages/intelligence/src/adapters/index.ts, tests/unit/bundle-tools-offline.test.ts, workers/workflow/src/diagnostics-command.ts]
tests: []
---

# Outbound traffic and telemetry

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

This page says what in the stack is built to contact the outside, how each thing is turned on, and what has been measured. The mode does not choose any of this: `ENSEMUS_MODE` changes no network setting, so Cloud, BYOM and Sovereign run under the same rules.

**This page does not say any deployment is ready for an isolated network.** No air-gap readiness is claimed anywhere, and the delivery plan allows that only after the offline acceptance test passes on released binaries, which has not happened. <!-- not-a-claim -->

## What the stack does with no options set

Start `compose.yaml` with no profile, and these are the settings that matter here:

| Part | What is set | Where |
|---|---|---|
| Proxy | `admin off`, `tls internal` and `skip_install_trust`, so there is no certificate request, no admin API and no change to any trust store | `infrastructure/compose/proxy/Caddyfile` |
| Temporal server | The server's version check is off twice: `TEMPORAL_VERSION_CHECK_DISABLED` and `frontend.enableServerVersionCheck` | `infrastructure/compose/compose.yaml`, `temporal/dynamicconfig.yaml` |
| Web image | `NEXT_TELEMETRY_DISABLED=1`, at build and at run | `infrastructure/containers/Dockerfile.web` |
| Internal names | Pinned to fixed addresses in `extra_hosts`, so a stopped service's name is not looked up on your site's DNS | `infrastructure/compose/compose.yaml` |
| Ensemus logs | Written to the container's standard output, from an allowlist of fields. No exporter sends them anywhere | `packages/telemetry/src/index.ts` |
| Offline tools | `verify-bundle.mjs`, `install-bundle.mjs` and the sealing tools have no network code, and a unit test on the `m6-bundle` branch reads their sources to hold that. `install-bundle.mjs` runs Docker, always with `--pull never` | `tests/unit/bundle-tools-offline.test.ts` |
| Diagnostics | The export writes a file, and no command sends it. See [The diagnostic export](diagnostics-export.md) | `workers/workflow/src/diagnostics-command.ts` |

**There is no setting for telemetry, because Ensemus's own code has nothing to send it with.** Reading the code finds no path that sends usage, logs or errors to Ensemus or a vendor, and none that checks for updates or a license over the network. This rests on that reading and on the count from the gate below, since the audit that should confirm it has not been built. If you ship container logs somewhere, that is your own choice and your own path.

**The Compose networks do not block anything by themselves.** `edge`, `data`, `temporal` and `temporal-db` are ordinary Docker networks with a default route. Nothing in the stack is configured to use it, and the gate below looks for attempts, but the file itself does not stop one. To stop traffic at your site, use your own firewall.

## What you can turn on

Each of these opens a path that is closed until you ask for it.

| Path | Off until | Who connects | To where |
|---|---|---|---|
| Single sign-on | You set `ENSEMUS_OIDC_DISCOVERY_URL`, with `ENSEMUS_OIDC_CLIENT_ID` and `ENSEMUS_OIDC_CLIENT_SECRET` | `web` | The identity provider you named. See [Identity providers](identity-providers.md) |
| Sending email | You start the `connectors` profile and set `ENSEMUS_EGRESS_TARGET` and `ENSEMUS_CONNECTORS_ENABLED=true` | `egress-gateway`, for `connector-worker` | One relay, as one `host:port` |
| Model providers | Not built. On every branch today the model adapter answers `connect_failed`, and the endpoint guard refuses every call | Nothing | Nothing. See [Running local models](local-models.md) |

Email is on the `m3-verified-actions` branch, not yet merged, and no real provider has been used with it.

## How the email path is built

- `connector-worker` holds the connector credentials. It is on the `connectors` network alone, which is `internal: true`, so it has no route out. It reaches PostgreSQL, Temporal and the gateway.
- `egress-gateway` holds no secret and reaches no database. It forwards bytes to the one target you named, and TLS runs through it, so it sees only ciphertext.
- `web` is on neither network. On a Sovereign site, make the target an on-site relay, and have your firewall limit the `outbound` network to it.
- An install with no relay runs no profile, and these two services do not exist.

```sh
COMPOSE_PROFILES=connectors \
ENSEMUS_CONNECTORS_ENABLED=true \
ENSEMUS_EGRESS_TARGET=relay.example.invalid:587 \
docker compose -f infrastructure/compose/compose.yaml up -d --wait
```

**Do not store a real credential yet.** The design behind this path has not had its outside security review, so use generated values and a test relay until it has.

## What the outbound gate tests

The check is a script that CI runs, and it counts attempts instead of trusting settings:

```sh
node infrastructure/scripts/air-gap-gate.mjs --control
node infrastructure/scripts/air-gap-gate.mjs
```

**Never run it on a deployment you care about.** It uses the same Compose project name, `ensemus`, and it runs `docker compose down -v` before and after, which deletes that project's volumes and every byte in them. Use a separate machine with nothing on it.

- It adds a firewall rule to Docker's `DOCKER-USER` chain that drops and counts any new connection from `172.30.0.0/16` to anywhere else, and installs it before the first container starts.
- It points every container's DNS at an unreachable test address, using its own Compose overlay, so a lookup of an outside name also becomes a counted packet.
- It runs the stack test suite with `ENSEMUS_COMPOSE_AIRGAP=1`. It then stops `web-2`, `web`, `objects`, `valkey`, `temporal` and `postgres` one at a time, and asks through the proxy for answers that prove each outage really happened.
- `--control` makes a deliberate attempt from inside `web`. A gate that cannot see that attempt fails, so run the control first.
- `--outages` runs only the outage round. On the `m3-verified-actions` branch, `--connectors` adds a round where mail goes to a test relay inside the counted subnet, and must fail if no mail reached it.

It needs Docker, and the rights to run a privileged helper container, `nicolaka/netshoot:v0.14`, on the host's network.

Success ends with this line, and exit status 0:

```text
OK: the stack ran offline with zero outbound attempts.
```

## How to tell it failed

| What it prints | What it means |
|---|---|
| `FAILED: something tried to reach the outside network.` | The count went up. `Offending packets:` above it names each one, and `Container addresses:` says which container holds each address |
| `FAILED: stack tests did not pass while offline.` | A test failed, whatever the count says |
| `FAILED: during the outages, requests did not get the answer that proves them:` | A request went astray in an outage round, so that round proves nothing about the name it was testing |
| `FAILED: the gate did not detect a deliberate outbound attempt.` | The control failed. Do not believe any zero from this machine |

It also refuses to report a result it cannot stand behind. These two lines stop the run with a failure, as they should:

```text
The stack is not all on 172.30.0.0/16, so this cannot pass: ...
Air-gap rule is missing, so this result cannot be trusted
```

## What has and has not been done

- **Done:** `docs/06-delivery/evidence/M1-report.md` records a run with zero attempts, counted from before first boot, over 34 stack tests, and a control that saw its deliberate attempt. CI runs both steps on each push. That was a stack built by the same job, with what existed at that date. It says nothing about features added since.
- **Not done:** the offline acceptance test in `docs/specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md` has not been passed, on any build. The packet capture and DNS log it asks for are not kept by this gate, which only prints offending packets when there are some.
- **Not done:** the audit for `SEC-05` is not on any branch. Nothing has inspected a running product for a phone-home beyond what this gate counts.
- **Not done:** nothing has been measured on your network, or with your identity provider or relay.
- **What the gate cannot see:** a container off the watched subnet, which is why it refuses that case, and anything your host does outside Docker.

To check a real deployment, use your own firewall and DNS logs, and look for anything leaving the stack's addresses. Ensemus has no tool for measuring a running production install yet.

## When it refuses

Outbound paths that are not set up fail closed. This is what you will see:

| Situation | What happens |
|---|---|
| `egress-gateway` has no target, or a target that is not one `host:port` | It refuses to start, and logs `egress_gateway.no_target` |
| `ENSEMUS_CONNECTORS_ENABLED` is not `true` | The product says `This connector is not available on this deployment.`, nobody can create a connection, and the webhook address answers 404 |
| A relay does not offer TLS, with `ENSEMUS_SMTP_TLS` at its default | The send ends as not sent, with `TLS_REQUIRED`. Nothing goes in the clear. Set `none` only for a relay on a network you trust |
| A connector tries to reach anything else | It has no route. The connector code has only the gateway to connect to, and the caller names no host |

An organization has no setting for any of this. Each path here is the operator's alone, and it applies to the whole deployment.
