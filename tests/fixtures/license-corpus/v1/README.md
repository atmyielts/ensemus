# License corpus, version 1

**These files are never regenerated, edited or reformatted.** A release that cannot read them breaks customers whose maintenance has lapsed, who may have no way to take a corrected release (ADR-030 D2).

Each document was signed once, on 2026-11-06, with a generated key of its own. The private half of each key was held in memory only and thrown away, so nobody can re-sign these files, and a change to any of them fails verification.

Everything in them is a generated test value, including the names, dates, footprints and rights. None of it is a policy, an offer or a term, and every key is marked `test_only`, so these documents say they were signed with a test key wherever they are shown.

| File                       | What it is                                         |
| -------------------------- | -------------------------------------------------- |
| `license.dsse.json`        | A perpetual license                                |
| `pilot-license.dsse.json`  | A pilot license with a review date                 |
| `maintenance.dsse.json`    | A maintenance statement for the perpetual license  |
| `advisory.dsse.json`       | A security advisory                                |
| `support-policy.dsse.json` | A support policy                                   |
| `trust-root.json`          | The public keys that verify them, one purpose each |

A new `format_version` gets its own new folder beside this one. This folder stays as it is. `tests/unit/license-corpus.test.ts` verifies each file and evaluates what it grants.
