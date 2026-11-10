# M5 source checkpoint, 2026-11-07

This is a local source checkpoint on `m5-foundation`, based on `311fa96`. It is **not M5
acceptance**. It includes the ingest/retrieval/compiler/connector/purge/graph/onboarding/UI work,
the independent verification and artifact privacy implementation, and the parent integrator's
0209 client privacy changes. M3/M4 runtime composition is still required. No push, deployment,
provider qualification or production-readiness claim is made.

## Implemented source

- Text parsing and chunking run in a bounded worker thread. Uploads reserve a request key with
  source/document metadata, write bytes outside SQL, and resume the same IDs on a retry. Changed
  content under the same key is refused. Durable writer generations prevent an unknown put from
  being mistaken for a completed or absent write. Publication keeps an older searchable revision
  available until its replacement is ready.
- Lexical/vector retrieval applies live source grants and RLS before ranking and limits. Evidence
  compilation binds the question's sensitivity, work, selected passages and verified facts, with a
  final fresh source/classification/provenance check before storing a package. Private answers link
  every supplied source, including uncited inputs, and discard a response after access loss.
- Embedding and answer activities use injectable model/egress interfaces, bounded batches, recorded
  decisions and real usage when available. Missing model/scanner/fence bindings refuse or remain
  incomplete; they do not become permissive product defaults.
- Google/Microsoft sync/content and MCP use guarded transports, trusted fresh connection scopes,
  strict definitions and bounded protocol parsing. OAuth tokens are scoped to a credential lease,
  and refresh rotation needs an explicit sealed compare-and-set persistence adapter. Real provider
  accounts and credentials were not used.
- Source closure immediately removes access and schedules durable purge. Completion requires run
  fencing, transcript removal, settled/fenced object writers, verified object absence and fresh
  generated-artifact confirmation. Holds, unknown writers and missing lifecycle adapters prevent
  completion. Retry requests/backoff are durable and capped; a failed source is never reopened.
- Generated-file publication/serving, immutable citations and human decisions have retained
  provenance and exact byte/objective/citation digests. Verification control uses ID/hash catalogs;
  catalogs are not permission to serve names or bytes. See [artifact privacy](artifact-privacy.md).
- Graph traversal filters both ends before walking. Facts retain their source/subject privacy and
  require a different authorized person to verify. Parent 0209 adds client custodians and named
  readers, central client/project visibility and access controls.
- Onboarding atomically creates its parent/children/dependencies, binds actual run/output IDs and
  a distinct reviewer, adopts only the selected current brief proof, and proposes one hash-bound M3
  welcome-email intent. It requires provider/reconciliation sending evidence and measured run usage;
  unknown delivery stops without an automatic resend. Every target objective has its own pin.
- Authenticated API routes and native forms cover sources/access/removal, text search, private
  questions/answers, facts, graph, egress, MCP review, exact artifact decisions and onboarding.
  Response DTOs are typed against the generated OpenAPI schemas. Upload streams are byte-bounded;
  raw source files download as sandboxed attachments. Questions use POST and do not enter URLs.
  Pages reuse the shared interface elements and tokens, preserve refused form input and exact review
  digests, and provide manual progress links alongside bounded background refresh where appropriate.

## Latest executed checks

The parent granted one serialized source-check slot. These commands ran against the current combined
M5 checkout, including root 0209 source and its authored test files. No database or browser execution
is implied by typechecking those files.

| Command/scope | Actual result |
|---|---|
| `pnpm --filter @ensemus/contracts generate` | Passed; updated OpenAPI declarations. |
| `pnpm exec prettier --check` over the 112 listed paths | Passed for matched files; repository ignore rules still apply. |
| `pnpm exec eslint` over the 107 listed TypeScript/TSX paths | Passed. |
| Focused unit command below, one worker | 9 files, 77 tests passed. |
| `pnpm --filter @ensemus/database typecheck` | Passed. |
| `pnpm --filter @ensemus/contracts typecheck` | Passed. |
| `pnpm --filter @ensemus/application typecheck` | Passed. |
| `pnpm --filter @ensemus/workflows typecheck` | Passed. |
| `pnpm --filter @ensemus/tests typecheck` | Passed. |
| `pnpm --filter @ensemus/web exec next typegen` | Passed. |
| `pnpm --filter @ensemus/web exec tsc --noEmit --incremental false` | Passed after fixing an owned optional-field mapping. |
| `pnpm --filter @ensemus/browser-tests typecheck` | Passed. |

The exact formatter/lint target inventory is [source-checkpoint.files.json](source-checkpoint.files.json).
The unit command was:

```powershell
pnpm exec vitest run --project unit --maxWorkers=1 --no-file-parallelism tests/unit/knowledge-input.test.ts tests/unit/knowledge-review-contract.test.ts tests/unit/web-knowledge-view.test.ts tests/unit/openapi-contract.test.ts tests/unit/knowledge-foundation.test.ts tests/unit/web-ids.test.ts packages/workflows/src/client-onboarding-step.test.ts packages/workflows/src/knowledge-purge-step.test.ts packages/workflows/src/knowledge-ingest-step.test.ts
```

