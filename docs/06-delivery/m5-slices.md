# M5 slices

Ten builders work from the foundation commit, and **no file has two owners**. Everything they must agree on is decided in [ADR-029](../00-foundation/adr/ADR-029-company-knowledge.md) and typed in the code. Read that ADR first, because it holds the reasons. Each stub's comment says what it must do: **implement it with the signature it has.**

If you need a change to a file you do not own, or to anything in "Fixed", stop and report it. Do not work around it, and do not edit the file.

## Fixed: nobody changes these

| What | Where |
|---|---|
| Migrations, RLS, roles, triggers, the graph view. **No builder adds a migration** | `packages/database/migrations/0200_*`, `0201_*`, `packages/database/src/schema-knowledge.ts`. `migrations/meta` is stitched at the final merge |
| Tenant binding and contexts | `packages/database/src/tenant.ts`, `service.ts` |
| Statuses, transitions, codes, limits | `packages/domain/src/knowledge.ts` |
| Event names | `packages/domain/src/knowledge-events.ts` |
| Capabilities, tombstone types | `packages/domain/src/policy.ts`, `tombstone-ledger.ts` |
| Ports | `packages/knowledge/src/ports.ts`, `testing/**`, `packages/application/src/knowledge/ports.ts` |
| Temporal input shapes and queue names | `packages/workflows/src/knowledge-schemas.ts`, `constants.ts`, `knowledge-deps.ts` |
| Wiring | `workers/workflow/src/dispatcher.ts`, `knowledge-worker.ts`, `scripts/build.mjs`, `packages/workflows/src/workflows.ts`, every `package.json`, `apps/web/next.config.ts`, `packages/application/src/errors.ts`, `apps/web/src/lib/messages.ts`, `packages/telemetry/src/index.ts` |
| Contracts | `packages/contracts/src/knowledge.ts` |
| Connector additions | `packages/connectors/src/knowledge.ts`, `knowledge-manifests.ts` |
| Import rules | `eslint.config.mjs` |
| Dependencies. **`pnpm-lock.yaml` is frozen, and no builder adds a package.** All the workspace links are in place | |
| Shared test helpers | `tests/helpers/knowledge.ts`, `tests/integration/knowledge-schema.test.ts` |
| Decisions | ADR-029, this file |

A bug in any of these is reported, not fixed in passing.

## What runs where

**Code only, in this milestone.** Never run docker or docker compose in any form, or `test:integration`, `test:stack`, `test:browser`, `test:upgrade`. Run unit and replay tests, eslint, prettier and typecheck on what you changed, through the slot wrapper you were given. **Write the integration, stack and browser tests anyway, and make them typecheck. They count as unverified: say so, and never report them as passing.**

**Replay histories** need Temporal, which needs Docker. Write `tests/replay/capture-<yours>.test.ts` and `tests/replay/<yours>-corpus.test.ts` on the pattern in `tests/replay/capture.test.ts`, and report the histories as owed.

**M3's and M4's code is not on this branch.** M3's SDK functions (`runSyncPass`, `mapSourceGrants`, `describeConnectorConformance`, `commitSyncPage`, and so on) are stubs here, and real on `m3-verified-actions`. M4 is on `m4-foundation`, and you may read it with `git show`, but do not merge or import it. So a unit test may not call them. Inject a double, or put the test in an integration file that runs after the merge.

## Every slice

- Denied and cross-tenant tests first, then the code. Two tenants, same names, real roles. A person with no grant, an owner with no grant, and a member disabled mid-way.
- Only IDs, enums and counters cross Temporal. A title, a question, a passage or a vector never does. New workflows only import `@temporalio/workflow` and types, and their decisions live in a small pure module a unit test can reach.
- Generated values only: `@example.invalid` addresses, random words. No real document, address, credential or provider. Fakes live with the tests, and `@ensemus/knowledge/testing` is lint-blocked from `apps/` and `workers/`.
- Log codes and IDs, never a title, query, passage, or anything a provider said. Stored reasons come from `KNOWLEDGE_CODES`.
- **A service context reads everything in a tenant. Anything acting for a person takes that person's context,** and search, retrieval, compiling and traversal refuse a service context outright.
- A database refusal arrives as `EN1xx` (`pgCode` in `packages/application/src/errors.ts`). Map it to its `AppError`, and do not let the SQL's words through.
- Follow the house comment style: say why, in plain sentences. No invented prices, SLAs, certifications or legal terms.

## Wave 1: all can start at once

### ingest: `KNOW-01`

Upload, versions and grants, the parser and chunker, the ingest and sweep workflows. Acceptance: versioned source and classification recorded.

**Owns:**

