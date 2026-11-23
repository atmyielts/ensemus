---
title: Installing from an offline bundle
audience: operator
area: op-sovereign
tickets: [COMM-04, SOV-03]
modes: [sovereign]
status: written_untested
sources: [packages/sovereign/src/bundle.ts, workers/workflow/src/tools/verify-bundle.ts, workers/workflow/src/tools/install-bundle.ts, workers/workflow/scripts/build-sovereign-tools.mjs, infrastructure/scripts/build-bundle.mjs, infrastructure/scripts/bundle-rehearsal.mjs, infrastructure/compose/sovereign/README.md, docs/05-operations/sovereign/offline-bundle.md, docs/05-operations/sovereign/upgrade-and-rollback.md, packages/sovereign/src/documents.ts, docs/00-foundation/adr/ADR-030-sovereign-license-and-bundle.md, docs/specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md]
tests: []
needs_walkthrough: true
---

# Installing from an offline bundle

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

A bundle is a signed folder holding everything a release needs, so you can install with no registry, using images from the folder. This page covers checking one and installing it for the first time. To move between versions, see [Offline upgrades and maintenance lapse](offline-upgrades.md).

## Read this first

**You cannot do this today.** These parts stand between this page and a real install:

- **No bundle exists.** `build-bundle.mjs` refuses with `OVERLAY_MISSING`, because the Compose overlay a bundle has to carry, `compose.sovereign.yaml`, has not been written.
- **What has run is small.** The verifier and the install plan have unit tests, with generated keys and a stand-in for Docker. The build script, a real install and the full rehearsal have not run.
- **Signing uses a throwaway key.** Each signature says `THROWAWAY-TEST-KEY-NOT-FOR-DISTRIBUTION`, and who holds the real key is the owner's decision. So no bundle exists that you should trust as coming from Ensemus. A bundle signed with a generated test key says so when you check it.
- **The code is on the `m6-bundle` branch,** in a commit its author marks as work in progress, and it has not merged. Outside security review of the format has not happened.

**Nothing here claims air-gap readiness.** The delivery plan allows that claim only after the offline acceptance test passes on released binaries, and it has not been passed on anything. <!-- not-a-claim -->

## What you need

Two things from **outside the bundle**, delivered with your contract, by a route you trust:

- **The trust root:** the public keys you believe. Keep it outside the bundle folder.
- **The tool's hash, or a copy of the tool.** The copy of `verify-bundle.mjs` inside a new bundle proves nothing about that bundle, because it would be vouching for itself. Check it against your hash, or use your own copy.

You also need Node 24 and Docker with Compose on the machine, the secrets folder from [Secrets](secrets.md), and a folder for the installation record. Nothing here gives a hardware size, because none has been measured.

## What is in a bundle

| Path | What it holds |
|---|---|
| `bundle-manifest.dsse.json` | The signed list of every other file, with each hash, size and role. It also gives the version, the signed publication date, what it can upgrade from and roll back to, and rollback limits |
| `images/` | One image archive for each service, ours and third-party |
| `compose/` | The Compose files and what they mount |
| `tools/` | `verify-bundle.mjs`, `install-bundle.mjs` and the other standalone tools |
| `migrations/` | The release's SQL, to read. The image holds the copy that runs |
| `sboms/`, `notices/` | What is inside, and whose it is. See [Third-party licenses and notices](third-party-licenses.md) |
| `advisories/`, `support-policy/` | Signed notices, and the support policy |
| `release/` | The release manifest. See [Verifying a release](verify-a-release.md) |
| `models/` | Empty, because what can be redistributed is the owner's decision. See [Running local models](local-models.md) |
| `docs/` | These guides |

## Step 1: check the bundle

This needs only Node. It opens no network connection, and does not need Docker.

```sh
node verify-bundle.mjs ./bundle --trust-root /secure/trust-root.json
```

It believes nothing in the folder until the signature passes. Then it checks that every path in the folder is listed, and each file's size and hash. It stops at the first problem.

Success is exit 0, with this shape:

```text
accepted bundle=00000000-0000-4000-8000-000000000003 version=2.0.0
signed by: generated-bundle-key
files checked: 34, images: 8
Signed with a generated test key. This bundle is for rehearsal, and nothing else.
```

The IDs and counts above are examples. The last line appears for any bundle signed with a test key, and today that is every bundle.

## Step 2: see the plan

This changes nothing and does not call Docker:

```sh
node install-bundle.mjs ./bundle --trust-root /secure/trust-root.json \
  --state-dir /srv/ensemus-state --dry-run
```

It prints `plan direction=install version=2.0.0 installed=none`, the rollback limits, one `step:` line for each step, and then `Dry run: no Docker was called, and nothing was written.`

## Step 3: install

```sh
node install-bundle.mjs ./bundle --trust-root /secure/trust-root.json \
  --state-dir /srv/ensemus-state \
  --operator "A. Example" --backup-reference "first install, nothing to back up yet" \
  --env-file /srv/ensemus.env
```

A first install still asks for a backup reference. With nothing to back up, say so, because the record keeps what you write. The steps, in order:

1. Checks the bundle again.
2. Loads each image from its archive, compares the image's ID with the signed digest, and stops at any difference, before anything starts.
3. Runs migrations, using `--pull never`.
4. Starts the services, using `--pull never --no-build`, and waits for them to be healthy.
5. Confirms each running container is the image the manifest signed.
6. Appends one line to `installation-record.jsonl`, and keeps the signed manifest as what is installed now.

Success ends with `done direction=install version=2.0.0`, and exit 0.

