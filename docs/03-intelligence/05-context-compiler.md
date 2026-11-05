# Context compiler — minimum sufficient authorized context

The Context Compiler is a deterministic orchestration component that creates a **bounded, authorized context package** for each inference. Its inputs include actor/delegation identity, tenant, Work Unit, task type, allowed knowledge scopes, current policies, purpose and token/cost limit.

## Stages

1. Verify actor/service grant; resolve Work Unit and task purpose.
2. Select authoritative structured records and applicable policy; never replace typed state with embeddings.
3. Retrieve authorized lexical and semantic candidates using ACL prefilter, source/recency relevance and entity relationship edges.
4. Rerank under privacy policy; deduplicate near-identical content, discard expired/conflicting derived summaries.
5. Construct stable static instruction prefix, compact task state, allowed tools and evidence sections with source IDs and citations.
6. Check provider egress against **every included data classification**. If the chosen model is unauthorized, reroute among explicitly allowed deployments or stop.
7. Enforce context and latency budgets; trim least relevant content while preserving mandatory safety/system constraints.
8. Record hashes, source IDs, budget usage and applied policy (not raw restricted content in default traces).

## Contract properties

Compiler output is reproducible for pinned data versions and policy states, auditable for source references, and safe for the selected provider profile. It must differentiate user input, retrieved evidence, tool output and system policy using structured message roles, avoiding 'instruction laundering' from untrusted documents.

## Performance

Cache static agent definitions and stable policy sections by version. Cache retrieval only with tenant+ACL version+source versions+data classification+query fingerprint; invalidate on membership changes, source ACL revocations, deletion, or source version change. Batch lightweight embedding lookups where safe, but never cache plaintext across organizations.

## Verification

Test mixed-sensitive documents, stale client agreements, denied provider fallback, user revocation mid-run, enormous tool outputs, conflicting facts, poisoned retrieved text, bad citations and multi-model adapter changes. Context quality is a primary cost and correctness lever.
