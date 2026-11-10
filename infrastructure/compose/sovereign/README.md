# The Sovereign Compose overlay

`compose.sovereign.yaml`, in this folder, is the overlay. `build-bundle.mjs` copies it into every bundle as `compose/compose.sovereign.yaml`, and `tests/stack/bundle-upgrade.test.ts` builds a bundle with it from real images. It has not yet been through a full install on a machine with no registry: `bundle-rehearsal.mjs` and the offline acceptance test are what would show that.

## What it is for

`compose.yaml` builds and pulls. A bundle install must do neither. The overlay is laid over `compose.yaml` by `install-bundle`, from inside the bundle folder, to point every service at the images the bundle loaded and nothing else:

```text
docker compose -p <project> [--env-file <file>] -f compose/compose.yaml -f compose/compose.sovereign.yaml ...
```

Paths in both files resolve from the folder of the first, `compose/` inside the bundle.

## What it says

### Images, from the bundle only

`install-bundle` loads each archive, checks its image ID against the signed manifest, and only then names it `ensemus-sovereign/<name>:<version>`. So each service uses that name, sets `pull_policy: never`, and removes `build:` with `!reset null`. `ENSEMUS_RELEASE` is set by the tool, and Compose refuses to start without it.

| Service                                                                                                                                          | Image                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `web`                                                                                                                                            | `ensemus-sovereign/web:${ENSEMUS_RELEASE}`                  |
| `worker`, `knowledge-worker`, `agent-worker`, `dispatcher`, `migrate`, `connector-worker`, `egress-gateway`, `auth-restore`, `restore-reconcile` | `ensemus-sovereign/worker:${ENSEMUS_RELEASE}`               |
| `proxy`                                                                                                                                          | `ensemus-sovereign/proxy:${ENSEMUS_RELEASE}`                |
| `postgres`, `provision-roles`                                                                                                                    | `ensemus-sovereign/postgres:${ENSEMUS_RELEASE}`             |
| `temporal-schema`, `temporal-namespace`                                                                                                          | `ensemus-sovereign/temporal-admin-tools:${ENSEMUS_RELEASE}` |
| `temporal`                                                                                                                                       | `ensemus-sovereign/temporal:${ENSEMUS_RELEASE}`             |
| `valkey`                                                                                                                                         | `ensemus-sovereign/valkey:${ENSEMUS_RELEASE}`               |
| `objects`                                                                                                                                        | `ensemus-sovereign/objects:${ENSEMUS_RELEASE}`              |

Every service in `compose.yaml` is in this table, the `connectors` and `ops` profiles included, so no profile can bring in an image the bundle did not sign. A new service in `compose.yaml` needs a line here and in the overlay.

The digest pins in `compose.yaml` cannot stay. An image saved and loaded by its ID has no repository digest to match, so a pinned name would not find it, and Compose would try to fetch it. The digest check moves to the install tool, which also confirms at the smoke test that each running container is the signed image.

### Secrets, from the operator's folder

`compose.yaml` reads secrets from `../../.local/secrets/`, which from inside a bundle is the wrong place. Every entry under `secrets:` is restated as `${ENSEMUS_SECRETS_DIR:?}/<file>`, with the same file names `generate-test-secrets.mjs` writes, so a folder laid out like `.local/secrets` works as it is. Compose refuses to start with `ENSEMUS_SECRETS_DIR` unset. A secret never goes in a bundle.

### The proxy's configuration

A bundle's paths are lower case, by the allowlist in `@ensemus/sovereign/documents`, so `build-bundle` copies `proxy/Caddyfile` to `compose/proxy/caddyfile`. The overlay remounts it, keeping the target path inside the container:

```yaml
volumes:
  - ./proxy/caddyfile:/etc/caddy/Caddyfile:ro
```

Compose merges volumes by their target, so this replaces the base entry. Every other mounted file already has a lower-case name.

### The trust root

`ENSEMUS_LICENSE_TRUST_ROOT_FILE` and its mount, in `web` and `worker`, from outside the bundle folder. The operator names their copy, delivered out of band as ADR-030 D3 says, in `ENSEMUS_LICENSE_TRUST_ROOT_PATH`, and it is mounted as the `license_trust_root` secret. Compose refuses to start without it: a bundle install always has a trust root, since `install-bundle` needs one to verify the bundle at all. It holds public keys only. The worker has it because `sovereign-license` runs from that image and must accept exactly what web can read back.

### The bundle's own manifest

`web` and `worker` also read `bundle-manifest.dsse.json`, from the bundle folder the stack runs from, as `ENSEMUS_BUNDLE_MANIFEST_FILE`. They check it against the trust root before believing anything it says, so the release a page and a diagnostic export name is the signed one, and nothing when it does not verify.

### What it leaves alone

Networks, addresses, name pins, memory limits, read-only filesystems and profiles are `compose.yaml`'s. With no profile nothing in the stack can make an outbound attempt, and the `connectors` profile adds the one way out it always did (ADR-027 D5).

## Still to be proved on a real install

These need Docker, a bundle and a machine with no registry, so they are listed here to be proved, not assumed:

- That an image ID read on the build machine matches the one read after `docker load` on the install machine. If the two use different image stores, classic and containerd, the IDs can differ, and the install stops. It stops safely, but it needs a stated answer.
- That the container's `.Image` reads the same as the image's `.Id` under the store in use. The smoke test compares them.
- That `docker compose ps --format json` prints what the smoke test reads on the version shipped: `Service`, `ID`, `State`, `Health` and `Image`.
- That `docker compose stop` with the new bundle's files reaches a service only the old release had. `--remove-orphans` on `up` is there for those.
- That the bundle folder stays in place while the stack runs, since the proxy, PostgreSQL and Temporal bind mounts, and the manifest web and worker read, come from it. An upgrade replaces those mounts when it recreates the containers, so the old folder can go only after that.

Whether a site's network really stays quiet is for the acceptance test's packet capture, not for this overlay: see `docs/specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md`.
