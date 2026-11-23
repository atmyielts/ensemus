---
title: The connector worker and egress gateway
audience: operator
area: op-run
tickets: []
modes: [cloud, byom, sovereign]
status: written_untested
sources: [docs/00-foundation/adr/ADR-027-verified-external-actions.md, workers/workflow/src/connector-worker.ts, workers/workflow/src/egress-gateway.ts, infrastructure/compose/compose.yaml, docs/05-operations/05-container-deployment-runbook.md, docs/06-delivery/evidence/M3-report.md, packages/workflows/src/external-action-workflow.ts, packages/workflows/src/external-action-step.ts, packages/domain/src/webhook.ts, apps/web/src/lib/webhook-limiter.ts, apps/web/src/server/api.ts, packages/application/src/errors.ts]
tests: []
---

# The connector worker and egress gateway

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

The connector worker and its fixed-target relays carry supported external actions, synchronization and webhooks. They are off by default, and no install needs them.

**Use generated test values against a test relay only, for now.** The design needs an outside security review before any real credential is stored. No real provider or relay has been used. The tests for this path are written, and the M3 report records them as not yet run.

## What each one is

The rule is that one service has credentials and no route out, and one has a route out and no credentials.

| Service | Holds | Reaches | Cannot reach |
|---|---|---|---|
| `connector-worker` | The app and secrets database URLs, the private sealing key, the Temporal codec key | PostgreSQL, Temporal and the gateway, on the internal `connectors` network | Anything else. That network has no route out |
| `egress-gateway` | No secret | The `connectors` network, and the one target you name, over `outbound` | Any database, or any other target |
| `web` | Can seal a secret, and cannot unseal one | Neither network | The connector worker and the gateway |

The gateway forwards bytes and reads nothing. TLS runs through it, from the connector to the relay, so it sees ciphertext. All parsing of what strangers send happens in the connector worker, on the network with no way out.

## With the profile off

There is no connector worker and no gateway, and the stack makes no outbound attempt. The API answers `CONNECTOR_NOT_AVAILABLE`, with the words "This connector is not available on this deployment." The webhook address answers 404.

## Turning it on

Set these in the environment Compose reads. `compose` means `docker compose -f infrastructure/compose/compose.yaml`.

| Setting | What it does | Default |
|---|---|---|
| `COMPOSE_PROFILES=connectors`, or `--profile connectors` | Starts both services. Use it on every Compose command, because a command without it does not see them | Off |
| `ENSEMUS_CONNECTORS_ENABLED=true` | Lets `web` create connections and answer the webhook route. Leave it false unless the worker runs, so no row waits for a worker that is not coming | `false` |
| `ENSEMUS_EGRESS_TARGET=host:port` | The one relay the gateway forwards to. One name and one port: not a list, a URL or a path | Empty, and the gateway will not start |
| `ENSEMUS_SMTP_TLS` | Anything but `none` requires TLS, and a relay that does not offer it is refused. Set `none` only for a relay on a trusted site network | `required` |
| `ENSEMUS_SMTP_MESSAGE_ID_DOMAIN` | The domain in each Message-ID. It is what someone searches the relay's log for | `ensemus.invalid` |

```sh
export COMPOSE_PROFILES=connectors
export ENSEMUS_CONNECTORS_ENABLED=true
export ENSEMUS_EGRESS_TARGET=relay.example.invalid:587
compose up -d --wait
compose ps connector-worker egress-gateway
compose logs --tail 20 connector-worker egress-gateway
```

**Success:** both are `healthy`, and the logs hold `connector_worker.started` and `egress_gateway.started`. **Failure:** see "When it refuses" below.

**On a Sovereign site**, make the target an on-site relay, and have the site's firewall limit the `outbound` network to it. An install with no relay runs no profile, and makes no attempt. This page does not say that a site is isolated: that is for the offline acceptance test. See [outbound traffic](outbound-traffic.md).

## Turning it off