This is scoped local evidence, not a full-repository lint/unit result. No Docker, install, image build,
migration, real-role integration, replay capture, recall measurement, stack or browser execution ran in
this slot. Parent M4 gate results belong to its separate checkout and are not M5 evidence.

## Additive SQL in this checkpoint

The migration journal has not been stitched or applied here.

| Migration | Source purpose |
|---|---|
| 0202 | Conservative question classification and reproducible verified-fact bindings. |
| 0203 | Separate current searchable publication from one pending revision. |
| 0204 | Fact evidence/subject visibility and immutable trust metadata. |
| 0205 | Source purge/transcript proofs, object writer generations, bounded retry and generated purge accounting. |
| 0206 | Exact objective/citation proofs and monotonic verification order. |
| 0207 | Typed onboarding children, reviewer/contact/run/output/action bindings and its narrow proof bridge. |
| 0208 | Retained generated-file lineage, guarded publication/serving/acceptance and positive erasure receipts. |
| 0209 | Parent-owned client custodians/readers and central client/project visibility. |
| 0210 | Restored generated-file deletion stays pending until positive lifecycle/writer/metadata/byte proof. |

For 0210, a newly restored missing tombstone and its pending marker commit together. The restore gate
continues counting that ledger ID as unapplied until proof clears the marker. Ordinary asynchronous
purges do not acquire the marker. SQL denies user/agent clearing, service clearing without retained
proof, and removal of an unresolved header. Its real-role restore regression is authored and unrun.
See the [ADR amendment](../../../00-foundation/adr/ADR-029-company-knowledge.md).

## Authored coverage is not execution

All new M5 real-role, proxy/API, browser, restore, provider-fault, replay-capture and recall cases remain
unrun until the parent composes the integrated stack. This includes the parent's 0209 **7 real-role
cases and 1 browser journey**, the reviewer's 0208 cases and submitted-digest verification changes,
and this slice's upload key/race/access-loss, generated restore, source purge, onboarding and RSC/cache
regressions. Browser source/search/egress journeys and the shared accessibility-state inventory were
written and typechecked; they have not been rendered, keyboard/axe accepted or visually approved.

## Integration and qualification still required

1. Preserve the newer M3/M4 authority, receipts, dependencies, run lifecycle and shared design code
   while integrating this older foundation. Apply the narrow `createWorkUnitInTx` extraction, not an
   older whole-file replacement. Review and apply SQL with real migrator/app/service/eraser roles,
   stitch the journal, and exercise upgrade/restore/forced-RLS and adversarial races.
2. **0211 is reserved for the integrator, and is not implemented by this checkpoint.** Exhaustive
   runtime provenance must include structured Work inputs read by `work.read` or the compiler, plus
   any client/project fields actually supplied. An artifact-ID/knowledge-package inventory alone
   cannot attest those inputs. Bind and recheck them through publication, serving, human acceptance,
   revocation and erasure. Unknown/incomplete inventories must remain blocked.
3. Bind the actual M4 compiler packages and citation keys to the exact run/turn/output. The draft
   tool must use the real pre-put generated writer, preserve all inputs, and record validated citation
   spans. Bind actual run identity/cost/output IDs and the M4 run FK for onboarding. The kernel must
   count only fresh exact accepted generated evidence or the narrow onboarding bridge; do not invent
   human creation or reuse another Work's proof generically.
4. Register workers/queues/build entries, including the parser thread and agent-side model/transcript
   activities. Bind the real model router/adapters, secret scanner, cancellation signal, embedding
   spaces and rates, run transcript fence, storage writer fence/recovery, holds and derived-artifact
   lifecycle. Missing positive writer proof must keep purge/restore incomplete.
5. Replace the web composition seam's explicitly labelled knowledge-only/deny-all ledger simulator
   with the actual M4 run reader, workloads and pure policy evaluator. Keep normalized millisecond
   ordering plus ID ties in both merged readers; pagination claims no commit-order completeness.
6. Register provider gateways/connectors and trusted consent/rotation persistence. Microsoft download
   redirects remain refused unless an operator explicitly configures the exact approved public HTTPS
   host path with its separate guarded transport; bearer/cookie forwarding is prohibited. Real OAuth,
   provider ACL/delta/redirect qualification and the external security review remain open.
7. Complete the composed navigation/design pass and remaining source-management details, including
   upload-version controls, team grant selectors and client/project selection for fact proposals.
   Pages currently have direct routes; shared global navigation/styles remain integrator-owned.
8. Run the real integration, full security/tenant/RSC, replay captures/replays, stack/API/browser,
   generated artifact/download/receipt, measured recall and flagship journeys. Complete the
   deployment/operator configuration and document/mode review before acceptance. Regenerate the
   documentation manifest and reconcile delivery/backlog/QA states only from those actual results.

Cloud/BYOM/Sovereign behavior has source coverage only at this checkpoint. No provider is required for
lexical search, no model path runs in HTTP, and no live Cloud/BYOM/Sovereign/provider/hosted acceptance
has been demonstrated by these local static and pure-unit checks.
