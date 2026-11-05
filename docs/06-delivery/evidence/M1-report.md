# M1 evidence report: release skeleton

**Date:** 2026-11-05
**Status: built and tested, but M1 is not closed.** It needs an outside security review and three owner decisions (see [What stops M1 closing](#what-stops-m1-closing)).
**Environment:** one Windows 11 machine with Docker Desktop (Linux containers). CI results on Linux are recorded under [CI on Linux](#ci-on-linux).

This is an empty but secure product. You can sign up, create an organization and see its members. It does no real work yet.

## Results

From a clean stack, using `infrastructure/scripts/run-all-gates.sh`:

| Gate | Result |
|---|---|
| Format and lint, including architecture import rules | Pass |
| Typecheck, strict, all packages | Pass |
| Unit tests | 43 passed |
| Backlog and traceability | Pass: 143 live tickets, 108 traced items |
| Contracts match the specification | Pass |
| License check | Pass: 225 production packages, 4 exceptions for counsel |
| Dependency audit, high and above | Pass: 1 moderate advisory remains (below) |
| Integration tests, real PostgreSQL roles | 36 passed |
| Air-gap control, deliberate attempt | Detected: 7 packets |
| Stack tests with outbound traffic blocked | 33 passed, 1 skipped by design, **0 outbound attempts** |
| SBOMs and signed manifest, verified with no network | Pass: tampered manifest and SBOM both rejected |

## Ticket status

| Ticket | Status | Evidence, or what is missing |
|---|---|---|
| `FOUND-01` Monorepo and CI | **Partial** | Lint, types, tests and CI exist. **Reproducible builds are not proven and images have no vulnerability scan yet** |
| `FOUND-02` Auth, organizations, membership | Verified locally | Two-tenant tests, and real form posts through Server Actions |
| `FOUND-03` Migrations, roles, RLS | Verified locally | Tests run as real roles, with negative controls |
| `FOUND-04` Audit and redaction | **Partial** | Canary absent from logs and Temporal's database. Audit covers two actions so far. OpenTelemetry tracing isn't wired up |
| `FOUND-05` SecretBroker | **Awaiting outside review** | All tests pass, but no real credential may be stored until it is reviewed |
| `FOUND-06` Contract tooling | Verified locally | Runtime, generated and specification schemas agree on valid and invalid fixtures |
| `FOUND-07` License, SBOM, signing | **Partial** | Works with a throwaway key. Needs the owner's custody decision and counsel's review |
| `ID-03` Auth library | Verified locally | Local accounts and an OIDC round trip. See [ADR-025](../../00-foundation/adr/ADR-025-m1-implementation-decisions.md) D1 |
| `PLAT-11` Web image and proxy | Verified locally | Built image behind Caddy with TLS; read-only, non-root |
| `PLAT-12` Temporal worker | Verified locally | Survives web and worker restarts; cancellation works |
| `PLAT-15` Compose stack | Verified locally | No hosted dependency |
| `PLAT-16` Air-gap gate | Verified locally | Zero attempts, with a working control |
| `SEC-10` Secrets in browser output | Verified locally | Test secrets absent from pages, scripts and images |
| `ASSUR-01` No web path to Temporal | Verified locally | Network membership and connect-by-IP, with a worker control |
| `ASSUR-02` Role boundaries | Verified locally | Exact grant checks, which will also catch future tables |

## What testing found

These were found by running things, not by review:

1. **Cross-tenant visibility in a policy.** Someone in two organizations could see their other membership from inside the first. Fixed, with a regression test.
2. **Readable error text in Temporal's database.** Temporal silently ignored the failure converter as first written. Fixed by loading it by path, and a real database scan confirms it.
3. **Confidential text in worker logs.** The Temporal SDK logs activity error messages by default. Replaced with a redacting logger.
4. **An offline hang.** Temporal's CLI does an outside DNS lookup for an internal name and stalls on an isolated network. Found by the air-gap gate.
5. **A shared key in the image.** Each image really does embed a Server Action key. A per-deployment key now overrides it, and the container refuses to start without one.
6. **A deprecated image.** `temporalio/auto-setup` was no longer current. Replaced as Temporal's docs recommend.
7. **An LGPL library in the web image**, unused. Removed.

## Known gaps

- **The UI has not been looked at in a browser.** The browser pane correctly refused the local test certificate. Forms are tested over HTTP, including real Server Action posts, but layout and accessibility are unchecked. The design system is `UX-11` in M2.
- **Moderate advisory:** old `esbuild` through `better-auth` → `drizzle-kit`, concerning esbuild's development server. A check of the built web image found neither `esbuild` nor `drizzle-kit` in it, so this affects developers only. It should still be cleared in M2.
- **Temporal history retention** is 72 hours, a starting value that needs review.
- **Worker image is 720 MB**, against 361 MB for web, because the Temporal worker package brings its bundler at runtime. Worth trimming before Sovereign packaging.
- **Footprint:** about 470 MiB at idle across seven services. This is one idle reading, with no load, so it isn't a sizing guide.
- **Valkey and the object store** run but nothing uses them yet.
- **Replay tests** start with the first business workflow in M2.
- **`temporal-namespace` retention and Temporal database backups** have no recovery test yet (`OPS-02`).

## What stops M1 closing

1. **Outside security review** of ADR-024 D4 and D5, and ADR-025 D1, D2 and D5. No real credential may be stored before this.
2. **Legal entity and jurisdiction.** Owner decision.
3. **Signing-key custody**, including a second holder or escrow. Owner decision.

The repository decision is made: `atmyielts/ensemus`, private.

Work on M2 can proceed with test data while these are open.

## CI on Linux

Not yet recorded. See the pipeline on the `m1-release-skeleton` branch.
