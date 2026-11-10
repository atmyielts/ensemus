# Offline bundles

How a release reaches a machine with no registry, and how to check it when it gets there (`COMM-04`, `SOV-03`, ADR-030 D4).

**State of this:** the verifier and the install plan are unit tested with generated keys and a double for Docker. The overlay that `infrastructure/compose/sovereign/README.md` describes is written, as `infrastructure/compose/sovereign/compose.sovereign.yaml`, and `build-bundle.mjs` copies it into every bundle. In CI (the stack job of run 42620054406), `tests/stack/bundle-upgrade.test.ts` built a bundle with that overlay from the stack's real images, then verified it with the built `verify-bundle.mjs`, loaded every image archive and matched each loaded ID to its signed digest, ran `install-bundle.mjs --dry-run` with no Docker on the path, and saw the install stop on a changed digest and on an archive changed by one byte, with nothing started and nothing recorded. A real install that starts the stack from the overlay, and the upgrade and rollback rehearsal (`bundle-rehearsal.mjs`), are not part of CI and have no recorded run, so what the overlay's README lists as still to be proved is still unproved. Signing uses a throwaway key until the owner decides who holds the real one, so **no bundle exists yet that a customer should trust**. This document makes no statement about any site's network. The acceptance test in `docs/specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md`, with its packet capture, is what would.

## What a bundle is

A folder, so you can move it however your site requires and a tool can check it with streams.

| Path | Role | What it holds |
|---|---|---|
| `bundle-manifest.dsse.json` | | The signed list of everything else |
| `images/<name>.tar` | `image` | One image archive for each service image, ours and third-party |
| `compose/` | `compose` | `compose.yaml`, the overlay, and the files they mount |
| `migrations/` | `migration` | The release's SQL, to read. The image carries its own copy, and that is the one that runs |
| `tools/` | `tool` | `verify-bundle.mjs`, `install-bundle.mjs` and the other standalone tools |
| `sboms/`, `notices/` | `sbom`, `notice` | What is inside, and whose it is |
| `advisories/`, `support-policy/` | `advisory`, `support_policy` | Signed notices, and the support policy |
| `release/` | `release_manifest` | The release manifest |
| `models/` | `model` | Local model weights. Empty until the owner decides what can be redistributed, and refused without a license reference |
| `docs/` | `documentation` | These guides |

The manifest also states the release's version, line, kind and publication date, what it can upgrade from and roll back to, and the limits on going back.

## Before the first install

You need two things **from outside the bundle**, delivered with your contract, by a route you trust:

1. **The trust root**: the public keys you believe.
2. **The hash of `verify-bundle.mjs`**, or a copy of it. The copy inside a new bundle proves nothing about that bundle, or the bundle would be vouching for itself. After the first install, use the copy you already have to check the next bundle. Any signed distribution has this bootstrap problem, and this is its usual answer.

## Check a bundle

Needs Node 24 and nothing else: no network, no Docker, and no contact with Ensemus.

```text
node verify-bundle.mjs <folder> --trust-root <file>
```

It exits 0 if accepted, 1 if refused, and 2 for a bad argument. It checks in this order, and nothing in the folder is believed until the signature has passed:

1. The signature on the manifest, against your trust root. A key must be allowed to sign bundles: a key allowed only to sign licenses is refused.
2. What is in the folder. Any link, or anything but a file or folder, is refused, and so is anything the manifest does not list. A link is never followed.
3. Each file's size, then its hash.
4. That each image loads from a file listed as an image.

| Code | What it means | What to do |
|---|---|---|
| `MANIFEST_MISSING` | No manifest, or no such folder | Check the path, and that the copy finished |
| `MANIFEST_REFUSED` | The signature or contents were refused. `reason` says why: `UNKNOWN_KEY`, `WRONG_PURPOSE`, `BAD_SIGNATURE`, `NOT_ENOUGH_SIGNATURES`, `KEY_NOT_VALID_FOR_THIS_DATE`, `WRONG_TYPE`, `MALFORMED`, `TOO_LARGE`, `CONTENT_INVALID`, `FORMAT_NOT_SUPPORTED` | Do not use it. Ask whoever sent it. `FORMAT_NOT_SUPPORTED` means a newer format than this tool reads, and nothing is wrong with what you run now |
| `LINK_REFUSED` | A symbolic link, or something that is not a file, or the folder itself is a link | Copy the real files, without links |
| `FILE_NOT_LISTED` | Something is in the folder that was not signed, including an empty folder | Remove it only if you know how it got there. If you do not, treat the bundle as tampered with |
| `FILE_MISSING` | A listed file is gone | Copy the bundle again |
| `FILE_CHANGED` | A listed file has a different size or hash | Copy the bundle again. If it happens twice, treat it as tampered with |
| `IMAGE_NOT_LISTED` | An image's archive is not listed as an image | Do not use it. Ask whoever sent it |
| `TRUST_ROOT_INSIDE_BUNDLE` | You pointed `--trust-root` inside the folder being checked | Use your own copy |
| `TRUST_ROOT_UNREADABLE` | The trust root is missing or not valid | Fix that. There is no fallback |

