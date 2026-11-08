# Exact native lookup operation source checkpoint

Source-only follow-up to preserved payment restore checkpoint `5701649`, on separate `codex/m8-payment-lookup-outcomes`. No formatter, lint, tests, typecheck, install, SQL/application, browser, build, provider call, migration registration or activation has run for this diff. The provider registry stays unconfigured and Cloud stays refused.0512 remains unregistered/unapplied.

## Concrete defect and repair

The previous restore guard compared settlement against the attempt's latest `lookup_restore_generation`. A new lookup could update that shared column before an older returned result was settled. The old result had lost its actual receipt generation. A new admission in the same generation also could not invalidate a retained result reliably.

Five protected columns on the existing `billing.payment_attempts` now hold the exact lookup operation ID, native outcome token digest, normalized fact digest, expiry and consumed transaction ID. No new relation, private body grant, GUC or authority is imported. The existing generation remains distinct from original merchant/config identity. Only the actual fixed pre-I/O admission mints a new random operation UUID and invalidates any earlier unconsumed operation, even in the same generation. It refuses a new lookup once that attempt has a terminal committed outcome. Direct app/agent stamps remain denied. Known committed financial receipts and their exact original namespace remain unchanged.

The gateway captures the actual fixed SQL admission before its single TLS exchange. Its private receipt carries the exact organization, payment, attempt, original execution binding, operation and generation. The tracked native lookup binds the normalized native adapter answer, original key digest and response digest to that receipt. This is a frozen process-local WeakSet proof associated only with the exact returned object; object/JSON copies have no authority. Its age starts at actual receipt observation. No proof factory is exposed, and no WeakSet authority crosses Temporal JSON.

The actual worker's secrets-role attester validates that private proof before the narrow database wrapper. Fixed SQL checks current ready restore generation, exact current operation, attempt/original binding/key and normalized fact before minting a one-use opaque token. App/agent cannot mint it. Settlement consumes that token inside the existing financial effect transaction. The row guard matches the precise effect to the consumed native fact, current operation/generation and actual transaction. A deferred reciprocal guard refuses consumption without the matching financial effect; rollback restores consumption as well as the effect. No timestamp or xmin is INSERT/outcome proof. Best-effort absence, cannot-answer, unknown results and legacy missing authority cannot release debt.

Native adapter parsing and the existing secrets-role broker are explicit trusted code boundaries. SQL validates the exact metadata/fact/one-use effect; it does not independently verify a provider signature or infer merchant identity from an HTTP status. Generated local TLS is synthetic transport evidence, never compatibility with an unselected live processor.

## Customer lookup and restore limits

Customer lookup has no actual native runtime implementation here and receives no borrowed payment lookup nonce/generation. Unknown registration remains unconfirmed. Its original customer transport generation cannot be refreshed to promote a stale confirmation.

The actual0422 strict generation helper is still required, including0515's real material-rotation prerequisite before `identity.begin_auth_restore` can run. Generation checks do not recall admitted remote I/O or prove provider quiescence. Restore must actually stop/drain all native readers/workers before begin; uncertain external operations retain debt for genuine reconciliation. Previously committed financial receipts remain durable. No fake ready/ack/clock or caller-supplied success proof is introduced.

## Authored validation, all unrun

- Generated TLS units retain exact operation/generation on the actual result, deny copies/missing admission, reject best-effort absence authority and retain old generation/operation after a newer generated lookup. SQL admission remains an explicit double in those units.
- Activity-control units require the native proof and real attester port before forwarding a positive token; missing/stale attestation remains retry. Control doubles cannot pass the real broker's brand check.
- Broker control units deny pending/changed generation before tenant scope or token mint, including lookup.
- New `tests/integration/saas-payment-lookups.test.ts` uses actual native generated TLS and real app/secrets roles for positive settlement/committed replay, same-generation stale operation/token refusal, swapped absence fact/foreign tenant, double consume, consumption-without-effect, positive outcome rollback, and app-mint/direct-stamp/cloned-proof denials. Existing native payment reconciliation fixtures now obtain real tokens.
- The exclusive pending-restore fixture now retains actual native lookup proof/token and refuses both after real operator restore begin, alongside identity/webhook/transport paths. It still leaves the owned database pending and supplies no fake ack.

Still owed: exact scoped source gate, fresh SQL/migration/role qualification with0422 and reviewed prerequisites, actual post-ack old-generation result refusal after a fresh lookup, observed driver barriers for concurrent operation/restore boundaries, actual worker stop/drain and external-authority review, and selected native provider contract/security acceptance. The post-ack positive fixture is unavailable until the real0422 review/ack flow is qualified; the new generated unit is explicitly no substitute.

Proposed serialized source gate: explicit changed TS/docs formatting and TS lint; the existing ten payment unit files plus database secrets-restore and workflow webhook-restore units, one worker/no file parallelism; then sequential saas/database/connectors/application/workflows/tests/actual-worker noemit. No DB, SQL registration, build, browser or provider call in that source slot.
