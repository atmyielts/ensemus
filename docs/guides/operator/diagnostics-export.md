---
title: The diagnostic export
audience: operator
area: op-sovereign
tickets: [SOV-06]
modes: [sovereign]
status: written_untested
sources: [workers/workflow/src/diagnostics-command.ts, workers/workflow/src/diagnostics-export.ts, packages/sovereign/src/diagnostics.ts, docs/05-operations/sovereign/diagnostics.md, workers/workflow/src/tools/recipient-key.ts, docs/00-foundation/adr/ADR-030-sovereign-license-and-bundle.md, infrastructure/compose/compose.yaml]
tests: []
---

# The diagnostic export

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

A diagnostic report is a short file for you to hand to support. You make it on this machine, you read it, and you decide whether it goes anywhere.

**Nothing here sends anything, and no command can.** The report is a file. Moving it is your own act, by whatever route your site allows, and on a network with no way out that may be a person with approved media. The code is on the `m6-tools` branch, not yet merged. These commands have not been run from an image.

## Step 1: collect

Name a new folder each time, because `collect` never replaces a file. The folder you mount has to be writable by the container's user.

```sh
docker compose -f infrastructure/compose/compose.yaml run --rm --no-deps \
  -v "$PWD/diagnostics:/tmp/diagnostics" dispatcher \
  node dist/diagnostics-export.js collect --out /tmp/diagnostics/report-1
```

It uses the dispatcher's image and database role, which sees event metadata and no tenant content. Exit 0 means it wrote two files:

- `report.json`: the report.
- `review.txt`: every field, one per line, for a person.

## Step 2: read it

**Read `review.txt`.** It is short, and it is there so that you do not have to take any of this on trust.

| Field | What it holds |
|---|---|
| `release_version`, `images` | The release, and each image's digest. Without an installed bundle manifest that verifies, this is `ENSEMUS_RELEASE`, and no images |
| `database.schema_version` | See below |
| `database.reachable`, `database.tenants` | Whether it answered, and how many organizations. A count, with no ID and no name |
| `temporal.reachable`, `object_store.reachable` | Whether each answered a short connection attempt |
| `outbox`, `ledger` | Queued and dead counts, and how long the oldest has waited |
| `configuration` | Each setting on a fixed list, by name, with a SHA-256 of its value, or `null` if unset |
| `error_codes` | Dead events by type, as codes |

If the database did not answer, its counts are zero because they are unknown, and `review.txt` says so at the top.

`database.schema_version` can read three ways. A plain name, such as `0301_sovereign_security`, is the last migration that database ran. `image:0301_sovereign_security` is the last migration this image ships, which is a different statement. The dispatcher's role has no grant to read the migration table today, so expect this form. `unknown` means neither could be read.

The settings on the list are `NODE_ENV`, `ENSEMUS_MODE`, `ENSEMUS_ALLOW_SIGNUP`, `ENSEMUS_CONNECTORS_ENABLED`, `ENSEMUS_RELEASE`, `ENSEMUS_EXPORT_RETENTION_HOURS`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `OBJECT_STORAGE_ENDPOINT` and `OBJECT_STORAGE_BUCKET`.

**A hash can confirm a guess.** Someone who guesses a value can check it against its hash. That is why settings that could say who you are, such as your public address, are left off the list. No secret and no `_FILE` setting is on it.

Work titles, file names, email addresses, organization names, record text, URLs, credentials, and organization or work IDs have no field to sit in. A strict schema holds this, so a new field takes a reviewed code change. A value that does not fit stops the report, rather than being trimmed.

The command does open connections to ask whether they respond, using the dispatcher's database URL and the store's ledger identity. Those values go to the connection, and nowhere else.

## Step 3: seal it, if you decide to send it

You need the recipient's public key, from them, by a route you trust. Whoever receives reports makes the pair with `recipient-key.mjs`, which writes the private key to a file and prints only the public half. Check that the key ID shown is the one they gave you.

```sh
docker compose -f infrastructure/compose/compose.yaml run --rm --no-deps \
  -v "$PWD/diagnostics:/tmp/diagnostics" dispatcher \
  node dist/diagnostics-export.js seal \
  --report /tmp/diagnostics/report-1/report.json \
  --recipient "$RECIPIENT_PUBLIC_KEY" \
  --approved-by "A. Example"
```

**Running this with your name is the approval.** It records the SHA-256 of those exact bytes and the recipient's key ID, puts that inside the sealed file with the report, and writes `report.json.sealed` beside the report, or to `--out` if you name a file. Only the holder of the matching private key can open it. `seal` opens no connection and reads no secret.

Sealing proves who can read the file, not who wrote it, so `approved_by` is what the sender typed, and is no proof of identity.

## When it refuses

Exit 1 means a value or a report was refused, and exit 2 means a bad argument or a file already there. The log line gives the code, and nothing is written or sealed.

| Code | Why | What to do |
|---|---|---|
| `VALUE_REFUSED` | A collected value did not fit its field, so no report was written | Do not work around it. Tell support the field named in the log |
| `APPROVAL_MISSING` | No `--approved-by`, or a blank or over-long one | Name who approved it |
| `REPORT_REFUSED` | The file is not exactly what `collect` writes: a field added, a value that does not fit, or changed spacing | Collect again. An edited report cannot be sealed |
| `RECIPIENT_REFUSED` | Not an X25519 public key | Check the key they gave you |
| `OUT_EXISTS` | A report or sealed file is already there | Use a new folder or file name |
| `OUT_REQUIRED`, `REPORT_REQUIRED`, `RECIPIENT_REQUIRED` | An argument is missing | Add it |
| `REPORT_UNREADABLE`, `OUT_NOT_WRITTEN` | The file could not be read or written | Check the path and that the container's user can use the folder |

The library behind it also refuses an approval for another report (`APPROVAL_FOR_ANOTHER_REPORT`) or another recipient (`APPROVAL_FOR_ANOTHER_RECIPIENT`). So a changed report needs a new approval.

A report covers the whole deployment, as counts, and shows nothing that lets one organization read another's. An organization has no way to start one, because this is the operator's command.

What support does with a report, and how you reach them, is set by your agreement.