- `packages/knowledge/src/parsing.ts`, `chunking.ts`, and new `*.test.ts` beside them
- `packages/application/src/knowledge/sources.ts`, `ingest.ts`
- `packages/workflows/src/knowledge-ingest-workflow.ts`, `knowledge-sweep-workflow.ts`, `knowledge-ingest-activities.ts`, `knowledge-connector-activities.ts`, new `knowledge-ingest-step.ts` and its test
- `workers/workflow/src/knowledge-ports.ts`, new `workers/workflow/src/parse-thread.ts`
- new `tests/integration/knowledge-sources.test.ts`, `knowledge-ingest.test.ts`, `tests/replay/capture-knowledge-ingest.test.ts`, `knowledge-ingest-corpus.test.ts`

**Implements, unchanged:** `parseDocument`, `chunkText` in `@ensemus/knowledge`. `addUploadedSource`, `addDocumentVersion`, `listSources`, `getSource`, `openDocumentBytes`, `setSourceGrants`, `raiseSourceClassification` in `@ensemus/application/knowledge/sources`. `ingestDocument`, `listStaleConnectorResources`, `recordConnectorContent` in `.../ingest`. `knowledgeIngestWorkflow`, `knowledgeSweepWorkflow`. `createKnowledgeIngestActivities` (`parseAndChunk`, `listStaleResources`, `closeOrphanedSources`, `listMcpConnections`), `createKnowledgeConnectorActivities` (`fetchConnectorContent`).

**Calls:** `closeOrphanedConnectorSources` (purge, stubbed here), `embedDocumentChunks` Activity by name (egress), `refreshMcpTools` Activity by name (mcp), `isKnowledgeConnector` from `@ensemus/connectors/knowledge`, `emit`, `appendAudit`.

**Things to get right:**

- Bytes first with a row saying so, as `addArtifact` does: a crash must not strand bytes or a row. Key: `knowledgeObjectKey`. `blob_lifecycle` is for artifacts: on a failed upload delete the bytes, and let a `received` row with no bytes end `failed`.
- `parseAndChunk`: staged bytes move to the store, and that row goes, before parsing. The chunks, `superseded_at` on the old version and `searchable` commit in one transaction. No transaction is open during a parse or a store call. `MAX_CHUNKS_PER_DOCUMENT` refuses, and never truncates.
- A real `parse-thread.ts`: a worker thread with `resourceLimits` and a deadline. Output is text, and HTML is never rendered. Test that a huge line, invalid UTF-8 and an unsupported type all refuse with a code.
- The sweep is bounded, and one bad resource never stops the rest. `fetchConnectorContent` runs on `CONNECTOR_TASK_QUEUE` with `maximumAttempts` small, and leases the credential the way `connector-sync-activities.ts` does on `m3-verified-actions`.
- `knowledgeIngestWorkflow`: the embed Activity has a `scheduleToStartTimeout`, so no agent worker ends `model_worker_absent`, and the document stays searchable.
- `ContentScanPort` throwing stops ingest as `failed`. It never reads as clean.

**Denied and fault tests:** member without `knowledge.add`. Another tenant's source for a new version. Upload with a grant to another tenant's person. A grant too wide for the class. A manual grant on a connector source. Lowering a class. Same content twice is one version. Worker dies after the store write and before the commit, and a re-run gives one document. Source closed during parsing ends `closed`, with no chunks. A connector resource at the same version fetches nothing. **QA:** Gate D's "preserves tenant, ACL, classification, version and citation".

### egress: `MODEL-05`, `AGENT-10`, `AGENT-11`

Embedding through the port, the ledger, and the simulator. Acceptance: restricted inputs denied on an unapproved embedding API. Records which class reached which provider, when, why and under which policy. Shows what would go, with no transmission.

**Owns:**

- `packages/application/src/knowledge/embeddings.ts`, `egress.ts`
- `packages/knowledge/src/egress-simulation.ts` and its test
- `packages/workflows/src/knowledge-embed-activities.ts`
- new `tests/integration/knowledge-embeddings.test.ts`, `knowledge-egress.test.ts`

**Implements, unchanged:** `recordModelCall`, `embedDocument`, `embedQuery`, `activeEmbeddingSpace`, `ensureEmbeddingSpace`. `listEgressLedger`, `simulateProvider`. `simulateEgress`. `createKnowledgeEmbedActivities` (`embedDocumentChunks`).

**Calls:** `KnowledgeModelPort`, tested with `createScriptedModelPort`, whose `calls` proves what was contacted. `RunEgressDecisions`, `AgentWorkloads`, `EgressPolicyPort` as doubles in `tests/helpers/knowledge.ts`.

**Things to get right:**

