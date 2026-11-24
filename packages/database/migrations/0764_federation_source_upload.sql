-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (EXP-07, ADR-035 D3/D4). Human security review remains pending.
-- NULL represents existing sender snapshots staged under the previous protocol.
ALTER TABLE federation.outbound_items
  ADD COLUMN source_upload_state text,
  ADD CONSTRAINT outbound_items_source_upload_state CHECK (
    source_upload_state IS NULL OR (
      kind='artifact' AND source_type IS NOT DISTINCT FROM 'artifact' AND source_id IS NOT NULL
      AND source_upload_state IN ('pending','admitted','verified')
    )
  );
--> statement-breakpoint
GRANT UPDATE (source_upload_state) ON federation.outbound_items TO ensemus_worker;
--> statement-breakpoint
CREATE FUNCTION federation.check_source_upload() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.source_upload_state IS NOT NULL AND NEW.source_upload_state <> 'pending' THEN
      RAISE EXCEPTION 'FEDERATION_SOURCE_UPLOAD_INVALID' USING ERRCODE='EN727';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_upload_state IS DISTINCT FROM OLD.source_upload_state THEN
    IF current_user <> 'ensemus_worker' OR session_user <> current_user
      OR app.current_actor_type() IS DISTINCT FROM 'service'
      OR app.current_organization_id() IS DISTINCT FROM OLD.organization_id
      OR (to_jsonb(NEW) - 'source_upload_state') IS DISTINCT FROM
        (to_jsonb(OLD) - 'source_upload_state') THEN
      RAISE EXCEPTION 'FEDERATION_SOURCE_WORKER_REQUIRED' USING ERRCODE='42501';
    END IF;
    IF NEW.source_upload_state IS NULL OR NOT COALESCE(
      (OLD.source_upload_state='pending' AND NEW.source_upload_state='admitted'
        AND OLD.state='queued' AND federation.grant_is_open(OLD.grant_id)
        AND EXISTS (SELECT 1 FROM federation.grants g WHERE g.id=OLD.grant_id AND g.expires_at>clock_timestamp()))
      OR (OLD.source_upload_state='admitted' AND NEW.source_upload_state='verified'),
      false
    ) THEN
      RAISE EXCEPTION 'FEDERATION_SOURCE_UPLOAD_INVALID' USING ERRCODE='EN727';
    END IF;
  ELSE
    IF NEW.copy_receiver_organization_id IS DISTINCT FROM OLD.copy_receiver_organization_id
      AND OLD.source_upload_state IN ('pending','admitted') THEN
      RAISE EXCEPTION 'FEDERATION_SOURCE_UPLOAD_UNPROVEN' USING ERRCODE='EN727';
    END IF;
    IF NEW.outbound_delete_state IS DISTINCT FROM OLD.outbound_delete_state
      AND (OLD.source_upload_state='admitted'
        OR (OLD.source_upload_state='pending' AND NEW.outbound_delete_state <> 'proved')) THEN
      RAISE EXCEPTION 'FEDERATION_SOURCE_UPLOAD_UNPROVEN' USING ERRCODE='EN727';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION federation.check_source_upload() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER outbound_items_source_upload_insert
  BEFORE INSERT ON federation.outbound_items
  FOR EACH ROW EXECUTE FUNCTION federation.check_source_upload();
--> statement-breakpoint
CREATE TRIGGER outbound_items_source_upload_update
  BEFORE UPDATE ON federation.outbound_items
  FOR EACH ROW EXECUTE FUNCTION federation.check_source_upload();
--> statement-breakpoint
-- The original guard owns all other lifecycle transitions. Changing the sender stage
-- takes the narrower guard above, which refuses changes to any other column.
DROP TRIGGER outbound_items_check_change ON federation.outbound_items;
--> statement-breakpoint
CREATE TRIGGER outbound_items_check_change
  BEFORE UPDATE ON federation.outbound_items
  FOR EACH ROW WHEN (OLD.source_upload_state IS NOT DISTINCT FROM NEW.source_upload_state)
  EXECUTE FUNCTION federation.check_outbound_change();
