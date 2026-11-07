# The Sovereign Compose overlay

**This folder holds no overlay yet.** It describes `compose.sovereign.yaml`, which is still to be written and tested when the stack is next dockerized. Until it exists, `build-bundle.mjs` refuses with `OVERLAY_MISSING`, and `bundle-rehearsal.mjs` will not start. Nothing about it has run.

## What it is for

`compose.yaml` builds and pulls. A bundle install must do neither. The overlay is laid over `compose.yaml` by `install-bundle`, from inside the bundle folder, to point every service at the images the bundle loaded and nothing else:

```text
docker compose -p <project> [--env-file <file>] -f compose/compose.yaml -f compose/compose.sovereign.yaml ...
```

## What it has to say

### Images, from the bundle only

`install-bundle` loads each archive, checks its image ID against the signed manifest, and only then names it `ensemus-sovereign/<name>:<version>`. So each service uses that name, sets `pull_policy: never`, and removes `build:` with `!reset null`. `ENSEMUS_RELEASE` is set by the tool.

| Service | Image |
|---|---|
| `web` | `ensemus-sovereign/web:${ENSEMUS_RELEASE}` |
| `worker`, `dispatcher`, `migrate` | `ensemus-sovereign/worker:${ENSEMUS_RELEASE}` |
| `proxy` | `ensemus-sovereign/proxy:${ENSEMUS_RELEASE}` |
| `postgres` | `ensemus-sovereign/postgres:${ENSEMUS_RELEASE}` |
| `temporal-schema`, `temporal-namespace` | `ensemus-sovereign/temporal-admin-tools:${ENSEMUS_RELEASE}` |
| `temporal` | `ensemus-sovereign/temporal:${ENSEMUS_RELEASE}` |
| `valkey` | `ensemus-sovereign/valkey:${ENSEMUS_RELEASE}` |
| `objects` | `ensemus-sovereign/objects:${ENSEMUS_RELEASE}` |

The digest pins in `compose.yaml` cannot stay. An image saved and loaded by its ID has no repository digest to match, so a pinned name would not find it, and Compose would try to fetch it. The digest check moves to the install tool, which also confirms at the smoke test that each running container is the signed image.

### Secrets, from the operator's folder

`compose.yaml` reads secrets from `../../.local/secrets/`, which from inside a bundle is the wrong place. Every entry under `secrets:` is restated as `${ENSEMUS_SECRETS_DIR:?}/<name>`. A secret never goes in a bundle.

### The proxy's configuration

A bundle's paths are lower case, by the allowlist in `@ensemus/sovereign/documents`, so `build-bundle` copies `proxy/Caddyfile` to `compose/proxy/caddyfile`. The overlay remounts it, keeping the target path inside the container:

```yaml
volumes:
  - ./proxy/caddyfile:/etc/caddy/Caddyfile:ro
```

Compose merges volumes by their target, so this replaces the base entry. Every other mounted file already has a lower-case name.

### The trust root

`ENSEMUS_LICENSE_TRUST_ROOT_FILE` and its mount, in `web` and `worker`, from outside the bundle folder. This is the operator's copy, delivered out of band, as ADR-030 D3 says.

## Things to check when it is written

These could not be checked without running Docker, so they are listed here to be proved, not assumed:

- That an image ID read on the build machine matches the one read after `docker load` on the install machine. If the two use different image stores, classic and containerd, the IDs can differ, and the install stops. It stops safely, but it needs a stated answer.
- That the container's `.Image` reads the same as the image's `.Id` under the store in use. The smoke test compares them.
- That `docker compose ps --format json` prints what the smoke test reads on the version shipped: `Service`, `ID`, `State`, `Health` and `Image`.
- That `docker compose stop` with the new bundle's files reaches a service only the old release had. `--remove-orphans` on `up` is there for those.
- That the bundle folder stays in place while the stack runs, since the proxy, PostgreSQL and Temporal bind mounts read from it. An upgrade replaces those mounts when it recreates the containers, so the old folder can go only after that.

Whether a site's network really stays quiet is for the acceptance test's packet capture, not for this overlay: see `docs/specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md`.
