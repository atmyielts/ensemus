-- The question is data too: it can quote a secret even when retrieval returns no passages. Legacy and
-- omitted classifications fail closed. Approved additive correction during M5 integration, 2026-11-06.
ALTER TABLE knowledge.answers ADD COLUMN question_classification text NOT NULL DEFAULT 'restricted';
--> statement-breakpoint
ALTER TABLE knowledge.answers ADD CONSTRAINT knowledge_answers_question_class
  CHECK (question_classification IN ('public','internal','confidential','restricted'));
--> statement-breakpoint
GRANT INSERT (question_classification) ON knowledge.answers TO ensemus_app;
--> statement-breakpoint
-- A trusted fact is an input too. Record its ID, without copying its claim into the audit package.
ALTER TABLE knowledge.evidence_packages ADD COLUMN verified_fact_ids uuid[] NOT NULL DEFAULT '{}';