- `route` first, with the document's class, and every assertion of a deny checks `calls` holds only `route`. A deny writes a row and sets `denied`. The document stays searchable.
- A batch of chunks in the worker, with no transaction during the call. Each batch rechecks the source first. A closed source stops, and `EN103` on insert is not an error, just the end.
- Model errors arrive as `ModelCallFailed` with a code. Nothing else from a provider is kept. `requestSha256` is over the texts, never the texts.
- `simulateEgress` imports nothing but types. A throwing policy reads as `wouldTransmit: false`.
- The ledger's cursor is `(occurredAt, id)`, stable across both sources. It needs `egress.view`.

**Denied and fault tests:** `QA-011` restricted with an external model: denied before any embed. `QA-017`: a wrong-length vector ends `failed` with `SPACE_MISMATCH`, and spaces never mix. Rerouted space with a new dimension: new space, and old vectors retired. Member cannot read the ledger. Another tenant's rows never appear. A canary in a passage is absent from every ledger row. Provider down: `failed` with a code, and full text still works. `FAULT-12`. Simulator: restricted to an external host says no, and `calls` is empty, since it has no port at all.

### retrieve: `KNOW-02`, `SEC-03`, `UX-22`'s service

Lexical and hybrid retrieval, company search, the isolation regression suite, and the recall script. Acceptance: source ACL before results and measured recall. No cross-tenant hits after source revoke. Same-named items isolated.

**Owns:**

- `packages/knowledge/src/fusion.ts` and its test
- `packages/application/src/knowledge/retrieval.ts`, `company-search.ts`
- new `tests/integration/knowledge-retrieval.test.ts`, `knowledge-company-search.test.ts`, `knowledge-isolation.test.ts`
- new `tests/measure/knowledge-recall.measure.ts`, new `tests/stack/knowledge-cache.test.ts`

**Implements, unchanged:** `fuseRanks`. `searchLexical`, `retrieveHybrid`. `searchCompany`.

**Things to get right:**

- **Every query names `knowledge.readable_source_ids(app.current_membership_id())` in its own SQL,** besides row-level security. Refuse a service context. Nothing filters afterwards.
- Vector search: `ORDER BY embedding <=> $1::vector` inside one `space_id`. The query vector's length must equal the space's. Lexical: `websearch_to_tsquery('english', $1)`, ranked by `ts_rank_cd`. Both bind parameters, and neither builds SQL from text. Only current, searchable documents.
- Company search: `knowledge.can_read_work` for work, the ACL for documents, and what the People page shows for people. Paths are built from IDs. Use the `simple` GIN indexes from 0201.
- Excerpts are plain text. Whatever renders one must escape it.
- **The recall script:** `pnpm measure:m2`'s project, in `tests/measure/`. It takes a scratch database URL, creates generated vectors at several tenant sizes and ACL selectivities (1%, 10%, 50%), and compares exact search to HNSW with `hnsw.iterative_scan`, reporting recall at 10, and p50 and p95, as JSON. It creates its own index in its own scratch schema, and it never touches `knowledge.embeddings` in a real database. **It has not run, and report that.** Check the current pgvector options through Context7 first.

**Denied and fault tests (`SEC-03`, `QA-002`, `QA-015`, `SEC-002`):** the same document and name in two tenants. A hit, then revoke, then the same search: none. A grant removed: none. A connection revoked: none. A resource gone: none. An owner with no grant: none. A disabled member: none. `allowed_source_ids` naming someone else's source: none, and no error that reveals it. Restricted source with a team grant in M3's table: none. A query string with SQL in it. Counts and ordering reveal nothing about hidden rows. **Stack, unverified:** two web replicas, revoke on one, read on the other (`NEXT-03`), and no route sets a cache header other than `no-store`.

### compile: `KNOW-03`, `UX-18`'s service

The Context Compiler, evidence packages, citation checks and answers. Acceptance: token budget and provenance preserved.

**Owns:**

- `packages/knowledge/src/evidence.ts`, `citations.ts`, `prompt.ts`, and their tests, including golden files beside them
- `packages/application/src/knowledge/compiler.ts`, `answers.ts`
- `packages/workflows/src/knowledge-answer-workflow.ts`, `knowledge-answer-activities.ts`
- new `tests/integration/knowledge-compiler.test.ts`, `knowledge-answers.test.ts`, `tests/replay/capture-knowledge-answer.test.ts`, `knowledge-answer-corpus.test.ts`

**Implements, unchanged:** `selectEvidence`, `packageHash`, `checkCitations`, `buildAnswerMessages`. `compileEvidence`. `askQuestion`, `getAnswer`, `listMyAnswers`, `runAnswer`. `knowledgeAnswerWorkflow`. `createKnowledgeAnswerActivities` (`answerQuestion`), `createKnowledgeAnswerFallbackActivities` (`failAnswer`).

