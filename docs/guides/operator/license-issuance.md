---
title: Issuing and installing a license
audience: operator
area: op-sovereign
tickets: [SOV-01]
modes: [sovereign]
status: written_untested
sources: [m6-license:workers/workflow/src/sovereign-license-command.ts, m6-license:workers/workflow/src/sovereign-license.ts, m6-license:packages/application/src/licensing.ts, m6-license:docs/05-operations/sovereign/license-and-maintenance.md, m6-license:packages/sovereign/src/envelope.ts, m6-license:packages/sovereign/src/verify.ts, m6-license:packages/sovereign/src/trust-root.ts, m6-license:packages/domain/src/license.ts, m6-license:packages/domain/src/policy.ts, m6-license:packages/config/src/sovereign.ts, m6-license:tests/fixtures/license-corpus/v1/README.md, m6-foundation:packages/sovereign/src/issuer.ts, m6-foundation:docs/00-foundation/adr/ADR-030-sovereign-license-and-bundle.md]
tests: []
---

# Issuing and installing a license

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

A Sovereign license is a small signed file. This page shows how to check one and attach it to an organization. **The tool that issues licenses is not built yet**, so nobody can issue a real license today, and the only signed documents that exist are generated test files.

## What is real today

| Step | State |
|---|---|
| Checking a signed file, with no database and no network | Written, on the `m6-license` branch |
| Attaching a license or maintenance statement to an organization | Written, on the same branch |
| Issuing a license | **Not built.** Every function in the issuing tool still refuses with `NOT_IMPLEMENTED` |
| A real signing key | **Does not exist.** Who holds it is the owner's decision. The format allows for that decision, and nothing has been signed with a real key |

A license does not decide whether the software runs. Nothing about one can stop a request, and a lapse changes what an administrator reads. See [Offline upgrades and maintenance lapse](offline-upgrades.md).

## What you need

- The license file, such as `license.dsse.json`.
- The trust root, a JSON file of public keys, which reaches you separately from the license the first time. It holds no secrets.
- For `install`, the organization's ID, and the app database URL the worker already has.

Compose does not mount a trust root yet, so you pass one on the command line, as below. Put both files in one folder that the container can read.

## Check the file

`verify` needs no database and no organization, so you can run it before the first owner exists.

```sh
docker compose -f infrastructure/compose/compose.yaml run --rm --no-deps \
  -v "$PWD/license:/license:ro" \
  worker node dist/sovereign-license.js verify /license/license.dsse.json \
  --trust-root /license/trust-root.json
```

A good file exits 0 and prints one line of JSON, with no licensee name in it:

```json
{"command":"verify","ok":true,"standing":"licensed","type":"license","documentId":"00000000-0000-4000-8000-000000000001","keyIds":["generated-license-key"],"testKey":true,"retiredKey":false,"notices":["signed_with_test_key"]}
```

**`testKey: true` means it was signed with a generated test key,** and the notice says so. Treat it as a rehearsal. Every file that exists today reads this way.

## Attach it to an organization

```sh
docker compose -f infrastructure/compose/compose.yaml run --rm --no-deps \
  -v "$PWD/license:/license:ro" \
  -e ENSEMUS_LICENSE_TRUST_ROOT_FILE=/license/trust-root.json \
  worker node dist/sovereign-license.js install \
  --organization 00000000-0000-4000-8000-000000000002 /license/license.dsse.json
```

`install` takes its trust root only from `ENSEMUS_LICENSE_TRUST_ROOT_FILE`, so what it accepts is what the deployment can read back. A success prints `"ok":true`, the `organizationId`, a `recordId`, `created`, `standing`, `maintenance` and `notices`.

- On a deployment with several organizations, run it once for each.
- Running it again with the same file is safe, and reports `"created":false`.
- Install the license first. A maintenance statement for a license not installed in that organization is refused.
- For `web` to read it, `web` also needs `ENSEMUS_LICENSE_TRUST_ROOT_FILE` and the mounted file. The shipped `compose.yaml` does not set this yet, and the page that would show it is not built.

## What the exit status means

| Exit | Meaning |
|---|---|
| 0 | The file verified. A lapse, a test key or a stopped clock is still 0, with a notice |
| 1 | The file does not verify, or was refused. `reasonCode` says why, and nothing was stored |
| 2 | The question could not be asked: a bad argument, no readable trust root, or a trust root that does not know this signer |
| 3 | The command could not finish, for instance the database could not be reached. Repeating `install` is safe |

## When it refuses

A refusal prints one line, such as `{"command":"verify","ok":false,"reasonCode":"BAD_SIGNATURE"}`, and stores nothing. A row in the database proves nothing here, because every value shown comes from the signed file, which is checked again on each read. So a tampered file, or a forged row, gets no further than this.

| `reasonCode` | What it means | What to do |
|---|---|---|
| `BAD_SIGNATURE` | A known key's signature does not match, so the file was changed or damaged | Get a fresh copy from whoever issued it |
| `UNKNOWN_KEY` | No key in your trust root signed it. Exit 2 | An unsigned file, or one signed by anyone else, ends here. Check you have the right trust root first |
| `WRONG_PURPOSE` | The key that signed it may not sign this kind of document | Ask the issuer. A maintenance key cannot sign a license |
| `WRONG_TYPE`, `MALFORMED`, `CONTENT_INVALID` | It is not one of these documents | Check you passed the right file |
| `NOT_ENOUGH_SIGNATURES` | Fewer good signatures than the trust root asks for | Ask the issuer |
| `KEY_NOT_VALID_FOR_THIS_DATE` | Issued after its key was retired or marked compromised | Ask the issuer for a new one, and treat this file with suspicion |
| `FORMAT_NOT_SUPPORTED` | Issued in a newer format than this release reads | Nothing is wrong with the file. Everything already installed stays as it was |
| `TOO_LARGE`, `FILE_UNREADABLE` | The file could not be read as a document | Check the path and the file |
| `TRUST_ROOT_NOT_CONFIGURED`, `TRUST_ROOT_UNREADABLE` | Exit 2. There is no usable trust root | Check the path and the mount |
| `LICENSE_NOT_VALID` | From `install`: usually a maintenance statement with no license here | Install its license first |

**A trust root inside the folder that a document came from proves nothing.** Keep your own copy, from where it first reached you.

## Who can do what

The service's rule: an owner reads and installs, an administrator reads and installs nothing, and a member gets a refusal on both. The command installs as a service for the organization it names, and the audit log records it with no person. An organization sees only its own documents, and another organization's are not found. The license page in the product, where an owner would see this, is not built yet.

## Keys

A key in the trust root has `retired_on` and `compromised_on`, and no expiry. A document issued on or before that day stays good, and a later one is refused. Retire a key rather than removing it: removing one turns everything it signed `unverifiable` on the license page, and nowhere else. The date checked is the one inside the document, so a stolen key could backdate one, and outside review has this limit on its list.

## What this is not

It is not copy protection. You control the machine and the trust root. A license here is evidence for people who want to know where they stand. What each right means commercially is set by the agreement, and this page holds no terms. Outside security review has not happened.
