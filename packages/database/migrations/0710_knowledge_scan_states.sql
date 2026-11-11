-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-029 D4 addendum). Changes here need human review, never agent approval. Not
-- yet reviewed by a person. Malware scanning gets a real state machine, and an infected file can never be
-- searchable, whatever the code does:
-- 1. `flagged` becomes `infected`, and `scan_failed` is added for a scanner that was asked and could not
--    answer. No scanner implementation existed before this migration, so no `flagged` row is expected;
--    any there is renamed, with row-level security lifted for that one statement by the table's owner.
-- 2. A check: an infected document is only ever `rejected` or `purged`. Retrieval serves `searchable`
--    documents only, so no passage of an infected file can be served, even if a bug wrote one.
-- 3. A trigger holding SCAN_TRANSITIONS in @ensemus/domain/knowledge, with a test holding the two
--    together: nothing returns to `not_scanned`, and nothing leaves `infected`.
ALTER TABLE knowledge.documents DROP CONSTRAINT knowledge_documents_scan_check;
--> statement-breakpoint
ALTER TABLE knowledge.documents NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE knowledge.documents SET scan_state = 'infected' WHERE scan_state = 'flagged';
--> statement-breakpoint
ALTER TABLE knowledge.documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE knowledge.documents ADD CONSTRAINT knowledge_documents_scan_check
  CHECK (scan_state IN ('not_scanned', 'clean', 'infected', 'scan_failed'));
--> statement-breakpoint
ALTER TABLE knowledge.documents ADD CONSTRAINT knowledge_documents_infected_quarantined
  CHECK (scan_state <> 'infected' OR state IN ('rejected', 'purged'));
--> statement-breakpoint
CREATE FUNCTION knowledge.check_scan_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_RELID <> 'knowledge.documents'::regclass OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'KNOWLEDGE_SCAN_GUARD_TARGET_INVALID' USING ERRCODE = '42501';
  END IF;
  IF NEW.scan_state IS NOT DISTINCT FROM OLD.scan_state THEN
    RETURN NEW;
  END IF;
  IF NOT CASE OLD.scan_state
      WHEN 'not_scanned' THEN NEW.scan_state IN ('clean', 'infected', 'scan_failed')
      WHEN 'scan_failed' THEN NEW.scan_state IN ('clean', 'infected')
      WHEN 'clean' THEN NEW.scan_state IN ('infected', 'scan_failed')
      ELSE false
    END THEN
    RAISE EXCEPTION 'KNOWLEDGE_SCAN_INVALID_TRANSITION' USING ERRCODE = 'EN106';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION knowledge.check_scan_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER documents_check_scan
  BEFORE UPDATE OF scan_state ON knowledge.documents
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_scan_change();