**Calls:** `retrieveHybrid` (retrieve, stubbed here), `embedQuery`, `recordModelCall` (egress, stubbed here), `verifiedFactsFor` (facts, stubbed here), `createDelegatedContext`. Inject doubles in unit tests through a small seam of your own, or put the test in an integration file that runs once they land.

**Things to get right:**

- Stages as in `05-context-compiler`. `compileEvidence` takes a membership context and refuses a service one. Reproducible: pinned inputs give an equal `packageHash`, so ties break by chunk ID. Default traces hold hashes and source IDs only.
- Egress is checked against **every included class**. Dropping classes to fit a route is allowed only for `answer`, and only if evidence remains. Otherwise stop.
- `runAnswer`: `service` for the row, and `asker` for retrieval. `createDelegatedContext` failing (disabled person) ends `refused`. No evidence means no model call. A failed `checkCitations` means `refused`, with the model's text discarded. Writes `answer_sources` for everything in the package, cited or not, and `answer_citations`. A model call is never retried in the Activity (`maximumAttempts: 1`), because a lost answer may have been billed.
- `failAnswer` for `scheduleToStart` timing out: `MODEL_UNAVAILABLE`.
- Golden tests: passage text only ever appears in an `evidence` message. Instructions in a passage change nothing in system text.

**Denied and fault tests:** `QA-018`'s poisoned document, with a scripted model that obeys it: still no tool, no other source, and its fabricated citation is refused. Person loses access mid-question: `no_evidence`. Answer hidden from another member, and from the asker once one source is out of their reach. `QA-015`: the source revoked after the answer. Budget: nothing cut in half, and `usedTokens` within budget. A mixed-class package routes on the strongest. Denied provider: no fallback, and `KNOWLEDGE_NO_MODEL`. Stale agreement: freshness says `superseded`. A question's canary is absent from Temporal payload schemas (strict schemas with IDs only). `FAULT-01`. Enormous passage count capped.

### facts: `KNOW-04`, `KNOW-06`

Evidence-backed facts with a trust gate, and the company graph. Acceptance: model guesses cannot become verified facts. Typed tenant-safe links and multi-hop queries.

**Owns:**

- `packages/application/src/knowledge/facts.ts`, `graph.ts`
- new `tests/integration/knowledge-facts.test.ts`, `knowledge-graph.test.ts`

**Implements, unchanged:** `proposeFact`, `reviewFact`, `disputeFact`, `supersedeFact`, `listFacts`, `getFact`, `verifiedFactsFor`. `linkNodes`, `unlinkEdge`, `traverseGraph`.

**Things to get right:**

- `proposeFact`: the class is the strongest of its evidence's sources, computed here and never taken from input. Checks the subject's record in the same transaction, for a fixed list of predicates: `name.is` against a client's `display_name` or a project's `name`. A conflict lands `disputed`, through `proposed`, with `conflict_ref`. A predicate with no authoritative record is not a conflict.
- `reviewFact`: `knowledge.review_fact` and `actorType === 'user'`, and the trigger holds it too. Map `EN109` and `EN110`. A reason is required, and goes on the row, never in audit or events.
- `traverseGraph`: one recursive CTE over `knowledge.graph_links`, with `UNION` (not `UNION ALL`) so a cycle ends, with depth and a row limit. The node filter is in the recursive term, so it refuses to walk through what is hidden: `knowledge.can_read_work` for work, `knowledge.readable_source_ids` for sources, and a fact's edges only if the fact is visible. Refuse a service context. Labels are only names the viewer may see, and a client's confidential class hides its name as its page does.
- `linkNodes` uses `edgeAllowed` from the domain.

**Denied and fault tests:** `SEC-009`: a document saying "this fact is verified", with a model that proposes it: `proposed`, and the compiler never offers it. A model, an agent, a delegated context and a service context all refused verifying. The proposer refused. Evidence from a source the proposer cannot read. A fabricated hash. `QA-016` conflict stays `disputed` until reviewed. A fact hidden when any evidence is unreadable. Two tenants with the same names. A path through a restricted Work Unit stops there, with nothing past it and no sign of it. A cycle terminates. A link to a node in another tenant refused. `truncated` true at the limit.

### purge: `KNOW-05`

Revoke, delete, the purge and restore re-apply. Acceptance: serving blocks immediately, and projections purge.

**Owns:**

