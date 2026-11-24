# Optional Linux Sandbox worker

The base Compose stack runs without a Sandbox worker. Use this overlay only on a Linux installation with an independently provisioned native runner, reviewed network controls, and permission to execute skills. The GitHub Actions fixture verifies the native checks on its own runner. Qualify the actual host and root filesystem and complete the outside review required by ADR-034 before enabling execution.

## Runner attachment

The overlay connects the worker to PostgreSQL, Temporal, and object storage over the internal `sandbox-data` bridge. The internal `sandbox-link` bridge is separate. It connects the worker at `172.30.11.2` to an approved host listener at the bridge address `172.30.11.1`. If you set `ENSEMUS_NETWORK_PREFIX`, substitute its two octets in both addresses. Docker Engine must support the `isolated` bridge gateway mode used by `sandbox-data`.

Bind the independent runner to loopback, its default, and place a forwarding listener at the bridge address that connects only to the runner. You can instead set `ENSEMUS_SANDBOX_RUNNER_BIND_HOST=172.30.11.1` on a separately provisioned runner with equivalent host controls. Bind only to the bridge interface and restrict ingress to the worker address. Limit runner egress independently so the runner has no route to the platform data services or the internet. Docker's internal bridge limits routing from the container and leaves host-interface access available. The installer controls exposure at the host listener.

The default runner port is `8080`. Set `ENSEMUS_SANDBOX_RUNNER_PORT` identically on the worker's Compose invocation and the runner or forwarding listener if you need another port. Use the runner's native Linux runc and cgroup v2 configuration, including a trusted read-only root filesystem, dedicated state and bundle directories, and a persistent supervisor. The worker has no runtime binary or container-management access.

## Credentials and startup

Provide a random token of at least 32 bytes and provision the same value in the worker and runner `SANDBOX_RUNNER_TOKEN_FILE` files. Provide a separate object-store identity limited to reading bundles in the `ensemus` bucket. The existing database and Temporal secrets remain `db_worker_url` and `temporal_codec_key`.

By default, the worker reads files under `.local/secrets` named `sandbox_runner_token`, `sandbox_objects_access_key`, and `sandbox_objects_secret_key`. Override the paths using `ENSEMUS_SANDBOX_RUNNER_TOKEN_HOST_FILE`, `ENSEMUS_SANDBOX_OBJECTS_ACCESS_KEY_HOST_FILE`, and `ENSEMUS_SANDBOX_OBJECTS_SECRET_KEY_HOST_FILE`. The three files must be readable by container UID 1000 and protected from unauthorized users on the host.

From the checkout root, validate the merged model and create the bridge if the host listener needs its address before the worker starts. Applying the overlay may recreate the three dependency containers to add their network attachments.

```sh
docker compose -f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.sandbox.yaml --profile sandbox config --services
docker compose -f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.sandbox.yaml --profile sandbox create sandbox-worker
```

Establish the host listener and restricted route first. Enable Sandbox explicitly in the environment for the stack so both the dispatcher and worker use the same setting.

```sh
ENSEMUS_SANDBOX_ENABLED=true docker compose -f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.sandbox.yaml --profile sandbox up -d
```

The image's healthcheck only verifies the worker heartbeat. Verify that the authenticated `GET /v1/probe` returns all 13 passing checks from the worker's network, and qualify workflow admission, actual limits, cancellation, cleanup after abrupt runner termination, and the packet-level boundary on that host. A failed or stale probe prevents job execution.
