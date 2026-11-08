# Reviewed proof inventory and historical payment referents — source only

This additive0518 slice follows the material/payment dependency review. It does not register/apply SQL,
activate delegated authority, configure a processor, execute an erasure, or qualify any provider. No
source checks have run on this checkpoint yet. Registered0508 and0512 SQL remain unchanged.

## Historical financial references

The original financial rows already retain the exact original tenant/connection/endpoint/delivery/secret
UUIDs and native identity/config/request/response hashes. No duplicate retained key catalog is needed.
0518 removes only sixteen FKs that permanently pinned those live private bodies. It never rewrites or
nulls an original UUID/hash, deletes financial evidence, retains secret ciphertext, changes a payment
status, adds a role/table grant, or exempts a content table from erasure. Financial-to-financial and
inbox constraints remain. The schema mirrors exactly these FK removals.

| Table | Removed live-body FK names |
| --- | --- |
| `billing.payment_identity_attestations` | `payment_identity_connection`, `payment_identity_secret` |
| `billing.payment_execution_bindings` | `payment_execution_connection`, `payment_execution_secret` |
| `billing.payment_webhook_events` | `payment_webhook_delivery`, `payment_webhook_endpoint`, `payment_webhook_connection`, `payment_webhook_api_secret` |
| `billing.payment_webhook_bindings` | `payment_webhook_binding_endpoint`, `payment_webhook_binding_connection`, `payment_webhook_binding_credential`, `payment_webhook_binding_signing` |
| `billing.payment_webhook_attestations` | `payment_webhook_attestation_delivery`, `payment_webhook_attestation_endpoint`, `payment_webhook_attestation_connection`, `payment_webhook_attestation_signing` |

Before altering these constraints,0518 checks each exact source/name/target, absence of runtime
INSERT/UPDATE (including column privileges) on the four private relations, and presence/enabled state
of the original identity/verification/atomic-receipt triggers. It also requires actual0516 raw2
FORCE-RLS tables, exact native DELETE guards, reviewed retained-table exception and native raw-seal
birth guard before admitting those count targets. It grants no bypass or generic reader.

## Actual write-path review

The current0512 functions remain the authority; historical UUID presence is never a substitute for a
fresh live join when creating new authority. Required live locks use `FOR SHARE NOWAIT` and last
through the admitted transaction. A later genuine signed callback attributes its original API
credential/config/version from the immutable webhook binding, even after API credential replacement;
those fields are historical attribution, not new API transport authority. Callback verification still
locks its actual current delivery/endpoint/signing-secret/connection. Cross-organization lookup uses
the actual recorded organization, not a restored or caller-selected replacement route.

| Relation/path | Existing native admission and immutable identity |
| --- | --- |
| Identity attestation INSERT | `attest_payment_identity` requires actual secrets login, current restore generation, actual original payment and `payment_connection_snapshot`; the latter locks the active tenant-bound connection and unrevoked payment credential. |
| Identity consumption UPDATE | `bind_payment_execution` requires actual app-service, exact one-use fresh token, current generation and the same live snapshot. `keep_payment_identity` permits only initial matching `consumed_binding_id`; original fields cannot change. |
| Execution binding INSERT | Only `bind_payment_execution` creates it after the same live check; original native attestation/payment/financial FKs remain. |
| Execution binding UPDATE | `begin_payment_customer`, `finish_payment_customer` and `admit_payment_transport` change only the allowed customer/transport state. `keep_payment_execution` pins every original identity field and claim. Known ACK/unknown accounting is retained after revocation; no new I/O follows from that retention. |
| Customer binding INSERT | `finish_payment_customer` requires the actual original one-use customer claim and genuine admitted transport/current generation for a new ACK. It retains its account/execution FKs and immutable financial identity. |
| Webhook binding INSERT | `qualify_payment_webhook` locks the exact native execution plus actual active endpoint, original connection and live signing secret. Its entire row remains immutable. |
| Webhook attestation INSERT | `attest_payment_webhook` requires actual secrets login/current generation; `check_payment_webhook_envelope` locks actual received delivery/version/digest, active endpoint, connection and unrevoked signing secret. |
| Webhook attestation UPDATE | Actual inbox AFTER INSERT binds the private receipt to the same real transaction. `consume_payment_webhook` repeats fresh envelope locks before consuming; `guard_webhook_attestation_change` permits only original inbox/consumption fields. Deferred `require_payment_webhook_atomic_receipt` requires the exact real event and applied delivery, including explicit replay rules. |
| Existing webhook event INSERT | The application DAL uses the consumed native token. `guard_payment_webhook_verification` requires its same-transaction private receipt and exact original IDs/canonical financial hash. Qualified events additionally pass `guard_payment_webhook_identity`/`capture_payment_webhook`; the deferred delivery guard requires actual applied delivery. Unqualified native receipts cannot later acquire qualification. |
| Existing webhook event UPDATE | Only state/target organization/processed timestamp may change; `guard_payment_webhook_identity` pins every source UUID/hash and financial field. |
| Later provider I/O | `admit_payment_transport` goes through `payment_execution_preflight` and the live connection/credential snapshot before identity/customer/charge/lookup transport. Missing/revoked referents refuse new I/O. Historical result routing/accounting remains distinct from new transport admission. |