Remove the profile, and set `ENSEMUS_CONNECTORS_ENABLED` back to false. Nothing goes out. An approved action still waiting for a worker stays waiting for up to an hour, and then ends failed with `CONNECTOR_UNAVAILABLE`, which reached nobody. Asking again takes a new approval.

To stop sends at once, during an incident, stop the worker alone:

```sh
compose --profile connectors stop connector-worker
```

## The unknown queue

`unknown` means an attempt could have gone through and the relay cannot say. For email that is every timeout after the end of a message. Ensemus never retries one, and never guesses. A person has to look.

- **Who is told:** the accountable owner and whoever asked, in their inbox, once. Nothing is emailed, and no alert reaches an operator. An unknown action nobody opens stays unknown.
- **Who answers:** the accountable owner, and organization owners and admins who can see the work, on the external actions page under `Needs a decision`. They search the relay's log for the Message-ID shown, and say what they found. There is no send button there.
- **What you do:** give those people access to the relay's log, because the answer is only there. Watch how many are waiting, and how old they are.

This prints counts and no content:

```sh
compose exec postgres psql -U postgres -d ensemus -c \
  "select organization_id, count(*), min(updated_at) from integrations.external_actions
   where status = 'unknown' group by 1"
```

An action in `sending` or `reconciling` for more than a few minutes usually means the connector worker is not running. Temporal holds its run, and it carries on when the worker returns. How often a false `unknown` happens has not been measured, because no real relay has been used.

## Webhooks that cannot be applied

The web tier stores what arrives, and answers 202 without believing it, so a sender cannot tell from the answer that its signature failed. The outcome is on the delivery row. Bodies are dropped at every ending, and a delivery never retries itself into a loop.

```sh
compose exec postgres psql -U postgres -d ensemus -c \
  "select organization_id, endpoint_id, state, reject_code, count(*)
   from integrations.webhook_deliveries group by 1, 2, 3, 4"
```

| What you see | What it means | What to do |
|---|---|---|
| `rejected`, `BAD_SIGNATURE` or `SIGNATURE_MISSING` | The sender's secret or code is wrong, or someone who is not the sender has the address | Check the sender. If nobody you know sent it, replace the endpoint |
| `rejected`, `TIMESTAMP_OUTSIDE_WINDOW` | A replay, or a sender's clock off by more than the window | Check the sender's clock. A replay is safe to ignore |
| `rejected`, `MALFORMED_PAYLOAD` | Signed correctly, and it makes no sense. It ended here, and is not retried | Tell the sender. They need to send a corrected event |
| `rejected`, `SECRET_UNAVAILABLE` | Not the sender's fault. The worker could not open the signing secret, and the bytes are gone | Fix the sealing key first. Then the sender has to send it again |
| `rejected`, `NOT_PROCESSED_IN_TIME` | Nobody verified it within 24 hours, usually because the worker was down | Start the worker. The sender has to send it again |
| `duplicate` | That event ID was already applied, so nothing happened | Nothing |
| `received`, and old | The worker or Temporal is down, or the event is dead in the outbox | Check the worker. Put dead events back, as in [workers and workflows](workers-and-workflows.md) |

A sender getting 429 has hit a limit. These are starting values in the code, not measurements: 300 calls a minute from one address for tokens nobody issued, 3000 a minute on one web replica, and each endpoint's own limit on its row. Someone with a leaked address can fill that endpoint's window, and delay genuine callbacks. Make a new endpoint and move the sender to it. No route disables the old one yet, so you do it directly, and it takes effect at once:

```sh
compose exec postgres psql -U postgres -d ensemus -c \
  "update integrations.webhook_endpoints set state = 'disabled' where id = '<endpoint id>'"
```

## When it refuses