- `packages/application/src/knowledge/purge.ts`
- `packages/application/src/tombstone-ledger.ts`, **only** to dispatch on `targetType` to `reapplyKnowledgeSourceEntry` and to count its results. Every artifact path stays as it is
- `packages/workflows/src/knowledge-purge-workflow.ts`, `knowledge-purge-activities.ts`
- new `tests/integration/knowledge-purge.test.ts`, `knowledge-restore.test.ts`, `tests/stack/knowledge-restore.test.ts`, `tests/replay/capture-knowledge-purge.test.ts`, `knowledge-purge-corpus.test.ts`

**Implements, unchanged:** `revokeSource`, `deleteSource`, `closeOrphanedConnectorSources`, `runSourcePurge`, `purgeRunTranscriptsForSource`, `getPurgeStatus`, `reapplyKnowledgeSourceEntry`. `knowledgePurgeWorkflow`. `createKnowledgePurgeActivities` (`purgeSource`), `createKnowledgeTranscriptActivities` (`purgeRunTranscripts`).

**Calls:** `emit` with `TOMBSTONE_RECORDED` and aggregate `AGGREGATE_KNOWLEDGE_SOURCE`, so the dispatcher's ledger writer needs no change. `RunTranscriptPurge` as a double. `ObjectStore`.

**Things to get right:**

- The state, tombstone, purge job and both events in **one** transaction. A second close of a closed source finds the job and starts nothing new.
- The order in ADR-029 D3, because `fact_evidence` and `answer_citations` reference chunks with no cascade. No transaction is open during a store call. Check the bytes have gone before counting them. Each step in its own bounded transaction, and a re-run picks up where it stopped.
- A fact with other evidence becomes `disputed`, with `conflict_ref` set to `knowledge_source:{id}`, from a service context, which the trigger allows. One with no evidence left is deleted. **If the trigger forbids what the ADR says, report it.** Do not edit the migration.
- Runs for M4's transcripts come from `evidence_packages` joined to `evidence_items` on the source.
- `closeOrphanedConnectorSources`: reads already stopped, and this records the reason (`connection_revoked` or `resource_gone`).
- Re-apply: `unconfirmed` for a source whose documents and bytes all survive, unless confirmed. Idempotent. Do not delete a source row (a trigger refuses it).

**Denied and fault tests:** `QA-015` revoked while answers exist: live serve denies in that commit. `QA-025`: restore a dump from before a deletion, and it is not silently reactivated, on the `tests/stack` pattern (unverified). `KNOW-05`'s race: ingest in flight during a revoke, then purge, then nothing remains. A store outage: job `failed`, serving still blocked, retry completes. Purge twice: same counts. A member cannot revoke. Another tenant's source: not found. A connector source's resource gone. `FAULT-01`. Gate D's report: the job says `completed`, with counts. `SEC-002`.

### connectors: `CONNECT-04`, `CONNECT-05`

Google Workspace and Microsoft 365 on M3's SDK, tested against local fakes only. Acceptance: scope mapping and source revoke tested.

**Owns:**

- `packages/connectors/src/runtime/provider-http.ts` and its test
- `packages/connectors/src/google/**`, `packages/connectors/src/microsoft/**`, including tests
- new `tests/helpers/fake-provider.ts` (a local TLS server with a generated certificate), `tests/integration/google-connector.test.ts`, `microsoft-connector.test.ts`

**Implements, unchanged:** `createProviderHttpClient`, `createGoogleWorkspaceConnector`, `createMicrosoft365Connector`. Each is `Connector` plus `ContentConnector` from `@ensemus/connectors/knowledge`.

**Use Context7** for the current Google Drive v3 API (files, permissions, changes, export) and Microsoft Graph (driveItem delta, permissions, content). Write the wire formats from those docs, and mark them unqualified until a live run by the owner. **No real credential, tenant or account is used.**

**Things to get right:**

- `node:tls` over the `Duplex` from a `ConnectorNetwork`, with `rejectUnauthorized` never false and `servername` from `ROUTE_TLS_NAMES`. `testCa` is for tests only, and no shipped entry point sets it. HTTP/1.1: one request per connection, `Connection: close`, chunked decoding, a bounded response. A redirect is returned, and a connector treats it as an error. Refuse a header value with a line break. Test against a fake that sends too much, sends nothing, and lies about length.
- The credential is `oauthCredentialSchema` from `@ensemus/contracts/knowledge`, inside `withCredential`. Exchange it for an access token over the OAuth route, once per pass, in memory only. Neither token reaches a log, an error, a row or Temporal: test with a canary.
- `parseConfig` uses `driveConnectorConfigSchema`. **It can never hold a host.**
- `sync`: `readPage` with the provider's own cursor (`changes` for Google, `delta` for Microsoft). `CursorExpired` on an expired one. A deleted or trashed file goes in `deletedExternalIds`. Every grant goes in `acl`: users by email, groups by ID, and `domain` and `anyone` as those kinds, which M3's mapping turns into nothing. Default class: `internal`. No page reads content.
- `content.readContent`: Google Docs, Sheets and Slides export as `text/plain` or `text/csv`, plain text files download, and anything else throws `ContentUnavailable('CONTENT_UNSUPPORTED')`. `sourceUrl` comes from the provider's own link field, and is dropped unless it is https.
- **Scope mapping:** `SCOPES_BY_STREAM` beside each connector. A stream whose scopes `grantedScopes` lacks fails with a code, before any request.
- Errors carry codes only. A provider's body never leaves.

