# Guides

End-user documentation (`DOC-01`) and operator documentation (`DOC-02`). The specification around this folder says what Ensemus should be. These guides say what it does, so **a guide describes only behaviour someone can find in the code**, and says plainly when nobody has run it yet.

`user/` is for people using Ensemus. The product shows these pages itself, at `/help`, because Sovereign has to read its help with no network. `operator/` is for whoever installs and runs it, and ships with a release.

## Status of a page

Each page states its status in its front matter. [ADR-036](../00-foundation/adr/ADR-036-release-readiness.md) D5 and D6 give the reasons.

| Status | Means | Who sets it |
|---|---|---|
| `not_written` | A stub | The foundation |
| `not_in_product` | The feature is not on any branch yet, and the page says only that | A writer |
| `written_untested` | Written from the code. Nobody has followed it on a running system, and the page says so at the top | A writer |
| `tested` | Each behaviour it describes has a named test that ran in CI | Whoever saw those tests pass |
| `walked_through` | Someone who did not write it followed it from start to finish | Only a person |

## Writing a page

```text
---
title: Approvals                             # the same as the first heading
audience: user                               # the folder it is in
area: work                                   # its section in index.json
tickets: [WORK-05, WORK-07, UX-14]           # what it documents
modes: [cloud, byom, sovereign]              # where it applies
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/approvals/page.tsx]   # what it was read from (a path, or branch:path while it is on a branch)
tests: []                                    # for tested: the tests that prove it
---

# Approvals

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.
```

The banner goes straight after the heading of a `written_untested` page, word for word. `node docs/specifications/tools/check-guides.mjs` checks all of this.

- **The format is small on purpose:** headings to level 3, paragraphs, flat lists, tables, quotes, code blocks, `code`, **bold** and relative links. No raw HTML and no images, because the product renders these same blocks.
- **Nothing outside.** No outside links and no real addresses. Use `@example.invalid` and `localhost` in examples. A guide has to work with no network.
- **No claims without evidence:** no certification, compliance claim, service level, price, recovery number, air-gap claim, absolute or legal term. To say what is *not* claimed, write a negative sentence and end its line with `<!-- not-a-claim -->`. The check refuses that marker on a line with no negative in it.
- **Plain words, for the person reading.** A user guide says what to do and what you will see, and does not explain the architecture. Say what it cannot do, and what a refusal means.

## Coverage

Every backlog ticket up to M8 is named by a page or listed in `coverage-exempt.csv` with its reason. That is checked as well. It shows nothing was forgotten. It does not show a page is right.
