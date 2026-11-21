---
title: Issuing and installing a license
audience: operator
area: op-sovereign
tickets: [SOV-01]
modes: [sovereign]
status: written_untested
sources: [m6-license:workers/workflow/src/sovereign-license-command.ts, m6-license:workers/workflow/src/sovereign-license.ts, m6-license:packages/application/src/licensing.ts, m6-license:docs/05-operations/sovereign/license-and-maintenance.md, m6-license:packages/sovereign/src/envelope.ts, m6-license:packages/sovereign/src/verify.ts, m6-license:packages/sovereign/src/trust-root.ts, m6-license:packages/domain/src/license.ts, m6-license:packages/domain/src/policy.ts, m6-license:packages/config/src/sovereign.ts, m6-license:tests/fixtures/license-corpus/v1/README.md, m6-tools:packages/sovereign/src/issuer.ts, m6-tools:packages/sovereign/src/issuer-cli.ts, m6-tools:workers/workflow/scripts/build-issuer.mjs, m6-tools:tests/unit/issuer-not-shipped.test.ts, m6-tools:docs/05-operations/sovereign/issuing-documents.md, m6-foundation:docs/00-foundation/adr/ADR-030-sovereign-license-and-bundle.md]
tests: []
---

# Issuing and installing a license

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

A Sovereign license is a small signed file. Whoever holds the signing key issues it, and whoever runs the deployment checks it and attaches it to an organization. **Nobody can issue a real license today:** the tool only rehearses, with generated keys, and every document it makes says so.

## What is real today

| Step | State |
|---|---|
| Checking a signed file, with no database and no network | Written, on the `m6-license` branch |
| Attaching a license or maintenance statement to an organization | Written, on the same branch |
| Issuing a document, as a rehearsal with generated keys | Written, on the `m6-tools` branch, in a commit its author marks as a first pass |
| A real signing key | **Does not exist.** Who holds it, and whether a second holder is needed, is the owner's decision. Outside security review has to come first |

A license does not decide whether the software runs. Nothing about one can stop a request, and a lapse changes what an administrator reads. See [Offline upgrades and maintenance lapse](offline-upgrades.md).

## Issuing: for whoever holds the signing key

This tool is for the vendor, and never ships. No customer needs it, and `tests/unit/issuer-not-shipped.test.ts` on `m6-tools` fails if anything we build can reach it. Build it once from the source tree, and after that it needs only Node.

```sh
node workers/workflow/scripts/build-issuer.mjs
```

That writes `.local/issuer/issuer.mjs`. Make a generated key, and a trust root holding only that key:

```sh
node .local/issuer/issuer.mjs keygen --key-id generated-license-key --purposes license \
  --out ./rehearsal/license-key.pem --trust-root-out ./rehearsal/trust-root.json
```

**The trust root entry it writes always says `test_only: true`, and no flag writes anything else.** Removing that needs the owner's custody decision and a new signer. `--purposes` has no default. Give a bundle its own key, not the one that signs licenses.

Then write a rights file and issue the license. **The tool refuses to run without `--rights`, and no value in the file has a default.** A missing or unknown value is an error, and this repository ships no rights file, because each value is the owner's decision, per customer and per contract.

```json
{
  "licensee": { "display_name": "Example Organization", "contract_reference": "EXAMPLE-0001" },
  "term": { "kind": "perpetual" },
  "licensed_release": { "line": "2.0", "version": "2.0.0" },
  "footprint": { "organizations": null, "seats": null, "production_deployments": null, "nonproduction_deployments": null },
  "components": [],
  "update_rights": {
    "security_patches_after_lapse": "none",
    "major_versions_with_maintenance": "separate_purchase",
    "releases_published_during_maintenance": "kept_after_lapse",
    "outside_rights_on_install": "warn"
  }
}
```

The values above show the shape, and they are test values, not an offer or a policy. `term` can also be `pilot`, with a `review_on` date, which shows as a notice and disables nothing. There is no expiry field and no machine binding to fill in, on purpose.

```sh
node .local/issuer/issuer.mjs license --rights ./rehearsal/rights.json \
  --signer generated-license-key=./rehearsal/license-key.pem --rehearsal \
  --out ./rehearsal/license.dsse.json --register ./rehearsal/register.jsonl
```

- `--rehearsal` has to be given each time, so a script cannot issue one by accident of its defaults.
- `--signer` repeats once per signature, for a trust root that asks for more than one.
- The tool never replaces a file, and it checks its own output as a customer would before you get it.
- `--register` is required. It gets one JSON line per document, with IDs and hashes and no licensee name, and the line is written first.
- `maintenance --statement`, `advisory --advisory` and `support-policy --policy` work the same way. See [Security advisories and supported branches](advisories-and-branches.md).

The tool exits 0 when done, 1 when refused or a write failed, and 2 for a wrong argument or input file. Errors name fields and never print a value.

| Code | Why |
|---|---|
| `REHEARSAL_ONLY` | `--rehearsal` was not given. Nothing else signs yet |
| `INPUT_INVALID`, `INPUT_NOT_JSON`, `INPUT_UNREADABLE` | The rights file is missing, not JSON, or has a missing or unknown value |
| `SIGNER_REQUIRED`, `NO_SIGNER`, `SIGNER_REPEATED`, `KEY_UNREADABLE` | The signer is missing, given twice, or not a usable key |
| `DOCUMENT_INVALID`, `SELF_CHECK_FAILED` | Its own schema refused the document, or a signature would not verify, so no file is written |
| `OUTPUT_NOT_WRITTEN` | The document was not written, and its register line stays. That ID never reached anyone |

## Installing: what you need

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