**Denied and fault tests:** a grant removed at the fake appears as a removed row in the next page (source revoke, end to end with `mapSourceGrants`, integration only). A file deleted. A connection whose token was revoked at the fake: a code, and no retry loop. Missing scope. A 429 and a 500. Malformed JSON. A redirect to another host: refused, and the token not sent. A certificate for the wrong name: refused. Conformance suite (`describeConnectorConformance`, stubbed here, so it goes in the integration file).

### mcp: `CONNECT-03`

The MCP adapter behind the policy gateway. Acceptance: tool metadata cannot confer privileges.

**Owns:**

- `packages/connectors/src/mcp/**`, including tests
- `packages/application/src/knowledge/mcp.ts`
- `packages/workflows/src/mcp-activities.ts`
- new `tests/helpers/fake-mcp-server.ts`, `tests/integration/mcp-tools.test.ts`

**Implements, unchanged:** `createMcpConnector`, `mcpDefinitionHash`. `recordMcpToolList`, `listMcpTools`, `reviewMcpTool`, `loadCallableMcpTool`. `createMcpActivities` (`refreshMcpTools`).

**Use Context7** for the current MCP specification revision: `initialize`, `tools/list`, `tools/call`, and Streamable HTTP. Build a small client over `ProviderHttpClient` (test with a double of it, since `provider-http.ts` is stubbed here). Do not add the SDK.

**Things to get right:**

- `tools/list` output is stored and never believed. Size and count limits, and an oversized definition is skipped with a code. `mcpDefinitionHash` is canonical JSON, using `canonicalJson` from `@ensemus/domain/approval`.
- **No code path reads `annotations`, `readOnlyHint`, a description or a name to decide anything.** A test gives a tool `readOnlyHint: true` that writes, and another claiming to be an approval step, and neither gets anything.
- `reviewMcpTool` is the only way to `approved`, in a user context, by the trigger as well. `restricted` cannot be in `allowed_classes`, because the contract and table leave it out.
- `loadCallableMcpTool` rechecks status, hash, connection state and class at each call, so a tool changed since review refuses.
- `callTool`: result size bounded. A tool's error text stays in the result, marked as tool output, and never in a log. A timeout, or an error from the server, is a code.
- Follow no redirect. `endpointPath` cannot name a host, by its schema.

**Denied and fault tests:** a server changing a tool's description after approval: back to review, and the call refused. A poisoned description (`SEC-003`). A tool name colliding with a real one. A member cannot review. Another tenant's tool: not found. A revoked connection. A server returning a million tools. Malformed JSON-RPC. A service context cannot approve. `external_write` reaches `loadCallableMcpTool` as that level, so M4's gateway must make it an intent: state that in its comment, since M4 enforces it.

### ui: `UX-18`, `UX-22`, and every route

All HTTP routes and pages for this milestone, on the existing design system. Acceptance: answers show citations, freshness and access state, with a path to the original source. Search returns only authorized results.

**Owns:**

- new `apps/web/src/app/api/v1/organizations/[organizationId]/knowledge/**`, `search/**`, `egress-ledger/**`, `egress-simulations/**`, `client-onboardings/**`, `connections/[connectionId]/mcp-tools/**`, `work-units/[workUnitId]/artifacts/[artifactId]/verification/**`
- new `apps/web/src/server/knowledge-api.ts`, `knowledge-actions.ts`, `knowledge-ports.ts`
- new `apps/web/src/app/o/[organizationId]/knowledge/**`, `search/**`, `settings/egress/**`, `onboarding/**`
- `apps/web/src/components/main-nav.tsx`, `apps/web/src/app/globals.css`, new `apps/web/src/components/knowledge-*.tsx`
- `docs/specifications/openapi.yaml`, `packages/contracts/generated/**`, `tests/unit/openapi-contract.test.ts`
- new `tests/stack/knowledge-api.test.ts`, `tests/browser/specs/knowledge.spec.ts`, `search.spec.ts`, `egress.spec.ts`