| What you see | What it means | What to do |
|---|---|---|
| `egress_gateway.no_target`, and the gateway exits | `ENSEMUS_EGRESS_TARGET` is empty, or is not one `host:port` | Set it. The refusal is the point: with no target there is nowhere it may send |
| `egress_gateway.target_unreachable` | The relay did not answer. This is the relay or the route to it, not Ensemus | Check the relay. What each action then shows depends on how far it got, so read its page |
| `egress_gateway.at_capacity` | The gateway refused a connection. Its limit is in the code, and has not been tuned against load | Look at how many sends are running, and whether the relay has stalled |
| `connector_worker.crashed` with an `errorCode` | Often a missing secret or no Temporal. `ConfigError` means a setting, and the log does not say which | Read the code, and check `DATABASE_URL_SECRETS` and `SECRET_SEALING_PRIVATE_KEY` |
| TLS refused by the connector | The relay does not offer TLS, or its name does not match | Fix the relay. Do not set `ENSEMUS_SMTP_TLS=none` for a relay that is not on a trusted site network |

The gateway logs codes only. Who connected, and to what, are not written down. So a relay's log, not Ensemus's, is where a message is traced.

## After a restore

A restore to before a send loses the attempt row, and that action goes back to `ready`. If Temporal was restored too, the same mail can go again. **The code does not stop this, so a person must.** Keep the connector worker stopped until someone has reviewed the unsettled actions. See [after a restore](after-a-restore.md).

## What this does not show

- That a real relay or provider works.
- That a message reached an inbox. `sent` means the mail server accepted it.
- Exactly-once delivery. It is at most one effect from this side, and an honest `unknown` when nobody can say.

## Optional business adapter routes (BYOM and Sovereign)

Business adapters use the protocol in `packages/contracts/src/business-adapter.ts`. Each kind gets one fixed-target gateway. They are not vendor integrations by themselves; deploy an adapter for your actual source, with credentials and source ACL mapping. Multi-tenant Cloud routing remains unqualified, and configuring these routes in Cloud is refused.

Use `infrastructure/compose/compose.business.yaml` alongside the core Compose file and an already configured connector profile. That profile currently also requires the existing SMTP gateway target. The optional relay profiles are independent: `business-crm`, `business-ticketing` and `business-accounting`. Keep a route unset when its relay is not running, so setup does not offer it.

| Kind | Optional profile | Operator target setting | Shared web/worker route setting |
|---|---|---|---|
| CRM | `business-crm` | `ENSEMUS_CRM_ADAPTER_TARGET=adapter.example.invalid:443` | `ENSEMUS_EGRESS_GATEWAY_CRM=egress-crm:2525` |
| Ticketing | `business-ticketing` | `ENSEMUS_TICKETING_ADAPTER_TARGET=adapter.example.invalid:443` | `ENSEMUS_EGRESS_GATEWAY_TICKETING=egress-ticketing:2525` |
| Accounting | `business-accounting` | `ENSEMUS_ACCOUNTING_ADAPTER_TARGET=adapter.example.invalid:443` | `ENSEMUS_EGRESS_GATEWAY_ACCOUNTING=egress-accounting:2525` |

The values above are examples, not real targets. Put only the selected routes in the operator env file. Include both Compose files and the matching profile whenever creating those services. Web receives route metadata without joining the connector or outbound networks; only the worker opens the fixed relay. The relays hold no credential. `ENSEMUS_BUSINESS_TLS` defaults to `required`; a site CA can be supplied as public PEM in `ENSEMUS_BUSINESS_CA_PEM`. Certificate checking remains enabled. Do not use `none` on an untrusted network.

The company administrator grants a local read/write ceiling while supplying a manual credential. This is not a provider OAuth consent receipt or a claim that the key has those permissions. The source still independently authorizes every request. Fields and streams are checked against the connector's allowlist; every write still uses the existing immutable approval and receipt path. No selected streams means no source read. Revocation immediately closes stored-record access and the worker revokes the sealed lease.

Qualification in the current candidate uses generated credentials, actual TLS, native PostgreSQL roles and real connector sync activities. It does not qualify a vendor adapter, live provider or complete Temporal deployment. See the current release-candidate report for exact results.
