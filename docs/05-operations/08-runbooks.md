# Incident runbooks

These procedures are executable guidance, not completed drills. A commander must establish impact, evidence preservation and the deployment's approved communication channel before mutation. Use deployment-held credentials, never paste secrets into a shell, ticket or chat. Commands below run inside the already installed service image; select the deployment's actual container using its existing operator procedure. `node dist/ops.js` returns 0 for completion, 1 for pending work and 2 for refusal. Unbound capabilities refuse; do not work around them with direct table changes. CLI JSON files contain references and approved public text; keep them private and out of source control.

For reachability, `curl --fail --silent --show-error "$BASE_URL/api/health/live"` and the corresponding `/api/health/ready` are existing routes. The operator must explicitly set the deployment's `BASE_URL`; these commands have no target default. Readiness alone does not prove provider, payment or tenant health. Incident state commands are `node dist/ops.js incident open|roles|update|resolve --file <private-json>`. The schema and exact fields are in `operator-incidents.ts` and [the incident process](09-incident-process.md).

## Database pressure

**Diagnosis:** Check readiness, connection saturation, lock waits and slow-query statistics with the database operator's existing read-only tools. Correlate request IDs and durations without SQL parameters or customer text.

**Reversible mitigation:** Pause optional ingestion and reduce the affected worker's configured concurrency through the deployment's reviewed configuration; preserve accepted outbox events. Roll back the configuration if core reads worsen.

**Safe fallback:** Keep transactional account/support access when reachable; show unavailable or queued work honestly. Never disable RLS or delete queues to restore apparent health.

**Communication:** Open an Ensemus-origin incident with a named commander if core service is affected; publish only approved impact.

**Postcheck:** Recheck readiness, lock pressure and core reads for separate generated tenants. Drain retained backlog and record before/after evidence.

## Temporal backlog

**Diagnosis:** Inspect the configured task queues using the deployment's Temporal UI/tools, worker started/crashed logs and schedule-to-start wait. A missing latency exporter is unknown, not zero.

**Reversible mitigation:** Restore failed workers or reduce incoming optional work. Scale only the congested queue under reviewed limits; preserve workflow IDs and histories.

**Safe fallback:** Existing durable requests stay queued. Do not issue new consequential actions to replace uncertain executions.

**Communication:** Distinguish delayed agents from unavailable business editing. Publish an Ensemus incident only for actual Ensemus impact.

**Postcheck:** Verify a generated workflow resumes once, no duplicate effect occurs, and queue wait recovers. Record the workflow reference privately.

## Model provider outage

**Diagnosis:** Correlate bounded provider failure codes, configured provider health and affected run IDs. Do not print provider responses or prompts.

**Reversible mitigation:** Pause affected agents or reduce concurrency using existing controls. Restore the configured provider only after its policy checks pass.

**Safe fallback:** Keep core editing available. Do not substitute another provider or send restricted content across a new boundary.

**Communication:** Use `origin: model_provider` in `incident open` or the approved origin correction in `incident update`. Do not label the provider outage as Ensemus's.

**Postcheck:** Test the configured provider with generated non-sensitive data, then a bounded agent task. Confirm old uncertain effects were reconciled before resuming.

## Rate limit storm

**Diagnosis:** Inspect retry depth, bounded rate-limit codes and queue delay by provider/connector. Separate throttling from failed credentials.

**Reversible mitigation:** Lower the relevant configured concurrency and allow the existing backoff policy to operate. Keep accepted requests durable.

**Safe fallback:** Show waiting/blocked work; never evade quotas through credential rotation or an unapproved fallback provider.

**Communication:** Identify model-provider, connector-provider or Ensemus origin from actual evidence; use unknown while attribution is unresolved.

**Postcheck:** Confirm retry pressure and normal reads recover without duplicate sends. Record changed settings and the rollback reference.

## Webhook poison events

**Diagnosis:** Inspect `dispatcher.delivery_problem` counts and bounded failure codes. Identify the durable event by its reference using authorized tooling, without dumping its body.

**Reversible mitigation:** Fix the adapter or configuration and use the deployment's reviewed retry procedure for that exact retained event. Do not replay an uncertain consequential effect blindly.

**Safe fallback:** Leave dead/unmatched events retained and observable; no synthetic delivered marker. Keep unrelated events moving.

**Communication:** State the affected integration and delayed processing without including tenant names or payload text in public status.

**Postcheck:** Verify one delivery, tenant routing and no duplicate action; check the dead count again. If no reviewed retry capability exists, escalation remains pending.

## Identity misconfiguration

**Diagnosis:** Check issuer/audience/redirect configuration privately, login failures and two generated tenant sessions. Treat confirmed cross-tenant access as P0 and preserve evidence without reading additional content.

**Reversible mitigation:** Revert the suspect identity configuration or disable the affected entry point through deployment controls. Preserve local authorized recovery access.

**Safe fallback:** Refuse affected sign-ins. Never relax membership checks, RLS or trusted-proxy checks to restore access.

**Communication:** Assign commander and security lead. Report only approved impact; legal and communications decide notifications from evidence.

**Postcheck:** Prove correct login, wrong-tenant denial, session revocation and no shared-cache disclosure before reopening.

## Compromised credential

**Diagnosis:** Identify the credential purpose and observed misuse from bounded audit references. Separate model, connector, storage-ledger, identity and signing-key scopes.

**Reversible mitigation:** Revoke the exact compromised credential with its issuer and replace through the existing secret provisioning process. Halt affected effects while evidence is uncertain. Keep the old reference for investigation; never log its value.

**Safe fallback:** Refuse dependent actions. No bypass of egress, signature verification or sealed-secret checks is permitted.