**It never contacts a registry.** The only Docker commands it runs are `load`, `image inspect`, `tag`, `inspect`, and Compose's `stop`, `ps`, `run --pull never` and `up --pull never --no-build`.

Keep the bundle folder in place while the stack runs, because the stack mounts configuration from it. Keep the state folder outside any bundle, for the life of the deployment.

## Step 4: finish

- Add the first owner, as in [The first owner](first-owner.md).
- Attach a license, if you hold one, as in [Issuing and installing a license](license-issuance.md). The product runs without one, and an administrator sees a notice.
- Back up, as in [Backup and restore](backup-and-restore.md), and test that a restore works. The tool cannot check a backup.

## When it refuses: a tampered or wrong bundle

`verify-bundle` exits 1 and prints one line, such as `refused code=FILE_CHANGED path=images/web.tar`. `install-bundle` prints the same codes after `stopped code=`, and at this stage nothing has changed.

| Code | What it means | What to do |
|---|---|---|
| `FILE_CHANGED` | A listed file has a different size or hash. Changing one byte of an image archive ends here | Copy it again. If it happens twice, treat it as tampered with |
| `FILE_NOT_LISTED` | Something is in the folder that was not signed, including an empty folder | Remove it only if you know how it got there. Otherwise treat the bundle as tampered with |
| `FILE_MISSING` | A listed file is gone | Copy the bundle again |
| `LINK_REFUSED` | A symbolic link, or something that is not a file. A link is never followed | Copy the real files, without links |
| `IMAGE_NOT_LISTED` | An image's archive is not listed as an image | Do not use it. Ask whoever sent it |
| `MANIFEST_MISSING` | No manifest, or no such folder | Check the path, and that the copy finished |
| `MANIFEST_REFUSED reason=BAD_SIGNATURE` | A known key's signature does not match, so the manifest was changed | Do not use it |
| `MANIFEST_REFUSED reason=UNKNOWN_KEY` | Your trust root does not know the signer. An unsigned bundle, or one signed by anyone else, ends here | Do not use it, unless you have the wrong trust root |
| `MANIFEST_REFUSED reason=WRONG_PURPOSE` | The key may sign other things, and not bundles. A license key cannot sign a bundle | Do not use it |
| `MANIFEST_REFUSED reason=FORMAT_NOT_SUPPORTED` | Newer than this tool reads. Nothing is wrong with what you run now | Use a newer tool, checked the same way |
| `MANIFEST_REFUSED`, with `NOT_ENOUGH_SIGNATURES`, `KEY_NOT_VALID_FOR_THIS_DATE`, `WRONG_TYPE`, `MALFORMED`, `TOO_LARGE` or `CONTENT_INVALID` | The signature or contents were refused | Do not use it. Ask whoever sent it |
| `TRUST_ROOT_INSIDE_BUNDLE` | You pointed `--trust-root` inside the folder being checked | Use your own copy. A bundle cannot vouch for itself |
| `TRUST_ROOT_UNREADABLE` | The trust root is missing or not valid | Fix that. There is no fallback |
| `STATE_INSIDE_BUNDLE` | The state folder is inside the bundle | Move it out |

Later stops have their own codes, and the tool also says what state it left things in:

| Code | State | What to do |
|---|---|---|
| `IMAGE_DIGEST_DIFFERS`, `IMAGE_NOT_CONFIRMED`, `IMAGE_LOAD_FAILED` | Nothing started. Images may have loaded, which affects nothing | Do not use this bundle. An image store that differs from the build machine's can also cause `IMAGE_DIGEST_DIFFERS`, and this has not been checked. Otherwise treat it as tampered with |
| `BACKUP_REQUIRED` | Nothing changed | Name a backup with `--backup-reference` |
| `OUTSIDE_RIGHTS_REFUSED`, `OUTSIDE_RIGHTS_NOT_CONFIRMED` | Nothing changed | See [Offline upgrades and maintenance lapse](offline-upgrades.md) |
| `INSTALLED_STATE_MISSING`, `INSTALLED_MANIFEST_REFUSED` | Nothing changed | The state folder is damaged. Restore it from your own copy, because the tool will not guess what is running |
| `COMPOSE_FILES_NOT_LISTED` | Nothing changed | Ask whoever sent the bundle |
| `MIGRATIONS_FAILED`, `START_FAILED`, `SMOKE_TEST_FAILED` | Migrations may have run, and nothing was recorded | Read the logs. If it cannot go forward, restore your backup |

Exit 2 means a bad argument. A real run with no `--operator` is one of those.

**What a pass shows:** these files are the ones that key signed. It does not show the release is free of bugs, or that the key holder was right to sign. A customer's trust root also learns of a leaked key only by taking an update, which outside review has on its list.

## What the offline acceptance test asks, and where it stands

`docs/specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md` is the operator test on a private network with no outside DNS and no route out. **None of it has been run, on any build.** The script meant to walk through it has not been written.

| It asks for | Where it stands |
|---|---|
| First boot, enrolment, license verification and ordinary work | Not run |
| A local agent and local retrieval, with an approval across a restart | Not run, and the local agent is not built |
| A power cycle with no duplicate side effects | Not run |
| A packet capture and DNS log showing no outside attempts | Not run. See [Outbound traffic and telemetry](outbound-traffic.md) for what the build's gate does count |
| Export, and restore to a clean instance | Not run |
| Maintenance date advanced, with the purchased version still working | Not run |
| Upgrade from a signed bundle, with no registry lookup | Not run |
| Digests, SBOM and signature checked with no vendor, and a diagnostic export | Not run |

A person who did not write this page also has to follow it before it can count, and nobody has.
