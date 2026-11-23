-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (EXP-03, ADR-033 D5). Human security review remains pending.
-- Bind connector notes to the pending request and its native worker, without changing manual notes.
CREATE FUNCTION meetings.guard_connector_note() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'ensemus_connector' OR current_user IS DISTINCT FROM session_user
    OR app.current_actor_type() IS DISTINCT FROM 'service'
    OR NEW.imported_by_membership_id IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM meetings.import_requests r
      WHERE r.organization_id=NEW.organization_id AND r.id=NEW.id AND r.meeting_id=NEW.meeting_id
        AND r.source_approval_id=NEW.source_approval_id AND r.status='requested'
        AND r.temporal_run_id IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'MEETING_IMPORT_STORE_NOT_ALLOWED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION meetings.guard_connector_note() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER notes_guard_connector_store
  BEFORE INSERT ON meetings.notes
  FOR EACH ROW WHEN (NEW.source_kind='connector')
  EXECUTE FUNCTION meetings.guard_connector_note();
--> statement-breakpoint
CREATE FUNCTION meetings.guard_import_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.temporal_run_id IS DISTINCT FROM OLD.temporal_run_id OR NEW.status='completed' THEN
    IF session_user IS DISTINCT FROM 'ensemus_connector' OR current_user IS DISTINCT FROM session_user
      OR app.current_actor_type() IS DISTINCT FROM 'service'
      OR NEW.temporal_run_id IS NULL OR OLD.status <> 'requested'
      OR (OLD.temporal_run_id IS NOT NULL AND NEW.temporal_run_id IS DISTINCT FROM OLD.temporal_run_id)
      OR (NEW.status='completed' AND NOT EXISTS (
        SELECT 1 FROM meetings.notes n
        WHERE n.organization_id=NEW.organization_id AND n.id=NEW.id
          AND n.meeting_id=NEW.meeting_id AND n.source_approval_id=NEW.source_approval_id
          AND n.source_kind='connector' AND n.purged_at IS NULL
      ))
    THEN
      RAISE EXCEPTION 'MEETING_IMPORT_BINDING_NOT_ALLOWED' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION meetings.guard_import_binding() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER import_requests_guard_binding
  BEFORE UPDATE ON meetings.import_requests
  FOR EACH ROW EXECUTE FUNCTION meetings.guard_import_binding();
