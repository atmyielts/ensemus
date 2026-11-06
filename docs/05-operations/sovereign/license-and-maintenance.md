# License and maintenance

For operators of a Sovereign deployment. This covers `COMM-03`, `SOV-02` and `SOV-05`, and the reasons are in [ADR-030](../../00-foundation/adr/ADR-030-sovereign-license-and-bundle.md).

**Status:** written with the code, and proved so far only by unit tests with generated keys. Nothing here has run on a real stack, on built binaries, or with a real signing key, and outside security review has not happened. This page makes no statement about how any deployment performs on an isolated network: that is what the [offline acceptance test](../../specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md) is for, and it has not been passed.

## What the documents are

Each is a small signed file. Renewing maintenance adds a file, and never touches the license.

| Document | What it says |
|---|---|
| License | What was bought: the release, the footprint and the update rights. It has no expiry field and no machine binding |
| Maintenance statement | That maintenance runs from one day to another, for one license |
| Advisory | A security notice, with the versions it names |
| Support policy | Which lines are supported. It can add to what a license grants, and has no way to take anything away |

The trust root is a separate file of public keys, delivered to you out of band. Point `ENSEMUS_LICENSE_TRUST_ROOT_FILE` at it. It holds no secrets. Private keys are never in the repository, an image or an environment.

## What a lapse does

**A lapse changes what an administrator reads, and nothing else.** The software keeps running. So do agents, workflows, sign-ins, ordinary work and everything already installed. The same is true of a stopped clock, a missing trust root and a damaged file. No code path refuses a request because of a license, and `tests/unit/no-license-gate.test.ts` fails if one is added.

| What you see | What it means |
|---|---|
| Standing `licensed` | A license is installed, and its signature checks out against this deployment's trust root |
| Standing `unlicensed` | Nothing is installed yet |
| Standing `unverifiable` | Something is installed, and none of it could be checked. Usually the trust root is missing or a key was removed from it |
| `maintenance_lapsed` | The last covered day has passed. A support status |
| `maintenance_not_started`, `no_maintenance` | No agreement covers today |
| `pilot_review_due` | A pilot license's review date has arrived. A date for people to talk, and it disables nothing |
| `signed_with_test_key` | A document this rests on was signed with a generated test key. Treat it as a rehearsal |
| `signed_with_retired_key` | Still good. Issued before its key was retired |
| `clock_before_issue` | This machine's clock reads earlier than the license was issued, so the dates above may be wrong. Fix the clock if you can. Nothing else changes |
| `running_release_outside_rights` | The release running is outside what the license covers. It keeps running, and this affects only the next install |
| `seats_above_footprint` | More active members than the license states. Shown, and never enforced |

A row in the database proves nothing. Every value shown comes from a signed file, checked against the trust root each time it is read, so a row that fails is skipped and never stops the page.

## The command

Both run from the worker image as `node dist/sovereign-license.js`. They print one line of JSON: the standing, IDs, codes and notices. They never print the licensee's name or the file.

```
sovereign-license verify <file> [--trust-root <file>]
sovereign-license install --organization <id> <file>
```

`verify` needs no database and no organization, so it works on a first boot. It reports on that one file alone, so it does not mention maintenance for a license. Without `--trust-root`, it uses `ENSEMUS_LICENSE_TRUST_ROOT_FILE`.

`install` attaches the file to one organization, using the same service identity as other operator commands, and needs `DATABASE_URL_APP` and `ENSEMUS_LICENSE_TRUST_ROOT_FILE`. It uses only that setting for the trust root, so that what it accepts is what the deployment can read back. On a deployment with several organizations, run it for each. Installing the same file again is safe, and reports `"created": false`. A maintenance statement goes in after its license, or it is refused and nothing is stored.

| Exit | Meaning |
|---|---|
| 0 | The file verified. A lapse, a test key or a stopped clock is still 0, with a notice |
| 1 | The file does not verify, or was refused. `reasonCode` says why, and nothing was stored |
| 2 | The question could not be asked: a bad argument, no readable trust root, or a trust root that does not know this file's signer (`UNKNOWN_KEY`). A wrong trust root looks like this |
| 3 | The command could not finish, for instance the database could not be reached. Installing is safe to repeat |

| `reasonCode` | Meaning |
|---|---|
| `BAD_SIGNATURE` | A signature from a known key does not match. The file was changed or damaged |
| `WRONG_PURPOSE` | The key that signed it may not sign this kind of document |
| `KEY_NOT_VALID_FOR_THIS_DATE` | Issued after its key was retired or marked compromised |
| `NOT_ENOUGH_SIGNATURES` | Fewer good signatures than the trust root asks for |
| `FORMAT_NOT_SUPPORTED` | Issued in a newer format than this release reads. Nothing is wrong with the file, and everything installed stays as it was |
| `CONTENT_INVALID`, `MALFORMED`, `WRONG_TYPE`, `TOO_LARGE`, `FILE_UNREADABLE` | It is not one of these documents |
| `LICENSE_NOT_VALID` | From `install`: refused, usually a maintenance statement for a license not installed in this organization |
| `UNKNOWN_KEY`, `TRUST_ROOT_NOT_CONFIGURED`, `TRUST_ROOT_UNREADABLE` | Exit 2. Check the trust root first |

## Who can do what

An owner reads and installs. An administrator reads and installs nothing. A member gets a refusal on both. The operator's command installs as a service for the organization it names, and the audit log records it with no person. Each organization sees only its own documents.

## Keys and rotation

- A key has `retired_on` and `compromised_on`, and no expiry. A document issued on or before that day stays good for ever, and a later one is refused.
- Removing a key from the trust root turns what it signed `unverifiable`, on the page and nowhere else. Retiring a key is what you want. Removing one is for correcting a mistake.
- The date checked is the one inside the document. ADR-030 D3 records what that means if a key leaks. This limit is one of the things outside review has to look at.

## What this is not

This is not copy protection. You control the machine and the trust root. A license here is honest evidence, for people who want to know where they stand, and for support and audit.

What rights mean, and the supported lines, are the owner's open decisions: see [supported branches](supported-branches.md) and ADR-030's open decisions. The wording of any license terms is for counsel, and is not here.

## The frozen corpus

`tests/fixtures/license-corpus/v1/` holds documents signed once, with generated keys whose private halves were thrown away. Every future release has to verify them, and those files are never regenerated. If a change makes `tests/unit/license-corpus.test.ts` fail, the change is what has to move, because a customer who has lapsed may have no way to take a correction.
