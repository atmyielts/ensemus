---
title: Security advisories and supported branches
audience: operator
area: op-sovereign
tickets: [SOV-04, SOV-05]
modes: [sovereign]
status: written_untested
sources: [m6-license:packages/application/src/licensing.ts, m6-license:workers/workflow/src/sovereign-license-command.ts, m6-license:packages/domain/src/license.ts, m6-license:packages/sovereign/src/documents.ts, m6-license:docs/05-operations/sovereign/supported-branches.md, m6-license:docs/05-operations/sovereign/license-and-maintenance.md, m6-tools:packages/sovereign/src/issuer.ts, m6-tools:tests/unit/advisory-rehearsal.test.ts, m6-tools:docs/05-operations/sovereign/advisories.md, m6-bundle:workers/workflow/src/tools/install-bundle.ts, m6-foundation:docs/00-foundation/adr/ADR-030-sovereign-license-and-bundle.md]
tests: []
---

# Security advisories and supported branches

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**This page holds no policy.** Which lines are supported, for how long, and who may install a security patch after maintenance lapses, are the owner's decisions and have not been made. Once they are, the agreement and a signed support policy state them. This page says what the software can do with those documents.

No advisory has been issued, and no support policy has been published. Every signed document that exists today is a generated test file.

## What exists

| Part | State |
|---|---|
| The advisory and support policy formats, and verifying them with no network | Written, on `m6-license` |
| Attaching them to an organization with the operator's command | Written, on `m6-license` |
| Working out what a support policy adds to a license | Written, on `m6-license` |
| Issuing an advisory or a support policy, as a rehearsal with generated keys | Written, on `m6-tools`. See [Issuing and installing a license](license-issuance.md) |
| A rehearsal of a signed advisory and a patched bundle | A unit test on `m6-tools` walks it, with generated keys. **Nothing has run on a real deployment or with a real customer** |
| The page that shows advisories to an administrator | **Not built** |
| Named people, response times and a delivery route | **Not decided.** No name, rota or response time exists, and the owner has to set them |

## What an advisory is

An advisory is a signed file with an ID, a severity of `low`, `moderate`, `high` or `critical`, a title, a summary, the versions it affects and the versions that fix it. It reaches you the way a license does, because the product fetches nothing. Whoever issues it decides how it gets to you, and your agreement says who that is.

Check it and attach it with the same command as a license. The command works out the kind of document from the file itself.

```sh
docker compose -f infrastructure/compose/compose.yaml run --rm --no-deps \
  -v "$PWD/license:/license:ro" \
  worker node dist/sovereign-license.js verify /license/advisory.dsse.json \
  --trust-root /license/trust-root.json

docker compose -f infrastructure/compose/compose.yaml run --rm --no-deps \
  -v "$PWD/license:/license:ro" \
  -e ENSEMUS_LICENSE_TRUST_ROOT_FILE=/license/trust-root.json \
  worker node dist/sovereign-license.js install \
  --organization 00000000-0000-4000-8000-000000000002 /license/advisory.dsse.json
```

A good `verify` exits 0 and prints `"type":"advisory"`, the advisory's ID, and `"standing":null`, because an advisory says nothing about a license. A good `install` prints `"created":true`, or `"created":false` for a file it already holds. Attach it to each organization that should see it.

When the service reads advisories back, it checks each signature again, shows the newest first, and lets a reissue under the same ID replace the older one. It also says whether the running release is one the advisory names, when it knows the running release.

An advisory changes nothing by itself. It stops nothing and installs nothing. Acting on it, which usually means [installing a patched bundle](offline-upgrades.md), is your decision. An advisory on a machine nobody updates stays unread, because nothing can reach an isolated machine from outside.

## What a support policy is

A support policy is a signed file that lists lines, each with a status of `supported`, `security_only` or `end_of_support`, and one grant, `security_patches_after_lapse_grant`, of `none`, `licensed_line` or `any_supported_line`.

**A policy can add to what a license grants, and has no way to take anything away.** So a narrow answer can be widened later, with no new license and no contact with you.

These are the values the owner has to decide. The format carries them, and no code chooses them:

| Value | Where it lives | What it controls |
|---|---|---|
| `security_patches_after_lapse` | Each license | Whether security patches on the licensed line can be installed after a lapse |
| `major_versions_with_maintenance` | Each license | Whether maintenance reaches a new major version |
| `releases_published_during_maintenance` | Each license | Whether a release published while maintained stays covered after a lapse |
| `outside_rights_on_install` | Each license | Whether the install tool warns or refuses for a bundle outside these rights |
| `branches`, `security_patches_after_lapse_grant` | The signed support policy | The lines, and the grant to everyone |

Whether a release is covered rests on dates signed into the release and the maintenance statements, so moving a clock cannot grant one. These values only ever concern a new install, and they cannot affect the version already running. A bundle carries its signed support policy in `support-policy/`, and `install-bundle.mjs` reads it from there.

## When it refuses

- **A forged or changed advisory** gets the same refusals as a license: `BAD_SIGNATURE`, or `UNKNOWN_KEY` with exit 2 when your trust root does not know the signer. Nothing is stored. The full list is in [Issuing and installing a license](license-issuance.md).
- **A row written directly into the database** is not an advisory. Each one is checked when read, and one that fails is skipped without a word on the page.
- **An advisory signed with a generated test key** verifies, and shows `testKey: true` and the notice `signed_with_test_key`. Treat it as a rehearsal.
- **A bundle manifest given to this command** is refused with `WRONG_TYPE`, because a bundle has its own tool.
- **Who can read:** an owner and an administrator can read advisories, and a member is refused. Only an owner or the operator's command can attach one. Another organization's are not found.

## What to ask

Patch rights, supported lines and how long any of them run are set by your agreement. If it does not answer them, ask whoever you bought from. Do not infer an answer from this page, from a status value, or from a test file. Counsel has not reviewed any wording here.
