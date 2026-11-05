# Organizational memory — typed knowledge, scoped retrieval and evidence

## Goals

Support company intelligence without building a universal, uncontrolled vector dump. Every memory item must have provenance, privacy scope, tenant, source identity, lifecycle and validity state. The system distinguishes authoritative business facts from summaries and model-generated hypotheses.

## Memory taxonomy

| Layer | Store | Access/lifecycle |
|---|---|---|
| Working | AgentRun state/context snapshot, Temporal references | Bounded execution, short retention |
| Episodic | Domain events, verified activity records, decisions | Scoped, immutable evidence where permitted |
| Knowledge | Documents, extracted text, chunks, lexical/vector index | Inherits source ACL; refresh and revoke |
| Structural | People, teams, clients, projects, Work Unit edges | Relational source of truth, versioned state |
| Procedural | Skills, SOPs, agent manifests, workflow definitions | Published version and owner grants |
| Preference | Personal and team preferences with opt-in sharing | User scopes and deletion controls |

## Ingestion pipeline

Connector event/upload → source identity and ownership → classify + malware scan + parse (in sandbox) → dedupe by source/version/hash → text extraction & chunk metadata → embed through **approved** provider/local model → write ACL-governed indexes and provenance → publish retrieval availability. Parsing CPU work runs in dedicated Node worker processes or optional isolated native tooling, not in Next.js web threads. For very large formats, optional specialized processing can be introduced via a versioned process interface without changing primary architecture.

## Retrieval

`actor/resource policy → structured SQL selection → filter authorized sources → FTS + vector candidate search → merge/rerank → validity/freshness checks → bounded context compiler → provenance-carrying citations`.

Apply ACL *before exposing content to any model or reranker*. PostgreSQL RLS is defense in depth but not a replacement for document sharing policy, inheritance and external revocation mapping. Strictly isolate embedding indexes, caching, reranker context and generated summaries by tenant and access scope. Beware pgvector ANN approximate filtering/reduced recall for selective ACL predicates; benchmark against exact authorized retrieval and partition/iterate candidates as needed.

## Data model

`knowledge_sources`, `source_objects`, `documents`, `document_versions`, `document_chunks`, `chunk_embeddings`, `facts`, `fact_evidence`, `knowledge_edges`, `acl_grants`, `index_jobs`, `source_tombstones`. Embeddings have `model_id`, `dimension`, `vector_space_version`, content hash and deletion status; do not compare incompatible embeddings as if same space.

## Memory consolidation

A scheduled process proposes deduplications, supersessions, contradiction flags, validity expiry and source-based updates. Auto-approved changes limited to low-risk derived indexes; promotion to authoritative business facts requires deterministic evidence or explicitly authorized review. Rebuild all derived indices after restore with ACL provenance preserved. Deletion and connector permission revocations invalidate chunks, embeddings, caches, agent available context and shared summaries as soon as feasible under defined guarantees.

## Confidentiality

No blanket 'company-wide AI memory' permission. Personal, project, team, organizational and restricted scopes are distinct. Secret stores are never indexed; sensitive connector responses should be sanitized before embedding. BYOM does not eliminate SaaS infrastructure exposure. Sovereign offline mode processes knowledge locally and must not require external embedding providers; model capability tests apply to local embeddings too.

## Quality evaluation

Measure recall under ACL, evidence citation validity, freshness, hallucination rate, unauthorized context exposure (zero tolerance), missing deletion propagation, end-to-end index lag and cost per successful answer. If more knowledge decreases correctness, context selection must be improved before buying larger models.
