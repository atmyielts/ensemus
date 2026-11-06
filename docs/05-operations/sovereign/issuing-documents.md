# Issuing signed documents

For the vendor. This tool never ships, and no customer needs it (ADR-030 D3). `tests/unit/issuer-not-shipped.test.ts` follows every import from everything we build, and fails if it could be reached.

**Status: rehearsal only.** It signs with generated keys held in files. Who holds the real keys, and whether a second holder or escrow is needed, is the owner's open decision, and no real key is to be created or used until that is decided and outside security review has happened. Everything it signs is marked as rehearsal, in the register and through the `test_only` flag in the trust root, and a customer's license page says so at the top.

## Build it

```sh
node workers/workflow/scripts/build-issuer.mjs
```

This writes `.local/issuer/issuer.mjs`. `.local` is in `.gitignore` and `.dockerignore`. The tool needs only Node after that.

## What it writes

Every file it writes is owner-only, and it never replaces a file, so a key or a signed document cannot be overwritten by a slip of the keyboard. On Windows file modes do not apply, so keep these in a folder only you can read. The register only ever grows.

## Commands

All of them answer with an exit status: `0` when done, `1` when refused or when a write failed, `2` when an argument or an input file was wrong. Errors name fields, and never print a value.

### `keygen`

```sh
node .local/issuer/issuer.mjs keygen --key-id <id> --purposes <list> --out <private key file> [--trust-root-out <file>]
```

Makes an Ed25519 pair, writes the private key to the file, and prints a trust root entry. `--trust-root-out` also writes a whole trust root holding just this key.

- `--purposes` has no default. Use a comma-separated list of `license`, `maintenance`, `advisory`, `support_policy`, `bundle`, `diagnostic_recipient`. A bundle key should not also sign licenses (ADR-030 D3), which is one of the things outside review is asked to look at.
- **The entry always says `test_only: true`, and there is no flag that writes `false`.** Taking that away needs the custody decision and a new signer. It is not meant to be easy.

### `license`

```sh
node .local/issuer/issuer.mjs license --rights <file> --signer <key id>=<private key file> --rehearsal --out <file> --register <file>
```

**Refuses to run without `--rights`.** Nothing in this tool chooses a right: a missing value is an error, an unknown value is an error, and no value has a default. This repository ships no rights file. One exists only inside a test, as a test value.

Each value below is the owner's decision, per customer, per contract. Nothing here recommends one.

```jsonc
{
  "licensee": {
    "display_name": "<shown to the customer's administrator, at most 200 characters>",
    "contract_reference": "<a reference, and never contract text>",
  },
  "term": { "kind": "<perpetual, or pilot with review_on: YYYY-MM-DD>" },
  "licensed_release": { "line": "<major.minor>", "version": "<major.minor.patch>" },
  "footprint": {
    "organizations": "<a whole number, or null for not stated>",
    "seats": "<a whole number, or null>",
    "production_deployments": "<a whole number, or null>",
    "nonproduction_deployments": "<a whole number, or null>",
  },
  "components": ["<lower_case names, shown and not enforced>"],
  "update_rights": {
    "security_patches_after_lapse": "<none or licensed_line>",
    "major_versions_with_maintenance": "<included or separate_purchase>",
    "releases_published_during_maintenance": "<kept_after_lapse or not_kept>",
    "outside_rights_on_install": "<warn or refuse>",
  },
}
```

The tool adds `license_id`, `issued_at` and the format fields. There is no expiry field and no machine binding to fill in, on purpose (ADR-030 D2). A later signed support policy can add to these rights and never subtract from them, so the narrow value can be widened later with no new license, while a wide one can never be taken back (ADR-030 D5).

### `maintenance`

```sh
node .local/issuer/issuer.mjs maintenance --statement <file> --signer ... --rehearsal --out <file> --register <file>
```

```json
{ "license_id": "<the license's ID>", "starts_on": "YYYY-MM-DD", "ends_on": "YYYY-MM-DD" }
```

Renewing adds one of these. It never touches the license, so a customer's perpetual file never needs replacing.

### `advisory`

```sh
node .local/issuer/issuer.mjs advisory --advisory <file> --signer ... --rehearsal --out <file> --register <file>
```

```json
{
  "advisory_id": "<UPPER-CASE-ID>",
  "severity": "<low, moderate, high or critical>",
  "title": "<at most 200 characters>",
  "summary": "<at most 20000 characters>",
  "affected_versions": ["<major.minor.patch>"],
  "fixed_in_versions": ["<major.minor.patch>"]
}
```

See [advisories.md](advisories.md) for the process.

### `support-policy`

```sh
node .local/issuer/issuer.mjs support-policy --policy <file> --signer ... --rehearsal --out <file> --register <file>
```

```json
{
  "branches": [{ "line": "<major.minor>", "status": "<supported, security_only or end_of_support>" }],
  "security_patches_after_lapse_grant": "<none, licensed_line or any_supported_line>"
}
```

Which branches are supported, and what the grant is, are the owner's decisions. The published shape is in [supported-branches.md](supported-branches.md).

### `verify`

```sh
node .local/issuer/issuer.mjs verify <file> --trust-root <file>
```

Checks any signed document the way a customer's machine does, with public keys only, no clock and no network. Prints its kind, its ID, the keys that count, and whether a test or retired key signed it. It never prints a licensee's name. A file that does not verify is exit `1` with the refusal code. An unreadable trust root is exit `2`.

## `--signer`

`--signer <key id>=<private key file>`, repeated once per signature, for a threshold above one. `--rehearsal` has to be given each time, so a script cannot issue a rehearsal document by accident of its defaults.

## What the tool checks before you get a file

`issueDocument` runs the document through its own schema, signs what the schema returned, so a field it does not know is never signed, and then verifies its own output as a customer would. It refuses if any signature would not verify. It writes `format_version: 1`, and it must keep doing so for anyone whose release cannot read more (ADR-030 D2).

## The register

`--register <file>` is required, and gets one JSON line per document:

```json
{
  "issued_at": "2027-03-01T12:00:00.000Z",
  "purpose": "license",
  "document_id": "<ID>",
  "envelope_sha256": "<hash>",
  "key_ids": ["<key id>"],
  "rehearsal": true
}
```

It holds IDs and hashes and no licensee name. The line is written before the document, because a line with no file is harmless, while a file with no line is a document nobody can account for. If a write of the document fails you get `OUTPUT_NOT_WRITTEN`, and the line stays: that ID never reached anyone.

## The signing port

`DocumentSigner` in `@ensemus/sovereign/issuer` is what a hardware token, a KMS or a second holder would implement: a key ID, a public key and a `sign` function. `createRehearsalFileSigner` is the only implementation. It refuses at runtime unless `rehearsal` is literally `true`.

## Open decisions

These belong to the owner, and to the security owner where marked in ADR-030. This tool waits for them and does not assume an answer:

- Signing-key custody, a second holder or escrow, and thresholds.
- Every value in `update_rights`, and what each customer's contract says.
- Supported branches and major-version rights.

Legal wording is out of scope here. Counsel writes the terms that a license refers to.
