-- Approximate vector search for company knowledge (ADR-029 D6 addendum). One partial HNSW index per common
-- embedding width, on the cast the query uses, because `knowledge.embeddings.embedding` has no fixed width
-- and HNSW needs one. HNSW_INDEXED_DIMENSIONS in @ensemus/domain/knowledge names the same indexes, and a
-- test holds the two together. Nothing here decides who may read a row: retrieval still names
-- knowledge.readable_source_ids inside the same statement, and pgvector's iterative scan keeps walking
-- the graph until enough authorized rows are found. A space of any other width is searched exactly.
--
-- Built in the migration's transaction. On a deployment that already holds millions of vectors, an
-- operator may create these by hand first with CREATE INDEX CONCURRENTLY under the same names; IF NOT
-- EXISTS then leaves them alone.
CREATE INDEX IF NOT EXISTS knowledge_embeddings_hnsw_384 ON knowledge.embeddings
  USING hnsw ((embedding::public.vector(384)) public.vector_cosine_ops) WHERE dimension = 384;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS knowledge_embeddings_hnsw_768 ON knowledge.embeddings
  USING hnsw ((embedding::public.vector(768)) public.vector_cosine_ops) WHERE dimension = 768;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS knowledge_embeddings_hnsw_1024 ON knowledge.embeddings
  USING hnsw ((embedding::public.vector(1024)) public.vector_cosine_ops) WHERE dimension = 1024;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS knowledge_embeddings_hnsw_1536 ON knowledge.embeddings
  USING hnsw ((embedding::public.vector(1536)) public.vector_cosine_ops) WHERE dimension = 1536;
--> statement-breakpoint
-- HNSW indexes `vector` up to 2,000 dimensions. Wider spaces are indexed at half precision; the stored
-- vectors keep full precision, and the query casts the same way.
CREATE INDEX IF NOT EXISTS knowledge_embeddings_hnsw_3072 ON knowledge.embeddings
  USING hnsw ((embedding::public.halfvec(3072)) public.halfvec_cosine_ops) WHERE dimension = 3072;