**Communication:** Page the security lead and commander through the approved channel. Legal decides required notifications; no deadline is invented here.

**Postcheck:** Verify the old credential fails, the replacement reaches only its approved scope, and all unknown effects have an explicit resolution. Signing/ledger compromise also requires restore-evidence review.

## Storage outage

**Diagnosis:** Check object-store availability, `tombstone_ledger.backlog`, `restore_gate.closed`, and the existing diagnostic `node dist/ledger-backlog.js` in the dispatcher image.

**Reversible mitigation:** Restore the storage endpoint/credential configuration. Keep ledger and tenant bytes in their separate permission scopes; preserve the immutable tombstone prefix.

**Safe fallback:** Refuse file delivery when bytes cannot be confirmed. Keep a restored web tier stopped until the reviewed restore procedure has reapplied the deletion ledger; do not clear `RESTORE_PENDING` manually.

**Communication:** Distinguish file access failure from core editing. Tell the commander whether unreplicated deletions remain, using counts only.

**Postcheck:** Run `node dist/ledger-backlog.js` again; follow the existing container deployment runbook's `node dist/reapply-ledger.js` procedure when restoring. Prove a deleted file cannot reappear and a live file still downloads.

## Unknown payment

**Diagnosis:** Inspect the payment's retained state and evidence through authorized billing access. A timeout or lost response does not prove no charge occurred.

**Reversible mitigation:** Stop automated retries for `unknown`; reconcile by exact processor/customer/payment reference using the configured trusted adapter. The current operator CLI does not expose a general payment-resolution command; a reviewed service binding is required for `resolveUnknownPayment`.

**Safe fallback:** Leave the payment unknown and the invoice unpaid until authoritative evidence arrives. Do not submit another charge, change a native idempotency key or mark success manually.

**Communication:** Give the customer the safe payment state via support; keep money, processor payload and account references out of generic logs and public status.

**Postcheck:** Verify one authoritative settlement or explicit not-sent evidence, one journal result and correct credit activation. Preserve the unresolved state if evidence is absent.

## Unmatched payment event

**Diagnosis:** Check the trusted endpoint/connection binding and exact stored customer-reference hash through authorized operator services. A tenant-created endpoint is not billing evidence.

**Reversible mitigation:** Correct the reviewed billing routing configuration, then invoke the durable event handler for that exact event through its existing integration. No general replay CLI is shipped by this slice.

**Safe fallback:** Keep the event unmatched with its safe reason; do not infer the tenant from body text or an email.

**Communication:** Tell the billing operator that settlement is awaiting verified routing. Publish a service incident only for actual service-wide impact.

**Postcheck:** Deliver the event twice in the test fixture and verify one application, exact amount/currency match and no cross-tenant visibility.

## Suspended tenant return

**Diagnosis:** Determine the recorded standing reason, outstanding invoices and the pinned collection policy. Operator, offboarding, quota and provider halts are separate ownership boundaries.

**Reversible mitigation:** Financial recovery uses the reviewed collection recovery binding. An explicitly operator-owned suspension can be restored with `node dist/ops.js tenant resume --file <private-json>` only when its real agent-control binding is installed; it must not release unrelated halts.

**Safe fallback:** Billing, export and support remain accessible in the account surface. Missing policy or agent capability leaves recovery pending, not active by assertion.

**Communication:** Explain the actual safe reason and next needed evidence without promising automatic reactivation.

**Postcheck:** Verify the final standing, preserved rows, correct scoped halt release and continued unrelated budget/provider halts. A paid optional top-up must not be required to recover an unrelated invoice.

## Failed erasure

**Diagnosis:** Inspect `erasure.pending`, `erasure.checked` with `LEFT_OVER`, durable deletion receipts, hold state and the private erasure report. Never interpret RLS-hidden rows as zero.

**Reversible mitigation:** Fix the exact missing capability, ledger receipt or storage failure. Respect holds. Use `node dist/ops.js erase resume --file <private-json>` for a waiting offboarding, or the existing `erase run --file <private-json> --report-file <new-private-path>` for a ready erasure with scoped ports and restricted eraser role.

**Safe fallback:** Leave state `erasing` while rows/bytes/evidence remain. Do not disable append-only triggers, bypass RLS, truncate tables or fabricate a verified report.

**Communication:** Tell the owner what category is pending using safe codes; the report contains counts and explicit retained exceptions. Do not claim backup expiry without the deployment's approved retention evidence.

**Postcheck:** Independently recount every tenant table, verify positive byte removal and published tombstone receipts, preserve the other tenant canary, and confirm deleted memberships cannot reopen content.

At the erasing stage, customer open/reply/close commands refuse under the organization lock; account ticket reads remain available until row deletion. The fixed 0507 support trigger also fences direct application/desk INSERT/UPDATE without granting the desk org/lifecycle data access. It locks the exact organization with `NOWAIT`: an UPDATE may already hold a ticket row, so waiting for org could invert erasure's org→ticket order. Explicit `EN807` becomes the desk's `SUPPORT_CONTENT_BUSY`, CLI exit 1; release the transaction and let a person retry later. There is no sleep, automatic replay, pre-lock helper or extra ticket-read authority. Private control GUCs are restored and application tenant/user bindings remain unchanged. Actual-role contention/restoration verification is still owed.

## Sanitized diagnostic example

These are example shapes, not evidence that an event occurred. The logger adds its own time, level and event envelope.

```json
{"event":"dispatcher.delivery_problem","count":1}
```

```json
{"event":"erasure.pending","reasonCode":"BLOB_PURGE_PENDING","count":1}
```
