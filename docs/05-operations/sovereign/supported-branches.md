# Supported branches

**This is a template. It states no policy.** It is waiting for the owner's decision, and every value below is deliberately blank. Until it is filled in by the owner and published through a signed support policy, no line is promised any support, and nothing here should be read or repeated as if it did (`SOV-05`, ADR-030 D5).

The signed support policy document is what a deployment reads. This page is the same facts in words, for people. The two have to agree.

## Decisions this waits for

| Decision | Who decides | Where it ends up |
|---|---|---|
| Which lines are supported, and for how long | Project owner | `branches` in the signed support policy |
| Security patches after maintenance lapses | Project owner | `security_patches_after_lapse` in each license, and `security_patches_after_lapse_grant` in the support policy |
| Whether maintenance reaches a new major version | Project owner | `major_versions_with_maintenance` in each license |
| Whether a release published during maintenance stays installable after a lapse | Project owner | `releases_published_during_maintenance` in each license |
| What the install tool does with a bundle outside someone's rights | Project owner | `outside_rights_on_install` in each license |
| Who issues the policy, and when it is updated | Project owner | This page |
| The wording of any commitment made to a customer | Counsel | The agreement, and not this page |

## Supported lines

| Line | Status | Since | Until |
|---|---|---|---|
| _(owner to decide)_ | _(owner to decide)_ | _(owner to decide)_ | _(owner to decide)_ |

The status values a signed policy can use are:

| Value | Meaning |
|---|---|
| `supported` | Maintained |
| `security_only` | Security fixes only |
| `end_of_support` | No further releases |

## Rights

| Question | Answer |
|---|---|
| After maintenance lapses, can security patches be installed? | _(owner to decide)_ |
| Does maintenance include new major versions? | _(owner to decide)_ |
| Can a release published during maintenance be installed after a lapse? | _(owner to decide)_ |
| What happens on installing a bundle outside these rights? | _(owner to decide)_ |

## What stays true whatever is decided

These are how the format works, and filling in this page cannot change them. They concern mechanisms and are not a commercial commitment:

- A policy can add to what a license grants. It has no way to subtract, so a narrow answer today can be widened later without a new license.
- Whether a release is covered rests on the dates signed into the release and the agreements, and moving a clock changes nothing.
- These answers can only affect a **new install**. They never affect the version already running, and a lapse is a support status. See [license and maintenance](license-and-maintenance.md).

## Publishing it

Once the owner has decided: issue the policy with the tool in [issuing documents](issuing-documents.md), ship it in each bundle, and replace each blank above in the same change, with the owner's approval recorded.
