-- FLAGGED FOR HUMAN SECURITY REVIEW
-- COMM-05, ADR-030 D7-D10 and ADR-035 D4. A separate archive profile explicitly excludes
-- deployment-scoped federation trust and copies. The earlier profile's proof remains unchanged.
CREATE FUNCTION sovereign.portable_profile_clear(p_profile text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();
BEGIN
  IF tenant IS NULL OR app.tier_session_user()<>'ensemus_app' THEN RETURN false;END IF;
  IF p_profile='ensemus.m3-m7/3' THEN RETURN sovereign.pending_modules_empty();END IF;
  IF p_profile IS DISTINCT FROM 'ensemus.m3-m7-federation/4' THEN RETURN false;END IF;
  -- The fixed owner sees the tenant's module presence independently of the requesting owner's
  -- visibility. Other expansion data still refuses this profile until its own coverage exists.
  RETURN NOT (
    EXISTS(SELECT 1 FROM integrations.business_record_actions WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM integrations.business_records WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM meetings.consent_records WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM meetings.derivation_runs WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM meetings.import_requests WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM meetings.notes WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM meetings.participants WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM meetings.proposed_items WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM meetings.provider_approvals WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM meetings.settings WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM meetings.summaries WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM meetings.meetings WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.installations WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.listings WHERE publisher_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.publishers WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.security_reviews WHERE submission_organization_id=tenant)
    OR EXISTS(SELECT 1 FROM marketplace.submissions WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM sandbox.runs WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM skills.packages WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM skills.test_runs WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM skills.package_versions WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM skills.bundle_uploads WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM skills.trusted_signers WHERE organization_id=tenant)
    OR EXISTS(SELECT 1 FROM tenancy.residency_requirements WHERE organization_id=tenant)
  );
END $$;
REVOKE ALL ON FUNCTION sovereign.portable_profile_clear(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sovereign.portable_profile_clear(text) TO ensemus_app;
--> statement-breakpoint
ALTER TABLE sovereign.organization_exports
  DROP CONSTRAINT organization_exports_inventory_version_check,
  ADD CONSTRAINT organization_exports_inventory_version_check CHECK (
    inventory_version IS NULL OR inventory_version IN ('ensemus.m3-m7/3','ensemus.m3-m7-federation/4')
  );

-- Only the native worker can propose the new pin. The trigger below admits it once.
GRANT UPDATE (inventory_version) ON sovereign.organization_exports TO ensemus_worker;
CREATE OR REPLACE FUNCTION sovereign.guard_export_inventory_pin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.inventory_version IS NOT NULL THEN
      RAISE EXCEPTION 'EXPORT_INVENTORY_NOT_PINNED' USING ERRCODE='EN301';
    END IF;
  ELSIF OLD.status='requested' AND NEW.status='running' AND OLD.inventory_version IS NULL THEN
    IF NEW.inventory_version IS NULL THEN
      -- Old workers retain their original default and can never pin the extended profile.
      NEW.inventory_version:='ensemus.m3-m7/3';
    ELSIF NEW.inventory_version<>'ensemus.m3-m7-federation/4'
      OR session_user<>'ensemus_worker' OR current_user<>session_user OR NOT knowledge.is_service_actor()
      OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR NOT sovereign.portable_profile_clear(NEW.inventory_version) THEN
      RAISE EXCEPTION 'EXPORT_INVENTORY_NOT_PINNED' USING ERRCODE='EN301';
    END IF;
  ELSIF NEW.inventory_version IS DISTINCT FROM OLD.inventory_version THEN
    RAISE EXCEPTION 'EXPORT_INVENTORY_IMMUTABLE' USING ERRCODE='EN301';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $migration$
DECLARE definition text:=pg_get_functiondef('sovereign.portable_export_viewer()'::regprocedure);
  pin constant text:='e.inventory_version=''ensemus.m3-m7/3''';
BEGIN
  -- Reuse the existing exact bound export, epoch and live-owner checks.
  IF strpos(definition,pin)=0 THEN RAISE EXCEPTION 'EXPORT_VIEWER_PROFILE_CHANGED' USING ERRCODE='EN301';END IF;
  EXECUTE replace(definition,pin,
    'e.inventory_version IN(''ensemus.m3-m7/3'',''ensemus.m3-m7-federation/4'')
      AND sovereign.portable_profile_clear(e.inventory_version)');
END $migration$;
