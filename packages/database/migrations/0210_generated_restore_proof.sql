-- A restored generated-file ledger entry is not applied merely because its tombstone is back.
-- Keep this marker until the lifecycle has proved fenced writers, absent bytes and removed metadata.
-- Ordinary asynchronous purges never set it and do not close an otherwise current tenant.
ALTER TABLE knowledge.artifact_lineage ADD COLUMN restore_reapply_pending boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE knowledge.artifact_lineage ADD CONSTRAINT artifact_restore_pending_shape
  CHECK (NOT restore_reapply_pending OR state='blocked');
--> statement-breakpoint
CREATE FUNCTION knowledge.guard_generated_restore_proof() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.restore_reapply_pending THEN
      RAISE EXCEPTION 'ARTIFACT_RESTORE_UNCONFIRMED' USING ERRCODE='EN118';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.restore_reapply_pending IS NOT DISTINCT FROM OLD.restore_reapply_pending THEN RETURN NEW; END IF;
  IF NOT knowledge.is_service_actor() THEN
    RAISE EXCEPTION 'ARTIFACT_RESTORE_NEEDS_SERVICE' USING ERRCODE='42501';
  END IF;
  IF NEW.restore_reapply_pending THEN
    IF NEW.state<>'blocked' OR NOT EXISTS(SELECT 1 FROM platform.tombstones t
      WHERE t.organization_id=NEW.organization_id AND t.target_type='artifact' AND t.target_id=NEW.artifact_id) THEN
      RAISE EXCEPTION 'ARTIFACT_RESTORE_UNCONFIRMED' USING ERRCODE='EN118';
    END IF;
  ELSE
    IF NEW.state<>'blocked' OR NEW.physical_purged_at IS NULL OR NEW.write_state NOT IN ('settled','fenced')
      OR NEW.write_id<>OLD.write_id OR NEW.generation<>OLD.generation OR NEW.held
      OR EXISTS(SELECT 1 FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=NEW.organization_id
        AND a.artifact_id=NEW.artifact_id AND a.alive)
      OR EXISTS(SELECT 1 FROM work.artifacts a WHERE a.organization_id=NEW.organization_id AND a.id=NEW.artifact_id)
      OR NOT EXISTS(SELECT 1 FROM platform.blob_lifecycle b WHERE b.organization_id=NEW.organization_id
        AND b.artifact_id=NEW.artifact_id AND b.object_key=NEW.object_key AND b.state='purged' AND b.purged_at IS NOT NULL)
      OR NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=NEW.organization_id
        AND t.target_type='artifact' AND t.target_id=NEW.artifact_id) THEN
      RAISE EXCEPTION 'ARTIFACT_RESTORE_UNCONFIRMED' USING ERRCODE='EN118';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_generated_restore_proof() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER artifact_generated_restore_proof BEFORE UPDATE OR DELETE ON knowledge.artifact_lineage
  FOR EACH ROW EXECUTE FUNCTION knowledge.guard_generated_restore_proof();
