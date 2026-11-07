# Importing an organization archive

**Status:** written and unit tested. Nothing here has run against a real deployment or a real database. The integration tests are written and have not passed yet, because they need migrations `0300` and `0301` in the journal, which the final merge stitches. This guide makes no claim about any deployment. The format is in [ADR-030](../../00-foundation/adr/ADR-030-sovereign-license-and-bundle.md) D6 to D10, and outside security review of parsing a hostile archive has not happened.

An import reads one archive into **one new, empty organization**. It runs as an operator's command, not from a page, because opening an archive needs the private key, and that key has to stay in one short process that you control.

## What you need

- The archive, as a file.
- The private key that matches the public key the export was sealed to, as a file you mount for this command. It is read once and given only to the code that opens the archive. It does not reach a log, an error, a table, an environment variable or Temporal.
- A new organization, with its one owner and nothing in it. That owner has asked for the import on the organization's `data` page, which gives you the import's ID.

## Running it

```sh
node dist/organization-import.js \
  --organization <organization id> \
  --import <import id> \
  --archive <path to the archive> \
  --key-file <path to the private key>
```

It prints one line of JSON with the import's ID, its status, a failure code if there was one, and counts by record kind and by warning. It prints no names.

| Exit | Means |
|---|---|
| `0` | Completed. Read the warnings, if there are any |
| `1` | Failed, or the import is not in a state to run. The output has a code |
| `2` | Refused to start because of the command itself: a missing option, an ID that is not an ID, or a file it could not read. Nothing was touched |

### If it fails

Run it again with the same archive. Every page it finished was recorded in the same transaction that applied it, so nothing is applied twice. A different archive is refused with `TARGET_NOT_EMPTY`, because that would be merging two archives into one organization. If it failed before anything was applied, the owner may also ask for a new import.

| Code | What happened | What to do |
|---|---|---|
| `ARCHIVE_UNREADABLE` | The file is not a whole tar this tool accepts: cut off, a symbolic link inside, a damaged header | Get a fresh copy of the archive |
| `WRONG_KEY` | The key file cannot open it. The command names the key the archive is sealed for, as a short hash | Use the matching private key |
| `MANIFEST_INVALID` | The manifest is missing, malformed, or does not match the files present: an extra entry or a duplicate | Treat the archive as damaged or altered |
| `PART_MISSING` | The manifest lists a part that is not there | Same |
| `PART_CHANGED` | A part's size or hash differs from the manifest, or a file's bytes differ from its own record | Same |
| `PATH_REFUSED` | A name in the tar is not one this format makes | Same. An export never writes one, so ask where this file came from |
| `RECORD_REFUSED` | A record failed its schema, is too large, is in the wrong section, or the database refused a value | Same |
| `FORMAT_NOT_SUPPORTED` | The archive comes from a newer release, with a schema version this one cannot read | Import it on a release that can |
| `TARGET_NOT_EMPTY` | Something is in the organization that this import did not put there, or a different archive was given after a partial run | Use a new organization |
| `STORE_UNAVAILABLE` | The object store or the database could not be reached, or the source ledger could not be read | Fix that and run it again |

An archive is checked completely before the first record is written, so most of these leave the organization as it was. Only an outage or a file changed underneath the run can stop one partway.

### If the process died

A power cut or a killed process leaves the import `running`, and a `running` import cannot be run, because that is what stops two at once. Once you are sure no process is still working on it, say so:

```sh
node dist/organization-import.js --organization <id> --import <id> --interrupted
```

That moves it to `failed` with no code, and you can run it again as above. Nothing checks your word, so do not say this while a run is going.

## What an import does not do

**It starts nothing.** No workflow starts, and no event is written that a workflow listens to. Work that was moving when it was exported comes in as `blocked` for a person to look at, and work that was queued, ready or finished keeps that status. No run is recorded on any work.

**History stays history.** Approvals, decisions, status changes, external actions, receipts and audit events go to a read-only table, and can be read by work on the `data` page. They are never made live, so a send or an approval cannot be repeated here, and nothing says the person who ran the import decided what someone else decided.

**It makes no accounts.** Each person in the archive becomes a row you can see on the `data` page. Their role at the source grants nothing. What they owned is held by whoever asked for the import, and the history for that work says so. Who created imported work or a file is left empty unless that person was already linked when it came in, because naming the stand-in would be false.

**Connections come back switched off, with no credential.** An archive holds none. Someone authorized binds a new one.

**It keeps the organization's own name and mode.** The owner named this organization when they made it, and an archive does not change that.

### Bringing people in

Invite each person in the ordinary way. Once they have joined, an owner links them to who they were at the source. That moves the work they owned from the stand-in to them, one audited reassignment at a time, and puts them back on the work and teams they were on. It grants no role, so they keep the one they were invited with, whatever they had before. A person is linked once. Work someone has since moved to someone else stays where it is.

## Warnings

| Code | What it counts |
|---|---|
| `RESTRICTED_EXCLUDED_AT_SOURCE` | Restricted work, files and clients the export left out, which are not in the archive at all |
| `TOMBSTONED_SKIPPED` | Files that were not brought in because they had been deleted |
| `PERSON_NOT_LINKED` | Each place a person was referred to who is not linked yet, so a person with ten pieces of work counts ten |
| `CONNECTION_NEEDS_CREDENTIAL` | Connections brought in switched off |
| `SECTION_NOT_SUPPORTED` | Parts of a section this release has no way to read. They were left out |
| `BYTES_MISSING` | A file's record with no bytes in the archive. It was left out |
| `RELATION_DANGLING` | A link that pointed at nothing in the archive, or that would have closed a loop, which was dropped. In an honest archive this means something was deleted or left out at the source. On a hostile one it is what stopped the link reaching out |
| `WORK_PAUSED_ON_IMPORT` | Work brought in as `blocked` rather than as it stood, or whose plan this release cannot run |

A team or a Work Unit whose parent is in a later page of the same section also loses that link and counts under `RELATION_DANGLING`, because a link can only be made to something already here, and a page is its own transaction. Inside one page the order does not matter. So this can only happen to a tenant with more teams or work than fit in one page, where a child was written before its parent.

## Deleted things stay deleted, up to a limit

Before anything else, the import reads every tombstone in the archive, and every entry in the source organization's tombstone ledger **if this object store holds it**. A file named by either gets no row and no bytes, and the new organization gets its own tombstone and ledger entry, so a later restore here keeps it gone too.

**The limit, plainly:** on another deployment, the source's ledger is not in this store. There, the import knows only what the archive knew when it was made. A file deleted at the source after the archive was made will come back if you import that archive somewhere else, and nothing here can detect that. An archive is a copy you hold, and this cannot reach into it. If that matters, make a new export after the deletion and destroy the old copy, and an archive in the store is already refused for download once anything is deleted after it was made.

A source ledger entry that cannot be read still keeps its file out, since its name says what it is about. If the ledger cannot be listed at all, the import stops with `STORE_UNAVAILABLE`, because going on would be guessing.

## What this does not prove

Sealing proves who can read an archive, not who wrote it, since anyone with the public key can seal. So every archive is treated as hostile however it arrived. Nothing in a record can name a tenant, row-level security holds as for anything else, and a foreign ID simply finds nothing. That is what this was built and unit tested to do. It has not had outside review, and this guide says nothing about whether any particular deployment is isolated or ready for any particular use.
