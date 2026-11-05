# ADR-025: Implementation decisions made while building M1

**Status:** Proposed. Implemented in code on 2026-11-05. D1, D2 and D5 need review by the security owner, alongside ADR-024 D4 and D5.
**Date:** 2026-11-05
**Deciders:** Project owner; security owner for D1, D2 and D5.

## Context

Building M1 forced several choices that ADR-024 and the spec left open. Some come from what the tests found, not from design. This records them, so that they can be reviewed instead of being discovered later in the code.

## Decisions

### D1: Better Auth for embedded authentication (ID-03)

Better Auth 1.7.17 provides local accounts and OIDC, running in-process with the web tier.

| Checked | Result | How |
|---|---|---|
| License | MIT | GitHub license metadata |
| Telemetry | Off by default, and set off explicitly | Its docs, plus the air-gap gate |
| Outbound calls | None in the stack tests | Air-gap gate, zero outbound attempts |
| OIDC | Authorization-code flow with PKCE works | Integration test against a mock provider |
| Multi-factor and SAML | Not evaluated yet | Tickets `ID-04` and `ID-05` in M7 |

No alternative library was evaluated in depth, so this is a reasonable choice rather than the result of a comparison. Authentication sits behind `@ensemus/auth`, which limits the cost of changing it.

### D2: A fifth database role, `ensemus_auth`

**This extends ADR-024 D4.** Password hashes and sessions need a role, and giving them to `ensemus_app` would put them one query bug away from tenant code. `ensemus_auth` reaches only the `identity` schema, and `ensemus_app` sees only the `id`, `name` and `email` columns of `identity.users`, filtered by row-level security.

The web process still holds both credentials, so this protects against query bugs, not against code execution in the web tier.

### D3: Self-only policies apply only before a tenant is bound

The first version of `memberships_self` stayed active when a tenant was bound, so someone in two organizations could see their other membership from inside the first. The policy now requires that no tenant is bound. A regression test covers it, and removing the fix makes the test fail.

### D4: Temporal uses `temporalio/server` with `admin-tools`, not `auto-setup`

Temporal's deployment guidance recommends this for production, and `auto-setup` is no longer kept current. Schema changes and namespace creation are one-shot jobs. Namespace history retention is 72 hours, which is a starting value that needs review against the retention policy (`LIFE-02`).

### D5: Three controls for confidentiality in Temporal (ADR-024 D2)

Testing showed that encrypting payloads is not enough on its own:

1. **Input schemas** reject free text before it reaches Temporal.
2. **The payload codec and failure converter** encrypt inputs, results and error messages. The failure converter must be loaded by path: passing it as an object is silently ignored, which would have left error messages readable.
3. **A redacting SDK logger.** The SDK's default logger prints activity error messages. A test run showed a planted secret in its output even though the database was clean.

The scan dumps Temporal's real databases and searches as text, hex and base64. An unprotected control run confirms that the scan finds the planted text.

### D6: gRPC `passthrough` for the Temporal CLI

The Temporal CLI's gRPC resolver looks up `_grpclb._tcp.temporal` over DNS, Docker forwards that outside, and it hangs on an isolated network. The air-gap gate found this by stalling, and a packet capture confirmed the cause. Using `passthrough:///temporal:7233` removes the lookup. **The dispatcher in M2 must also avoid this**, and the gate will catch it if not.

### D7: Server Action encryption key is set per deployment at runtime

This closes the spike in ADR-024, and the concern was real: the build embeds a key in `server-reference-manifest.json`, so everyone with the same image holds the same key. In Next.js 16.4.5, `encryption-utils.js` reads `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` first and only then uses the embedded key. The container entrypoint sets the variable from a mounted secret and **refuses to start without it**, so nothing can silently fall back to the shared key. No action currently captures sensitive values in a closure.

### D8: Ed25519 signing with a throwaway key until custody is decided

The release script signs its manifest with a throwaway Ed25519 key, says so in the manifest's `signing` field, and discards the private key when it ends. `verify-release.mjs` ships in the release folder and needs only Node, so an operator can verify a release on an isolated machine.

This uses Node's built-in crypto, not `cosign`, because pulling the `cosign` image hung on the build machine. That has a real upside, since nothing extra needs downloading to verify a release, and a real cost: there is no registry-attached signature, which some customers' tooling may expect. Revisit this when deciding key custody. Signing covers the manifest, which lists image IDs, and the verifier checks the SBOM digests. It does not yet check that loaded images match those IDs; that arrives with the offline bundle (`COMM-04`).

### D9: Valkey and the object store run, but are not used yet

They are in the stack and health-checked (Phase 0 asks for them), but no code reads or writes them until M2. SeaweedFS was chosen for its Apache-2.0 license, subject to a real evaluation when artifacts arrive (`WORK-04`).

## Consequences

- **Footprint:** about 500 MiB of memory at idle, across seven long-running services and four one-shot jobs. This is an idle reading from one machine, not a sizing recommendation.
- **Tests need Docker.** The security tests are only meaningful against real PostgreSQL roles and real images.
- **Licenses:** the LGPL image library Next.js pulls in is excluded from the web image, because images are unoptimized.
- **Not yet addressed:** workflow replay tests start with the first business workflow in M2. Audit coverage is limited to organization creation and secret storage. OpenTelemetry tracing isn't wired up (`OPS-04`).

## Approvals

| Role | Name | Decision | Date |
|---|---|---|---|
| Project owner | | | |
| Security owner (D1, D2, D5) | | | |