The four private tables have no app/agent/secrets/eraser direct table writes. Native functions remain
fixed SECURITY DEFINER operations with exact login checks, RLS selectors restored on success/error,
and no general EXECUTE grant on internal getters. Existing event INSERT has the native SQL backstops
above. No existing INSERT/UPDATE/consume/deferred function or its grant is replaced by0518.

## Portability and counts composition

Unpublished `/3` adds eighteen explicit `operational_excluded` entries: material11, payment5 and raw2.
`/1` and `/2` remain unchanged. No import projection accepts these witnesses or turns restored IDs,
tokens, cleanup receipts, historical read relations or raw writer debt into active authority. The
strict joined inventory must still equal actual installed tables; these entries are not optional.

0518 replaces only the closed count installer function from0508, preserving its existing body and
adding fourteen exact reviewed count targets:

- New material10: `ai.run_authority_checkpoints`, `ai.run_read_authorities`,
  `ai.delegated_input_receipts`, `ai.delegated_input_refs`, `ai.delegated_work_births`,
  `knowledge.artifact_authority_receipts`, `knowledge.artifact_authority_refs`,
  `ai.source_run_closures`, `ai.record_purge_jobs`, `ai.record_run_closures`.
- New raw2: `lifecycle.raw_source_inventories`, `lifecycle.raw_object_writes`. Actual0516 owns their
  exact guarded DELETE/retained-table exception; count inclusion supplies neither authority nor proof.
- Already existing process2: `studio.process_run_intents`, `studio.process_step_births`. Their0418
  immutable DELETE guards remain. Nonempty process proof remains a cleanup blocker until root's
  independent fixed process/terminal/current-seal review is composed.

The six existing retained classifications among material/payment remain explicit review obligations:
the lifecycle seal and payment5 receive no eraser DELETE. Schema-wide retention is not a legal rule,
automatic final-table exemption, or permission to retain credentials. Exact retained table/count/reason
reporting and policy review remain root obligations. The eighteen entries would make the prior198
inventory216 before other new tables; root must audit actual installed scope instead of trusting this
arithmetic. Future schema contributors still make the closed installer refuse until reviewed.

## Authored regression scope and open gates

`saas-payment-referent-erasure.test.ts` has six source cases: exact removed/retained constraints;
genuine local native payment/customer/signed callback followed by operator offboarding, actual seal,
held refusal, dirty eraser-pool selectors, private referent erasure and crash/report resume while every
financial witness stays identical; preexisting token refused after real credential revocation;
wrong-tenant/missing references including actual secrets-login attestation; denied direct runtime
private writes/forged event; and actual two-transaction birth-lock/revocation serialization followed
by stale-token refusal. These cases are authored and unrun. The inventory unit also requires every
new entry, rejects omission/business-record disposition, preserves older profiles and rejects imports.

The real eraser's new service binding/grouped receipt cleanup is root-owned and must be composed
before these adapter cases run. A nonempty reciprocal child-positive cleanup test still needs genuine
child redaction/control/payload/file/raw proof through the actual0419 fixture; no fake child/receipt or
trigger disable was added. Positive grouped cleanup, late hold/commit, unknown debt, restore/epoch and
physical transport qualification remain actual integration gates. Raw source debt and0516's guarded
row cleanup,0423 proof-purge composition, native auth admission, current holds and all financial/unknown
paid debt remain independent. Final reviewed0999 must run after the whole contributing schema union.
