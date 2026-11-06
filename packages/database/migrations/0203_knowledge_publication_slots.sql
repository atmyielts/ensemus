-- A staged revision must coexist with the last published revision. Publication replaces the current
-- revision atomically under the source lock; failed parsing must not remove the searchable version.
-- The previous index accidentally reserved the current slot for every non-purged document.
LOCK TABLE knowledge.documents IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DROP INDEX knowledge.knowledge_documents_one_current;
--> statement-breakpoint
CREATE UNIQUE INDEX knowledge_documents_one_current ON knowledge.documents (organization_id, source_id)
  WHERE superseded_at IS NULL AND state = 'searchable';
--> statement-breakpoint
CREATE UNIQUE INDEX knowledge_documents_one_pending ON knowledge.documents (organization_id, source_id)
  WHERE state IN ('received','parsing');
