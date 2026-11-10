-- REVIEWED SECURITY SQL (ADR-029 D3, ADR-026 D3). Changes here need human review, never agent approval.
-- 0532 (knowledge): additive repair for registered 0205 and 0516, which are pushed, so they are not edited.
--
-- ADR-029 D3 has the purge remove a closed source's stored bytes, check they have gone, and count
-- each removal; the counts are the evidence a purge reports. 0205 counted a blob only when the purge
-- itself had seen the bytes before deleting them. 0516 moved the deletion onto the admitted native
-- protocol and recomputes knowledge.documents.object_purge_observed from the retained native history
-- alone (a finished PUT), because a provider DELETE cannot say whether anything was there. Bytes that
-- had already vanished from storage were then reported as removed by this purge, which overstates
-- what it did (an entry is not proof of a deletion, ADR-026 D3).
--
-- The repair records one observation per document: whether its bytes were present when the native
-- raw port first reached it for erasure, before its single admitted DELETE
-- (knowledge.documents.object_present_before_purge, NULL until observed). The purge counts a present
-- blob in blobs_removed and an already-absent one in a separate knowledge.purge_jobs.blobs_absent.
-- Both are counts only: neither the observation nor either counter admits, qualifies or completes a
-- deletion. 0516's claim, terminal outcome, physical-absence proof and sealed inventory remain the
-- only authority, unchanged.
--
-- Grants: ensemus_app gains UPDATE on exactly these two columns, as 0205 granted it
-- object_purge_observed and the other counters. RLS already confines document and job updates to the
-- service actor (0201, 0213). The guards below also refuse a person or agent, an observation of a
-- source that is still active, any change to an observation once made, and a decrease of
-- blobs_absent. No other role, policy or function changes.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'PURGE_PRESENCE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regclass('knowledge.documents') IS NULL OR to_regclass('knowledge.purge_jobs') IS NULL
  OR to_regprocedure('knowledge.is_service_actor()') IS NULL OR to_regprocedure('lifecycle.object_delete_absent(uuid)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='knowledge.documents'::regclass AND a.attname='object_purge_observed' AND NOT a.attisdropped)
  OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='knowledge.purge_jobs'::regclass AND a.attname='blobs_removed' AND NOT a.attisdropped)
  OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='knowledge.documents'::regclass AND a.attname='object_present_before_purge')
  OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='knowledge.purge_jobs'::regclass AND a.attname='blobs_absent') THEN
  RAISE EXCEPTION 'PURGE_PRESENCE_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
ALTER TABLE knowledge.documents ADD COLUMN object_present_before_purge boolean;
--> statement-breakpoint
ALTER TABLE knowledge.purge_jobs ADD COLUMN blobs_absent integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE knowledge.purge_jobs ADD CONSTRAINT knowledge_purge_blobs_absent CHECK (blobs_absent >= 0);
--> statement-breakpoint
GRANT UPDATE(object_present_before_purge) ON knowledge.documents TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE(blobs_absent) ON knowledge.purge_jobs TO ensemus_app;
--> statement-breakpoint
-- Written once, by the service, for a closed source only. A source never reopens (ADR-029 D3), so an
-- observation can never be taken while new bytes could still arrive.
CREATE FUNCTION knowledge.guard_document_purge_presence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.object_present_before_purge IS NOT DISTINCT FROM OLD.object_present_before_purge THEN RETURN NEW; END IF;
  IF NOT knowledge.is_service_actor() OR OLD.object_present_before_purge IS NOT NULL OR NEW.object_present_before_purge IS NULL
    OR NOT EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.source_id
      AND s.state IN('revoked','deleted')) THEN
    RAISE EXCEPTION 'KNOWLEDGE_PURGE_PRESENCE_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION knowledge.guard_document_purge_presence() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER documents_purge_presence BEFORE UPDATE OF object_present_before_purge ON knowledge.documents
  FOR EACH ROW EXECUTE FUNCTION knowledge.guard_document_purge_presence();
--> statement-breakpoint
CREATE FUNCTION knowledge.guard_purge_absent_count() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.blobs_absent IS NOT DISTINCT FROM OLD.blobs_absent THEN RETURN NEW; END IF;
  IF NOT knowledge.is_service_actor() OR NEW.blobs_absent < OLD.blobs_absent THEN
    RAISE EXCEPTION 'KNOWLEDGE_PURGE_UNCONFIRMED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION knowledge.guard_purge_absent_count() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER purge_jobs_absent_count BEFORE UPDATE OF blobs_absent ON knowledge.purge_jobs
  FOR EACH ROW EXECUTE FUNCTION knowledge.guard_purge_absent_count();