A bundle signed with a generated test key says so. Treat that as a rehearsal bundle, and nothing else.

**What this does not prove:** that the release is free of bugs, or that the person who held the signing key was right to sign. It proves these files are the ones that key signed. ADR-030 D3 states the limit if a key leaks.

## Install

Read [upgrade-and-rollback.md](upgrade-and-rollback.md) first. See the plan with no Docker and no changes:

```text
node install-bundle.mjs <folder> --trust-root <file> --state-dir <dir> --dry-run
```

Then the real run:

```text
node install-bundle.mjs <folder> --trust-root <file> --state-dir <dir> \
  --operator "<your name>" --backup-reference "<which backup>" \
  [--license <file>] [--maintenance <file>]... [--confirm-outside-rights] \
  [--project <name>] [--env-file <file>]
```

- **The state folder** holds `installation-record.jsonl`, one appended line per install, and the signed manifest of what is installed now. Keep it outside any bundle folder, and keep it for the life of the deployment. The tool refuses to treat an emptied folder as a first install when the record says otherwise, but it cannot tell if you delete both.
- **The record** holds the bundle, its images, the license ID, whether the release was covered, your name and your backup reference. These are your words on your own machine. Nothing sends them anywhere.
- **The tool never contacts a registry.** Its only Docker commands are `load`, `image inspect`, `tag`, `inspect`, and Compose's `stop`, `ps`, `run --pull never` and `up --pull never --no-build`.
- **It compares each loaded image's ID with the signed digest and stops on any difference**, before anything is stopped or started.
- **Keep the bundle folder in place while the stack runs**, because the stack mounts configuration files from it.
- **A first install still asks for a backup reference.** With nothing yet to back up, say so in those words, since the record keeps what you write.

### If it stops

| Code | State | What to do |
|---|---|---|
| Any code from the table above | Nothing changed | As above |
| `SAME_VERSION`, `UPGRADE_PATH_NOT_LISTED`, `ROLLBACK_NOT_REQUESTED`, `ROLLBACK_NOT_LISTED`, `NOT_A_ROLLBACK` | Nothing changed | See [upgrade-and-rollback.md](upgrade-and-rollback.md) |
| `OUTSIDE_RIGHTS_REFUSED`, `OUTSIDE_RIGHTS_NOT_CONFIRMED` | Nothing changed | This release is outside what your license covers. What you run now goes on running. Talk to whoever you hold the license from, or, where the code is the second one, confirm with `--confirm-outside-rights` |
| `BACKUP_REQUIRED` | Nothing changed | Take one, then name it |
| `INSTALLED_STATE_MISSING`, `INSTALLED_MANIFEST_REFUSED` | Nothing changed | The state folder is damaged. Restore it from your own copy. The tool will not guess what is running |
| `COMPOSE_FILES_NOT_LISTED` | Nothing changed | Ask whoever sent the bundle |
| `IMAGE_LOAD_FAILED`, `IMAGE_NOT_CONFIRMED`, `IMAGE_DIGEST_DIFFERS` | The running version was not touched. Images may have been loaded, which affects nothing | Do not use this bundle. `IMAGE_DIGEST_DIFFERS` has one harmless cause to rule out, an image store that differs from the build machine's. Otherwise treat it as tampered with |
| `STOP_FAILED` | Unclear | Look at `docker compose ps`, then run again |
| `RESTORE_REQUIRED` | Services stopped, no migration run | Expected on a rollback: restore, then run again with `--backup-restored` |
| `MIGRATIONS_FAILED`, `START_FAILED`, `SMOKE_TEST_FAILED` | Migrations may have run, and nothing was recorded | Look at the logs. If it cannot go forward, restore the backup |

## Build a bundle (vendor side)

```text
node workers/workflow/scripts/build-sovereign-tools.mjs
node infrastructure/scripts/build-bundle.mjs <version> --signer <pem> --key-id <id> --out <folder> \
  --line <major.minor> --kind patch --published-on <YYYY-MM-DD> --git-commit <40 hex> \
  --workflow-compatibility "<text>" --image web=<reference> --image worker=<reference> \
  [--security] [--upgrade-from <version>]... [--rollback-to <version>]... [--rollback-constraint <CODE>]...
```

Every fact comes from an argument. Third-party images come from the pins in `compose.yaml`, and a pin it has no name for stops the build, so nothing gets left out. It reads the ID of an image already on the machine, saves by that ID, and never pulls. Every signature says `THROWAWAY-TEST-KEY-NOT-FOR-DISTRIBUTION` inside what is signed, until custody is decided.

`bundle-rehearsal.mjs` builds two bundles and goes through the upgrade and rollback in [upgrade-and-rollback.md](upgrade-and-rollback.md). It takes several GB of disk.