**Calls** (stubs until each lands, so a page handles their errors and your tests seed with `tests/helpers/knowledge.ts`): everything under `@ensemus/application/knowledge/*` except `ingest` and `embeddings`, which lint blocks here. Schemas from `@ensemus/contracts/knowledge`.

**Things to get right:**

- `apiRoute`, as the existing routes use. Flip `x-ensemus-status: planned` off and remove its line from `tests/unit/openapi-contract.test.ts` as each route lands, and regenerate with `pnpm --filter @ensemus/contracts generate`.
- `knowledge-ports.ts`: what the simulator and ledger get until the final merge wires M4. A policy denying everything with `POLICY_NOT_WIRED`, no workloads, and no run decisions. **A deny-all that says so, and never an allow.** The page says the simulator is limited until a policy exists.
- Knowledge pages: sources with state, class, freshness and `not_scanned` said plainly. Add a document, with grants. A refused format says so. The ask page polls an answer: citations next to the words, each with title, version, last modified, `current` or `superseded`, and a link to the original (`/knowledge/documents/{id}/content`, or `source_url`, https only, with `rel="noreferrer"`). A source no longer readable says the answer is unavailable, with no words from it. A purge shows how far it got.
- Facts page: `proposed`, `verified` and `disputed` are never only a colour. Who verified, and on what.
- Excerpts are text, and React escapes them. No `dangerouslySetInnerHTML`.
- `no-store` on every route holding words. `cache: 'no-store'` wherever a fetch exists. Nothing in a URL but IDs: a question goes in a POST.
- Forms work without JavaScript, as the rest do. Search is a GET form on its own page. Empty, error, loading and denied states on each. A denied person gets the usual not found.
- Egress page: the ledger table, with a machine-readable download of the same rows, and the simulator form. Needs `egress.view`.
- MCP review page: the server's words marked as such, and the admin picks the level. Nothing is pre-selected from what the server said.

**Tests, with no stack:** unit tests for pure view helpers, as `tests/unit/web-*.test.ts` do. **Written, typechecked, not run:** stack API tests putting real responses through the OpenAPI validator, browser specs with axe and keyboard use, an RSC canary scan over the new pages (`SEC-10`), and denied, cross-tenant and same-name cases for each route. `pnpm --filter @ensemus/web exec next typegen` before typecheck.

## Wave 2: after wave 1 is merged

### flagship: `AGENT-07`, `AGENT-12`, Slice 4

Why it waits: it calls real retrieval, citations and connectors, and its end-to-end test needs all of them.

Artifact verification and acceptance, the deal-won workflow, Slice 4, and the milestone's docs. Acceptance: human accepts grounded output against objective. The chosen workflow completes with verified receipts and measured cost.

**Owns:**

- `packages/application/src/knowledge/verification.ts`, `onboarding.ts`
- `packages/workflows/src/client-onboarding-workflow.ts`, `client-onboarding-activities.ts`, new `client-onboarding-step.ts` and its test
- new `docs/specifications/examples/client-brief.agent.yaml`
- new `tests/integration/knowledge-verification.test.ts`, `client-onboarding.test.ts`, `tests/stack/slice-4.test.ts`, `tests/helpers/slice-4.ts`, `tests/replay/capture-client-onboarding.test.ts`, `client-onboarding-corpus.test.ts`
- new `docs/06-delivery/evidence/M5-report.md`, `docs/06-delivery/06-end-to-end-delivery-plan.md`
- `docs/02-architecture/03-data-model.md`, `docs/03-intelligence/04-memory-and-knowledge.md`, `docs/03-intelligence/05-context-compiler.md`, `docs/05-operations/05-container-deployment-runbook.md`
- `docs/specifications/traceability.csv`, `qa-scenarios.csv`, `implementation-backlog.csv`, `threat-register.csv`
- **`docs/MANIFEST.json`, last of all.** `node docs/specifications/tools/regenerate-manifest.mjs`

**Implements, unchanged:** `recordArtifactCitations`, `checkArtifactGrounding`, `decideArtifact`, `getArtifactVerification`. `startClientOnboarding`, `getClientOnboarding`, `advanceClientOnboarding`. `clientOnboardingWorkflow`. `createClientOnboardingActivities` (`advanceOnboarding`).

**Calls:** `createWorkUnit`, `proposeExternalActionInTx` (M3), `AgentRuns` (M4, as a double in `tests/helpers/knowledge.ts`), `checkCitations` (compile).

**Things to get right:**

