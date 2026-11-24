---
title: Verifying a release
audience: operator
area: op-sovereign
tickets: [FOUND-07]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [infrastructure/scripts/verify-release.mjs, infrastructure/scripts/build-release.mjs, .github/workflows/ci.yml, docs/06-delivery/05-environment-and-ci-cd.md, docs/06-delivery/evidence/M1-report.md, .nvmrc]
tests: []
---

# Verifying a release

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

A release folder holds a signed manifest and one SBOM for each Ensemus image. `verify-release.mjs` checks them using only Node. It opens no network connection and contacts no one, so you can run it on an isolated machine.

This page is about the release folder. An offline bundle is a different thing with its own check, in [Installing from an offline bundle](offline-install.md). Every mode uses the same images and the same folder, so these steps do not change between Cloud, BYOM and Sovereign. What differs is who runs them: whoever operates the deployment.

## Read this first: what the signature means today

**Signing uses a throwaway key.** The manifest says so in its `signing` field, with the value `THROWAWAY-TEST-KEY-NOT-FOR-DISTRIBUTION`, and the tool prints that value on every good run.

- `build-release.mjs` makes a new key each time it runs, and discards the private half when it ends.
- It writes the public half into the same folder, as `release-signing-public.pem`, and the tool uses that file unless you name another.
- So a good result today shows that the folder agrees with itself, and that nothing changed after it was signed. It does not show who built the folder. Anyone who can replace the folder can replace the manifest, the signature and the key together.
- Who holds the real signing key is the owner's decision, and has not been made. Until it is, do not read a pass as saying a release came from Ensemus.

## What is in the folder

| File | What it is |
|---|---|
| `release-manifest.json` | The release name, Git commit, signing note, image IDs, third-party image references, database schema version, supported modes and the SBOM list |
| `release-manifest.sig` | The Ed25519 signature of the manifest's exact bytes, in base64 |
| `release-signing-public.pem` | The public key that goes with this signature |
| `sbom-web.spdx.json`, `sbom-worker.spdx.json` | One SPDX SBOM for each Ensemus image |
| `verify-release.mjs` | The tool, copied in so it travels with the release |

`build-release.mjs` writes the folder to `.local/release`. It needs Docker, so it is a build step, and an operator who was handed a folder never runs it.

## Check a folder

You need Node 24, the version in `.nvmrc`. With the folder and Node on the same machine:

```sh
node verify-release.mjs ./release ./release-signing-public.pem
```

The first argument is the folder, and the second is the public key. Leave out the key to use the one in the folder, which is the weak case described above. When a real key exists, always pass your own copy, which you received separately from the folder.

To check it from a container with no network at all, as the build does:

```sh
docker run --rm --network=none -v "$PWD/release:/release:ro" \
  node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 \
  node /release/verify-release.mjs /release
```

That image has to be on the machine already, because with no network it cannot be pulled.

## What success looks like

The exit status is 0, and the output has this shape, with one SBOM line for each image and your own package counts:

```text
Signature: valid
SBOM web: 412 packages, digest matches
SBOM worker: 388 packages, digest matches
Signed with: THROWAWAY-TEST-KEY-NOT-FOR-DISTRIBUTION
OK: this release verified with no network access.
```

The package counts above are made up for the example. The last line says only that the tool used no network. Read the `Signed with` line above it before you decide what the result is worth.

## What it does not check

The tool checks the signature and the SBOM hashes, and nothing else. These stay with you:

- **The images themselves.** It does not look at any image. Compare by hand: run the command below for `ensemus/web:local` and `ensemus/worker:local`, and compare each ID with `images.web.id` and `images.worker.id` in the manifest.
- **The third-party images.** The manifest lists them under `third_party_images`, each with a digest. Compare that list with the `image:` lines of the compose file you are about to use.
- **Image signatures.** The manifest has none, and no image is signed yet.
- **Whether the SBOM is complete.** A matching hash says the SBOM is the one that was signed, and says nothing about what a scanner may have missed.
- **Licenses.** See [Third-party licenses and notices](third-party-licenses.md).

```sh
docker inspect ensemus/web:local --format '{{.Id}}'
```

## When it refuses

Each of these exits with a non-zero status. A refusal means this copy should not be installed. Get a new copy by your own route, compare, and tell whoever gave it to you.

| What you did | What it prints | What it means |
|---|---|---|
| Changed even one byte of the manifest | `Signature: INVALID`, then `FAILED: signature` | The manifest is not what was signed. The tool stops there, and reads nothing else from it |
| Passed a public key that did not make this signature | `Signature: INVALID`, then `FAILED: signature` | The same words, because the tool cannot tell a wrong key from a changed file. Try the key you were given before you suspect the file |
| Changed an SBOM | `SBOM web: 412 packages, digest MISMATCH`, then `FAILED: sbom:web` | The signature is good, and this SBOM is not the one it covers |
| Removed the signature, the manifest, the key or an SBOM | Node's own `ENOENT` error and a stack trace | A file is missing. There is no friendlier message. A missing SBOM prints `Signature: valid` first, so read to the end, and go by the exit status |

## How much has run

CI runs `build-release.mjs` on each push, and that run changes the manifest and an SBOM on purpose and requires both to be refused. `docs/06-delivery/evidence/M1-report.md` records a pass of those checks on a build from that date. That is a check on a build made by the same job. It is not the check of a released binary, because no release has been published. Counsel has not reviewed any of this either.
