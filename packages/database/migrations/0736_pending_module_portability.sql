-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (COMM-05, ADR-030). Human security review remains pending.
-- The frozen /3 format cannot carry M11 data. Empty tenants may still use it, but a native,
-- tenant-scoped boolean must prove emptiness even when caller RLS hides the new records.
-- No customer row or count is exposed and no application/worker SELECT/DELETE grant is added.
DO $$ BEGIN
  IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'PORTABILITY_GUARD_MIGRATION_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;
END $$;
--> statement-breakpoint
CREATE POLICY portable_pending_probe ON integrations.business_record_actions FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON integrations.business_records FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON meetings.consent_records FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON meetings.derivation_runs FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON meetings.import_requests FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON meetings.notes FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON meetings.participants FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON meetings.proposed_items FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON meetings.provider_approvals FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON meetings.settings FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON meetings.summaries FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON meetings.meetings FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON marketplace.installations FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON marketplace.listings FOR SELECT TO ensemus_migrator USING(publisher_organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON marketplace.publishers FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON marketplace.security_reviews FOR SELECT TO ensemus_migrator USING(submission_organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON marketplace.submissions FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON sandbox.runs FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON skills.packages FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON skills.test_runs FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON skills.package_versions FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON skills.trusted_signers FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON tenancy.residency_requirements FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON federation.org_settings FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON federation.grants FOR SELECT TO ensemus_migrator USING(sharing_organization_id=app.current_organization_id() OR receiving_organization_id=app.current_organization_id() OR ended_by_organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON federation.outbound_items FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON federation.inbound_items FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id() OR sender_organization_id=app.current_organization_id());
CREATE POLICY portable_pending_probe ON federation.crossings FOR SELECT TO ensemus_migrator USING(sender_organization_id=app.current_organization_id() OR receiver_organization_id=app.current_organization_id());
--> statement-breakpoint
CREATE FUNCTION sovereign.pending_modules_empty() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF app.current_organization_id() IS NULL OR app.tier_session_user()<>'ensemus_app' THEN
    RETURN false;
  END IF;
  -- RLS on the fixed owner's probes is scoped to the bound tenant, including both federation parties.
  -- In particular a caller's zero visible notes is never evidence that this company has no notes.
  RETURN NOT (
EXISTS(SELECT 1 FROM integrations.business_record_actions WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM integrations.business_records WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM meetings.consent_records WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM meetings.derivation_runs WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM meetings.import_requests WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM meetings.notes WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM meetings.participants WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM meetings.proposed_items WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM meetings.provider_approvals WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM meetings.settings WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM meetings.summaries WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM meetings.meetings WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM marketplace.installations WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM marketplace.listings WHERE publisher_organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM marketplace.publishers WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM marketplace.security_reviews WHERE submission_organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM marketplace.submissions WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM sandbox.runs WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM skills.packages WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM skills.test_runs WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM skills.package_versions WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM skills.trusted_signers WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM tenancy.residency_requirements WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM federation.org_settings WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM federation.grants WHERE sharing_organization_id=app.current_organization_id() OR receiving_organization_id=app.current_organization_id() OR ended_by_organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM federation.outbound_items WHERE organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM federation.inbound_items WHERE organization_id=app.current_organization_id() OR sender_organization_id=app.current_organization_id())
    OR EXISTS(SELECT 1 FROM federation.crossings WHERE sender_organization_id=app.current_organization_id() OR receiver_organization_id=app.current_organization_id())
  );
END $$;
REVOKE ALL ON FUNCTION sovereign.pending_modules_empty() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.pending_modules_empty() TO ensemus_app;
--> statement-breakpoint
-- Any new-module write supersedes an existing /3 archive for every affected company. Writers take
-- the epoch row last; export/download readers retain plain SELECTs, never an epoch lock across I/O.
-- The selector is used only by this fixed trigger owner, never as an application credential.
CREATE POLICY pending_module_epoch_write ON sovereign.export_epochs TO ensemus_migrator
  USING(organization_id=nullif(current_setting('sovereign.pending_epoch_tenant',true),'')::uuid)
  WITH CHECK(organization_id=nullif(current_setting('sovereign.pending_epoch_tenant',true),'')::uuid);
CREATE FUNCTION sovereign.advance_pending_module_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE columns text[]; tenant uuid; previous_tenant text; before_row jsonb; after_row jsonb;
BEGIN
  IF TG_LEVEL<>'ROW' OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'PORTABILITY_PENDING_TRIGGER_REQUIRED' USING ERRCODE='42501';
  END IF;
  CASE TG_RELID
    WHEN 'integrations.business_record_actions'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'integrations.business_records'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'meetings.consent_records'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'meetings.derivation_runs'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'meetings.import_requests'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'meetings.notes'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'meetings.participants'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'meetings.proposed_items'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'meetings.provider_approvals'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'meetings.settings'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'meetings.summaries'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'meetings.meetings'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'marketplace.installations'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'marketplace.listings'::regclass THEN columns:=ARRAY['publisher_organization_id'];
    WHEN 'marketplace.publishers'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'marketplace.security_reviews'::regclass THEN columns:=ARRAY['submission_organization_id'];
    WHEN 'marketplace.submissions'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'sandbox.runs'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'skills.packages'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'skills.test_runs'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'skills.package_versions'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'skills.trusted_signers'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'tenancy.residency_requirements'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'federation.org_settings'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'federation.grants'::regclass THEN columns:=ARRAY['sharing_organization_id','receiving_organization_id','ended_by_organization_id'];
    WHEN 'federation.outbound_items'::regclass THEN columns:=ARRAY['organization_id'];
    WHEN 'federation.inbound_items'::regclass THEN columns:=ARRAY['organization_id','sender_organization_id'];
    WHEN 'federation.crossings'::regclass THEN columns:=ARRAY['sender_organization_id','receiver_organization_id'];
    ELSE RAISE EXCEPTION 'PORTABILITY_PENDING_TRIGGER_REQUIRED' USING ERRCODE='42501';
  END CASE;
  before_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  after_row:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  previous_tenant:=current_setting('sovereign.pending_epoch_tenant',true);
  BEGIN
    -- Stable order prevents opposite-direction federation writes locking their two epoch rows backwards.
    FOR tenant IN SELECT DISTINCT value::uuid FROM (
      SELECT before_row->>name AS value FROM unnest(columns) name
      UNION ALL SELECT after_row->>name FROM unnest(columns) name
    ) parties WHERE value IS NOT NULL ORDER BY value::uuid LOOP
      PERFORM set_config('sovereign.pending_epoch_tenant',tenant::text,true);
      -- Organization creation already creates the epoch. INSERT ON CONFLICT would first invoke
      -- the unrelated tenant-birth fence with the peer's ID, even when that epoch already exists.
      UPDATE sovereign.export_epochs SET epoch=epoch+1 WHERE organization_id=tenant;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PORTABILITY_PENDING_EPOCH_REQUIRED' USING ERRCODE='EN301';
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('sovereign.pending_epoch_tenant',coalesce(previous_tenant,''),true); RAISE;
  END;
  PERFORM set_config('sovereign.pending_epoch_tenant',coalesce(previous_tenant,''),true);
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION sovereign.advance_pending_module_epoch() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON integrations.business_record_actions
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON integrations.business_records
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON meetings.consent_records
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON meetings.derivation_runs
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON meetings.import_requests
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON meetings.notes
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON meetings.participants
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON meetings.proposed_items
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON meetings.provider_approvals
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON meetings.settings
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON meetings.summaries
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON meetings.meetings
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON marketplace.installations
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON marketplace.listings
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON marketplace.publishers
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON marketplace.security_reviews
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON marketplace.submissions
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON sandbox.runs
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON skills.packages
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON skills.test_runs
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON skills.package_versions
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON skills.trusted_signers
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON tenancy.residency_requirements
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON federation.org_settings
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON federation.grants
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON federation.outbound_items
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON federation.inbound_items
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE OR DELETE ON federation.crossings
  FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