- `decideArtifact`: the hash has to be the file's current one, and the trigger requires a passed grounding check for it. Map `EN113` and `EN114`. Refuses a service or agent context.
- A brief's citations are checked by `checkArtifactGrounding`, and a citation to a source since closed fails it with `SOURCE_CLOSED`.
- `advanceClientOnboarding` is idempotent. The agent's run and the email's intent are each requested once, by a key from the onboarding's ID. `reviewer` is never `owner`, because M2's `SELF_APPROVAL` stands. The email is M3's: approval binds the exact bytes, and an `unknown` send makes the onboarding `unknown`, with no retry.
- Cost comes from `AgentRuns.statusOf`, and is labelled an estimate. Null when nothing was measured. **Never invent one.**
- The workflow only calls `advanceOnboarding` and sleeps, and `continueAsNew` before history grows long.

**Slice 4 (`tests/stack/slice-4.test.ts`, on real containers, unverified here):** a connection through a fake provider, a sync, ingestion, chunks, embeddings through a fake model, search under ACL, a cited answer, a revoke, the purge completing and serving gone, and a restore not bringing it back. Then the flagship: deal won, brief, acceptance, approval, a sink receives **one** email, receipt, cost shown. **Gate D** as its acceptance states.

**Denied and fault tests:** a member who may not accept. A file changed since it was read: refused. Accepting with no passed check. A model has no path to accept. A repeated deal: one onboarding. A worker restart mid-way repeats nothing. An email timing out ends `unknown`, and nothing resends. Another tenant's deal. An outsider cannot read the onboarding.

**Docs:** `qa-scenarios.csv` and the backlog move only on evidence. `M5-report.md` says what ran, on what, and what did not. **It claims nothing that CI has not shown.** The runbook gets the workers and gateways listed under "After the merge" below, and says plainly that `not_scanned` means no scanner ran.

## Tickets no slice has

Only a person can finish these: `OPS-20` (hosted staging and production: accounts, money, managed services), `LEGAL-01` (counsel-reviewed pilot terms and DPA), `LEGAL-02` (subprocessor list, which has to match real data flows). Do not draft legal terms.

## After the merge

**One writer, at the final merge. These need M3 and M4 together:**

| What | Where |
|---|---|
| Stitch the journal: `0200`, `0201` in order | `packages/database/migrations/meta` |
| Register `createKnowledgeConnectorActivities`, `createMcpActivities`, Google, Microsoft and MCP connectors, and provider routes | `workers/workflow/src/connector-worker.ts` |
| Register `createKnowledgeEmbedActivities`, `createKnowledgeAnswerActivities` and `createKnowledgeTranscriptActivities`, with `KnowledgeModelPort` over M4's router and `RunTranscriptPurge` over `ai.step_payloads` | M4's `workers/workflow/src/agent-main.ts` |
| Give M4 what `KnowledgeModelPort` needs, as ADR-029 D10 lists: `embed` and `rerank` purposes, the `embedding_reranker` destination, an `embed` adapter method, and a gateway entry point for work with no run | `packages/domain/src/ai.ts`, `packages/policy/src/egress.ts`, `packages/intelligence/src/**` |
| Merge `TenantContext.actorType` as `'user' \| 'service' \| 'agent' \| 'delegated'`, keeping this branch's `withTenantTx` and `transaction`. Have M4's `CompiledContext.sources` accept a knowledge passage | `packages/database/src/tenant.ts`, `packages/agent-runtime/src/context/index.ts` |
| Register `createClientOnboardingActivities`, with `AgentRuns` over M4's service | `workers/workflow/src/main.ts` |
| Real `contentScan`, over M4's `scanForSecrets`: a hit raises to `restricted` | `workers/workflow/src/knowledge-ports.ts` |
| Real `EgressPolicyPort`, `AgentWorkloads`, `RunEgressDecisions` | `apps/web/src/server/knowledge-ports.ts` |
| Add `KNOWLEDGE_CONNECTOR_MANIFESTS` to `CONNECTOR_MANIFESTS` | `packages/connectors/src/manifest.ts` |
| M4's tool gateway calls `loadCallableMcpTool`, and M4's compiler calls `compileEvidence` | M4's `packages/agent-runtime` |

**Then Docker (nobody here runs this):** the `docker_later` list in the handoff. A `knowledge-worker` service, gateways per route, capture of replay histories, the recall script, and every integration, stack and browser test written here.

## Merge order

Nothing depends on order for compiling, since every signature exists. For tests to pass end to end: ingest, egress, retrieve, facts, purge, compile, connectors, mcp, ui, then wave 2's flagship. If the ownership above held, there are no conflicts to resolve.

## Handoff

Each builder reports: tickets, files, behaviour, commands actually run with results, anything fixed or stubbed left over, what could not run locally, and any report under "If you need a change". Commit messages end with the attribution line. Do not push. Finish with `git checkout --detach`.
