# Security advisories

The process for telling Sovereign customers about a security problem and getting them a fix (`SOV-04`). It works with no connection between us and them: a signed advisory and a signed patch bundle are files, and everything about them can be checked offline.

**Status: rehearsed with generated keys only.** `tests/unit/advisory-rehearsal.test.ts` walks this with generated keys in a unit test. It has not been run on a real deployment or with a real customer, no real key exists, and nothing here is a promise about how quickly anything happens. Response times are the owner's decision, and are not stated here.

## Who does what

The roles below need people. **The owner names them.** No name, on-call rota or response time is filled in here, because none has been decided.

| Role | Does what | Named by the owner |
|---|---|---|
| Triage | Decides whether a report is a real vulnerability and how severe | |
| Fix | Writes and tests the patch on each affected line | |
| Signing holder | Signs the advisory and the bundle, once custody is decided | |
| Customer contact | Gets the files to each customer, by whatever route their site allows | |
| Approver | Decides when it goes out | |

## The steps

1. **Triage.** Confirm the problem, which versions it affects, and its severity (`low`, `moderate`, `high`, `critical`).
2. **Fix.** Make the patch on each affected supported line. Which lines those are is in the signed support policy, and is the owner's decision.
3. **Build a patch bundle.** `build-bundle.mjs` with `release.security: true` and a signed `published_on` (see [offline-bundle.md](offline-bundle.md)). The release's publication date is signed, so nothing a customer's clock says can change what it covers.
4. **Write the advisory** as a file, and issue it (see [issuing-documents.md](issuing-documents.md)):

   ```sh
   node .local/issuer/issuer.mjs advisory --advisory <file> --signer <key id>=<key file> --rehearsal --out <advisory file> --register <register>
   ```

5. **Check before anything leaves**, as a customer would, with public keys and no network:

   ```sh
   node .local/issuer/issuer.mjs verify <advisory file> --trust-root <file>
   ```

6. **Deliver.** A customer's network may have no way in or out, so this is whatever route the contract and their site allow. Nothing in the product fetches an advisory, because it must not phone home.
7. **The customer installs the advisory document**, and verifies and installs the bundle ([license-and-maintenance.md](license-and-maintenance.md), [upgrade-and-rollback.md](upgrade-and-rollback.md)).

## What a customer's machine checks

- The advisory's signature against the trust root they already hold, with a key trusted for `advisory`. A forged, changed, or wrong-purpose one is refused.
- The bundle's signature and every file's hash, with a key trusted for `bundle`, and the trust root taken from them and never from the bundle.
- A test key is shown as a test key.

## Who may install the fix

Rights are worked out from signed documents only, by `evaluateUpdateRight`, on the release's signed publication date:

- A release published during a maintenance period is covered, subject to `releases_published_during_maintenance`.
- A security release after a lapse is covered if the license's `security_patches_after_lapse` says so, or a signed support policy grants it. **A later policy can add to this, and has no way to subtract.**
- Outside those rights, the install tool does what the license says: `warn`, which asks for confirmation and keeps a record, or `refuse`.

**Whether a customer who has lapsed gets security patches is an open owner decision (ADR-030 D5).** The narrow answer is the reversible one, since a later signed policy can widen it for everyone with no new license. Whatever is decided, this only ever concerns a **new install**. It cannot affect the version already running, and nothing here can stop purchased software.

## What the product shows

An installed advisory appears to an owner or administrator on the license page. It is a notice and it changes nothing about what runs. The words in it are whoever issued it, shown as plain text.

## Limits

- A customer's trust root only learns that a key leaked if they take an update, and a lapsed customer may not (ADR-030 D3). A leaked **bundle** key is the one that matters, which is why bundle signing is a separate purpose.
- An advisory on a machine nobody updates stays unread. We cannot reach an isolated machine, and that is the point of it, so what reaches a customer depends on the delivery step and on the people there.
- Who is told first, and what is said publicly and when, is for the owner to decide with counsel.

## Open decisions for the owner

- The names and rota in the table above, and any response time.
- Security patches after a lapse, supported branches, and major-version rights.
- Signing-key custody, without which step 4 stays a rehearsal.
- The route for delivering to each customer, which belongs in that customer's contract.
