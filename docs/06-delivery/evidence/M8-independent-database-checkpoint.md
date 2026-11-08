# Independent M8 database checkpoint, 2026-11-08

Root composed the preserved M8 source with current M7, then registered 0500, 0501 and 0503–0509 after
0420. All **66 registered migrations** installed on a fresh synthetic database owned by the
`ensemus-m7-source-gate` test project. No original user database or unrelated Docker data was reset.

The generated current model has **195 tables**. An actual PostgreSQL constraint-name audit initially
found 34 equivalent foreign keys with different names and one equivalent check with a different name.
The two creating migrations now give these constraints their canonical modeled names; a fresh repeat
installed successfully and reported **zero missing constraints and zero name differences**. Four
schema defaults written as JavaScript BigInt literals prevented the pinned generator from serializing
its diff; SQL `0` defaults preserve the database behavior and produce the required snapshot. The
snapshot is chained to the previously qualified 0420 model.

The first selected real-role group passed 23 and failed six. Three failures exposed a catalog query
requesting FOR UPDATE on immutable plans, where the operator correctly lacks UPDATE privilege. The
existing pre-insert plan-code advisory lock already serializes creation/version assignment; removing
the unnecessary row-lock request fixes the path without adding a grant. Three negative tests received
the correct raw PostgreSQL 42501 refusal but inspected it with a helper for wrapped application
errors; the assertions now inspect the actual raw SQLSTATE. The final four-file group passed **40 of
40 cases**, covering catalog publication/concurrent versions, private billing/support body boundaries,
safe entitlement metadata, and actual transactional webhook event/inbox/outbox binding using a signed
test processor. No real payment-provider delivery is claimed.

Logs: `.local-m8-db-independent-first.log`, `.local-m8-db-independent-repaired.log`,
`.local/m7-schema-audit.json`. Earlier M7 groups remain separate evidence; this checkpoint does not
claim they were rerun after the SaaS join.

The first full joined unit run passed **5,443**, failed **20**, and explicitly skipped **two**. Root
corrected duplicate portability inventory entries, activated exactly 25 existing SaaS HTTP handlers in
OpenAPI after checking actual exports, updated permitted account navigation assertions, taught the
vendor-code boundary walk to follow actual Node export patterns, and repaired canonical-ID input
boundaries. Affected root rerun passed **175** with two explicit skips; the ID source branch passed
38 focused cases. The full joined rerun at `27ada85` subsequently passed **5,477 cases in 237 files**,
with **two explicit skips**, and every workspace typecheck passed with concurrency one. Source/branch
counts are not additive. The production web build at that checkpoint also passed. These results do
not establish complete current HTTP/browser, provider or deployment acceptance.

0417, 0419 and 0510 remain unregistered and unqualified. The final 0999 eraser installer remains
unregistered until every contributing schema and real closure proof has been reviewed. Its unknown
table refusal must not be bypassed to manufacture a zero count. Full lifecycle/restore, actual
physical storage deletion, providers, load/operations, complete current journeys, independent review
and hosted acceptance remain open.
