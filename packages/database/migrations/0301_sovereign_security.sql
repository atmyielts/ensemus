-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-030). Changes here need human review, never agent approval.

-- Forced RLS and the tenant policy on every table in the new schema. A test fails if one misses it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'sovereign' LOOP
    EXECUTE format('ALTER TABLE sovereign.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE sovereign.%I FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format(
      'CREATE POLICY tenant_scoped ON sovereign.%I TO ensemus_app '
      'USING (organization_id = app.current_organization_id()) '
      'WITH CHECK (organization_id = app.current_organization_id())',
      t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

-- Only the application role comes here, which is the web tier and the operator commands. No new role, so
-- an upgrade needs no new database credential (ADR-030 D2). The dispatcher works from event metadata.
GRANT USAGE ON SCHEMA sovereign TO ensemus_app;
--> statement-breakpoint

-- Signed documents are added and read, and never changed. A row here proves nothing by itself: the
-- envelope is checked against the trust root each time it is read, so a row written by anything other
-- than the verifier is just a file that does not verify.
GRANT SELECT, INSERT ON sovereign.license_records TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON sovereign.signed_documents TO ensemus_app;
--> statement-breakpoint
CREATE TRIGGER license_records_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON sovereign.license_records
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER signed_documents_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON sovereign.signed_documents
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- An export's recipient and who asked are fixed when it is written. Sealing to another key takes a new
-- export, which takes a new request from someone allowed to make one.
GRANT SELECT, INSERT ON sovereign.organization_exports TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, version, progress, snapshot_at, tombstones_through, manifest_sealed_sha256,
              part_count, record_count, archive_bytes, excluded_restricted_work,
              excluded_restricted_artifacts, excluded_restricted_clients, failure_code, started_at,
              finished_at, expires_at, purged_at, updated_at)
  ON sovereign.organization_exports TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON sovereign.organization_export_parts TO ensemus_app;
--> statement-breakpoint
CREATE TRIGGER organization_export_parts_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON sovereign.organization_export_parts
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- The statuses match EXPORT_TRANSITIONS in @ensemus/domain/portability, and a test holds the two together.
-- Nothing goes back to ready, so bytes that were purged can never be offered again.
CREATE FUNCTION sovereign.check_export_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT CASE OLD.status
    WHEN 'requested' THEN NEW.status IN ('running', 'failed')
    WHEN 'running' THEN NEW.status IN ('ready', 'failed')
    WHEN 'ready' THEN NEW.status = 'expired'
    ELSE false
  END THEN
    RAISE EXCEPTION 'ORGANIZATION_EXPORT_INVALID_TRANSITION' USING ERRCODE = 'EN006';
  END IF;
  IF NEW.status = 'ready' AND (NEW.manifest_sealed_sha256 IS NULL OR NEW.snapshot_at IS NULL) THEN
    RAISE EXCEPTION 'ORGANIZATION_EXPORT_NOT_FINISHED' USING ERRCODE = 'EN006';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organization_exports_check_change
  BEFORE UPDATE ON sovereign.organization_exports
  FOR EACH ROW EXECUTE FUNCTION sovereign.check_export_change();
--> statement-breakpoint

-- Imports. Who asked, and who stands in for people not yet linked, are fixed when it is written. The partial
-- unique index in 0300 means an organization takes one import ever, unless it failed, so an archive can
-- never be merged over live data.
GRANT SELECT, INSERT ON sovereign.organization_imports TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, source_organization_id, source_export_id, source_release, archive_sha256,
              exported_at, version, applied_counts, warning_counts, failure_code, started_at,
              finished_at, updated_at)
  ON sovereign.organization_imports TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON sovereign.organization_import_parts TO ensemus_app;
--> statement-breakpoint
CREATE TRIGGER organization_import_parts_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON sovereign.organization_import_parts
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION sovereign.check_import_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT CASE OLD.status
    WHEN 'requested' THEN NEW.status IN ('running', 'failed')
    WHEN 'running' THEN NEW.status IN ('completed', 'completed_with_warnings', 'failed')
    WHEN 'failed' THEN NEW.status = 'running'
    ELSE false
  END THEN
    RAISE EXCEPTION 'ORGANIZATION_IMPORT_INVALID_TRANSITION' USING ERRCODE = 'EN006';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organization_imports_check_change
  BEFORE UPDATE ON sovereign.organization_imports
  FOR EACH ROW EXECUTE FUNCTION sovereign.check_import_change();
--> statement-breakpoint

-- Who someone was at the source. Linking them to a membership here happens once, and is what lets a person
-- who joined take over what they owned. It grants nothing by itself.
GRANT SELECT, INSERT ON sovereign.imported_people TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (target_membership_id, invitation_id, linked_at)
  ON sovereign.imported_people TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION sovereign.check_imported_person_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.linked_at IS NOT NULL AND NEW.target_membership_id IS DISTINCT FROM OLD.target_membership_id THEN
    RAISE EXCEPTION 'IMPORTED_PERSON_ALREADY_LINKED' USING ERRCODE = 'EN006';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER imported_people_check_change
  BEFORE UPDATE ON sovereign.imported_people
  FOR EACH ROW EXECUTE FUNCTION sovereign.check_imported_person_change();
--> statement-breakpoint

-- What happened elsewhere, kept as it was exported and never made live (ADR-030 D9).
GRANT SELECT, INSERT ON sovereign.imported_records TO ensemus_app;
--> statement-breakpoint
CREATE TRIGGER imported_records_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON sovereign.imported_records
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
