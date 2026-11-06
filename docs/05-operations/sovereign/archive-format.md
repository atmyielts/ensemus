# The organization archive format

Your data is yours, and getting it back should need nothing from us (`COMM-05`, ADR-030 D7). This page describes an archive fully enough to write your own tool, in any language. Two tools come with the product and run with only Node:

- `recipient-key.mjs` makes the key pair.
- `open-archive.mjs` opens an archive and checks every hash.

```sh
node recipient-key.mjs --out <file for the private key>
node open-archive.mjs --archive <file.tar> --key-file <private key> --out <folder that does not exist>
```

`recipient-key` prints the public key, which you give to whoever exports, and its ID. The private key goes to the file you name, readable only by you, and is never printed. On Windows, file modes do not apply, so keep it in a folder only you can read. **If that file is lost, so is what was sealed to it.** Nobody else holds a copy.

`open-archive` works in a folder beside the one you name, which takes that name only once everything has checked out. So a folder with that name is always a whole archive, and a refused archive leaves nothing. It prints counts and IDs. Exit status is `0` when opened, `1` when the archive was refused, `2` for a bad argument, an unreadable key, or a folder that already exists.

**Status:** both tools are unit-tested with generated keys and hand-built archives. Opening an archive made by a real export depends on the export slice, and has not been run end to end. This construction has not had its outside security review (ADR-030 D6).

## The outer layer: plain tar

An archive is a POSIX ustar file, which your ordinary `tar` reads. Each regular file is a 512-byte header, its bytes, and zero padding up to a whole block, and two zero blocks end the archive.

- Only regular files, with type `0`. Names are up to 100 bytes, with no prefix field.
- Names are IDs and record kinds, so this layer shows counts and sizes, and no names from your business.

An archive that has no end marker was cut off. Refuse it.

| Name in the tar | What it is |
|---|---|
| `manifest.json.sealed` | The manifest, sealed |
| `<section>/<kind>-<NNNNNN>.jsonl.sealed` | A page of records, sealed |
| `artifacts/<uuid>.bin.sealed` | One file's original bytes, sealed |

**Treat an archive as hostile however it reached you**, since anyone with your public key can make one. A name that is not exactly one of those shapes is to be refused. Do not try to clean it up, and do not join it to a path first. The shapes, as regular expressions:

```text
manifest.json.sealed
^([a-z-]+)/([a-z_]+-\d{6}\.jsonl|[0-9a-f-]{36}\.bin)\.sealed$
```

A `.bin` part is only valid in `artifacts/`, and its name has to be a UUID. The section has to be one of: `organizations`, `people`, `clients`, `projects`, `work`, `relations`, `artifacts`, `history`, `connections`, `tombstones`, `audit-redacted`, `knowledge`, `agents`, `skills`, `policy`, `custom-objects`.

## A sealed object

Each file in the tar is sealed separately, to one X25519 public key. **Open it like this, and nothing is to be used unless all of it authenticates.** All numbers are big-endian.

```text
"ensemus.sealed/v1\n"    18 bytes, the magic
header length            4 bytes, unsigned, at most 4096
header                   JSON, as long as that says
ciphertext               the rest, up to the last 16 bytes
tag                      the last 16 bytes
```

The header holds:

```json
{
  "recipient_key_id": "<32 hex characters>",
  "ephemeral_public_key": "<SPKI DER, base64>",
  "nonce": "<12 bytes, base64>"
}
```

To open one:

1. `shared` = X25519 of your private key and `ephemeral_public_key`.
2. `key` = HKDF-SHA256, 32 bytes, with `shared` as the input keying material, the ephemeral public key's SPKI DER followed by your public key's SPKI DER as the salt, and `ensemus.sealed/v1` as the info.
3. Decrypt with AES-256-GCM, using that `key`, the `nonce`, the tag, and the magic followed by the header bytes, exactly as they appear, as additional authenticated data.

A key ID is the first 32 hex characters of the SHA-256 of a public key's SPKI DER. The header says which key an object is for, so you can tell someone which one they are missing.

Keys are SPKI DER in base64 for a public key, as `recipient-key` prints, and PKCS#8 PEM for a private key, as it writes.

A plain object is at most 32 MiB, so no tool has to hold more than that at once for a part. Each object has its own ephemeral key.

## The manifest

Open `manifest.json.sealed` first, and read it before anything else. It is JSON:

```json
{
  "format": "ensemus.organization_export",
  "schema_version": 1,
  "export_id": "<uuid>",
  "organization_id": "<uuid>",
  "exported_at": "<time>",
  "snapshot_at": "<time>",
  "tombstones_through": "<time>",
  "initiated_by_membership_id": "<uuid>",
  "source_release": "<version>",
  "scope": "standard",
  "excluded": { "restricted_work": 0, "restricted_artifacts": 0, "restricted_clients": 0 },
  "sections": { "<section>": { "...": "totals for that section" } },
  "parts": [
    {
      "path": "<the name in the tar>",
      "section": "<its section>",
      "records": 0,
      "plaintext_sha256": "<64 hex characters>",
      "sealed_sha256": "<64 hex characters>",
      "sealed_bytes": 0
    }
  ],
  "encryption": { "scheme": "ensemus.sealed/v1", "recipient_key_id": "<32 hex characters>" }
}
```

The manifest's rules are `exportManifestSchema` in `packages/contracts/src/portability-records.ts`. A `schema_version` above what your tool reads means a newer export, and should be refused by name rather than guessed at.

`excluded` says how much was left out: restricted work and what only it links to stays out of an archive by design, and is counted, so nothing is missing silently (ADR-030 D10).

## Checks a tool should make

Before writing anything:

1. Every name in the tar is a valid shape, and none appears twice.
2. The manifest opens. The tar's parts are **exactly** the manifest's `parts`: no part without an entry, and no entry without a part.
3. Each part's `section` is the first segment of its `path`.

Then, for each part:

4. Its size is `sealed_bytes`, and the SHA-256 of its sealed bytes is `sealed_sha256`.
5. It opens with your key, and the SHA-256 of the plain bytes is `plaintext_sha256`.

## What is inside a part

- A `.jsonl` part holds one JSON object per line. Each line is a record, with the fields in `packages/contracts/src/portability-records.ts`, and no record has an organization ID. Which fields a kind of record has can change between schema versions.
- A `.bin` part is one file's original bytes. Its name and details are in an `artifact` record, where `sha256` is that file's hash.
- `tombstones/` lists what was deleted. It was read last, up to `tombstones_through`. **Anything named there was revoked, so do not bring it back into a system of record.**
- `audit-redacted/` holds a redacted form of the audit trail.
- Credentials, connection configuration, search chunks and embeddings are never in an archive. Secrets have no field to sit in, and derived data is rebuilt.

## What this does not promise

- **Sealing shows who can read an archive, and not who wrote it.** An archive you did not ask for proves nothing.
- **It is a copy you hold.** We cannot reach into it, and if something is deleted after an archive was made, that copy still holds it.
- There is no consistent snapshot across a long export. Parts are read in order, so a relation may point at something that changed during it.

## Trying it

`tests/unit/advisory-rehearsal.test.ts` builds archives by hand with these rules, including every refusal above, and is a working example to read alongside this page.
