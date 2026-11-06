# Diagnostic export

A report you can hand to support, built so that nothing about your business can be in it (`SOV-06`, ADR-030 D12). It is written on this machine, for you to read. **Nothing here sends anything. Moving the file is your own act.**

**Status:** unit-tested with generated values. `tests/integration/diagnostics.test.ts` is written and has not run, and no run has happened on a real deployment. The commands below are what the image is meant to run, and they have not been run from an image yet.

## 1. Collect

```sh
compose run --rm --no-deps -v "$PWD/diagnostics:/tmp/diagnostics" dispatcher \
  node dist/diagnostics-export.js collect --out /tmp/diagnostics/report-1
```

It uses the dispatcher's image and role because that role sees event metadata and no tenant content (ADR-024 D4). The folder you mount has to be writable by the container's user.

This writes two files, and it never replaces either, so what you read is what is there when you come to approve it. Name a new folder each time.

- `report.json`: the report.
- `review.txt`: every field of it, one per line, for a person.

**Read `review.txt`.** It is short, and it is there so that you do not have to take any of this on trust.

## What is in a report

Every field is a version, a count, a code or a hash, in a strict schema (`diagnosticReportSchema`). A new field needs a reviewed code change. **A value that does not fit stops the report, and nothing is written.** It is never trimmed to fit, because something unexpected in a field is exactly what must not go out.

| Field | What it holds | Where from |
|---|---|---|
| `release_version`, `images` | The release, and each image's digest | The installed bundle manifest, once verified against your trust root. Otherwise `ENSEMUS_RELEASE`, and no images |
| `database.schema_version` | A migration's name | See below |
| `database.reachable`, `database.tenants` | Whether it answered, and how many organizations. A count, with no ID and no name | The dispatcher's role |
| `temporal.reachable`, `object_store.reachable` | Whether each answered | A short connection attempt |
| `outbox`, `ledger` | Queued and dead counts, and how long the oldest has waited | The dispatcher's role |
| `configuration` | Each setting on a fixed list, by name, with a SHA-256 of its value, or `null` if unset | The environment |
| `error_codes` | Dead events by type, such as `outbox.dead:work.execution_requested` | The dispatcher's role |

If the database did not answer, its counts are zero because they are unknown, and `review.txt` says so at the top.

### `database.schema_version`

- A plain name such as `0301_sovereign_security` is the last migration that database ran.
- `image:0301_sovereign_security` is the last migration **this image ships**, which is a different claim, and it is marked so that nobody reads it as the first. The dispatcher's role has no grant on `drizzle.__drizzle_migrations` today, so this is what you will see until one is added.
- `unknown` means neither could be read.

### Settings

Only these are named, each with a hash and never a value: `NODE_ENV`, `ENSEMUS_MODE`, `ENSEMUS_ALLOW_SIGNUP`, `ENSEMUS_CONNECTORS_ENABLED`, `ENSEMUS_RELEASE`, `ENSEMUS_EXPORT_RETENTION_HOURS`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`.

A hash lets support ask "has this changed" without seeing the value. **It can also confirm a guess**, so a setting that could say who you are, such as your public address, is left off the list. No secret is on it, and no `_FILE` setting, and a test holds the list to that.

`release_version` is the one setting shown as itself, as `ENSEMUS_RELEASE`, and only if it fits the code format.

### Secrets

The report's code never reads a secret. The command does open connections in order to ask whether they respond, using the same `readSecret` every worker uses: the dispatcher's database URL and the store's ledger identity. Those values go to the connection and nowhere else. A connection that fails is logged as a code, because an error's message can quote SQL and parameters.

### What is never in it

Work titles, file names, email addresses, tenant names, record text, URLs, credentials, and organization or work IDs have no field to sit in. A test puts a canary in each of the places a command could find one, and looks for it in `report.json`, `review.txt` and the logs.

## 2. Seal, if you decide to send it

You need the recipient's public key, from them, by a route you trust. Check that the key ID this prints is the one they gave you.

```sh
compose run --rm --no-deps -v "$PWD/diagnostics:/tmp/diagnostics" dispatcher \
  node dist/diagnostics-export.js seal \
    --report /tmp/diagnostics/report-1/report.json \
    --recipient <their public key> \
    --approved-by "<your name>"
```

Running this with your name is the approval. It makes a `TransferApproval` with the SHA-256 of those exact bytes and the recipient's key ID, puts it inside the sealed file with the report, and writes `report.json.sealed` beside the report (or to `--out <file>`). Only the holder of the matching private key can open it. `seal` opens no connection and reads no secret.

**It sends nothing, and there is no command that does.** Moving that file is yours to do, or not, by whatever route your site allows. On a network with no way out, that may be a person with approved media.

### What it refuses

| Code | Why |
|---|---|
| `APPROVAL_MISSING` | No `--approved-by`, or a blank or over-long one |
| `REPORT_REFUSED` | The file is not exactly what `collect` writes. A field added, a value that does not fit, or even changed spacing, since JSON has room to hide things from a reader in whitespace or a repeated key |
| `RECIPIENT_REFUSED` | Not an X25519 public key |
| `OUT_EXISTS` | A sealed file is already there, and it will not be replaced |

The library also refuses an approval naming another report (`APPROVAL_FOR_ANOTHER_REPORT`) or another recipient (`APPROVAL_FOR_ANOTHER_RECIPIENT`). A changed report needs a new approval.

## For whoever receives it

`openTransfer` from `@ensemus/sovereign/diagnostics` opens the file with the private key, and checks that the approval inside names these exact bytes and this key.

**Sealing proves who can read it, and not who wrote it**, since anyone with a public key can seal (ADR-030 D6). So `approved_by` is what the sender typed, and is no proof of identity.

## Exit status

`0` when done, `1` when a value or a report was refused, `2` when an argument was wrong or a file was already there.
