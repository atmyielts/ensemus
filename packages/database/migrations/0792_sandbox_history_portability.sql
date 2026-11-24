-- FLAGGED FOR HUMAN SECURITY REVIEW
-- COMM-05 and EXP-05. Carry completed verification and the owner's own trial receipts.
ALTER TABLE sovereign.organization_exports
  DROP CONSTRAINT organization_exports_inventory_version_check,
  ADD CONSTRAINT organization_exports_inventory_version_check CHECK (
    inventory_version IS NULL OR inventory_version IN (
      'ensemus.m3-m7/3','ensemus.m3-m7-federation/4','ensemus.skill-metadata/5',
      'ensemus.marketplace-publisher/6','ensemus.meeting-config/7','ensemus.meeting-history/8',
      'ensemus.business-records/9','ensemus.skill-upload-cleanup/10','ensemus.residency/11',
      'ensemus.skill-bundles/12','ensemus.sandbox-history/13'
    )
  );
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.portable_profile_clear(text)'::regprocedure);
  old_tail constant text:='''ensemus.skill-bundles/12'')';
  new_tail constant text:='''ensemus.skill-bundles/12'',''ensemus.sandbox-history/13'')';
  bundle_gate constant text:='p_profile<>''ensemus.skill-bundles/12''';
  sandbox_gate constant text:='EXISTS(SELECT 1 FROM sandbox.runs WHERE organization_id=tenant)';
  import_bundle_gate constant text:='header.manifest->>''inventory_version''=''ensemus.skill-bundles/12''';
BEGIN
  IF strpos(definition,old_tail)=0 OR strpos(definition,bundle_gate)=0 OR strpos(definition,sandbox_gate)=0 THEN
    RAISE EXCEPTION 'PORTABLE_SANDBOX_PROFILE_CHANGED' USING ERRCODE='EN301';
  END IF;
  definition:=replace(definition,old_tail,new_tail);
  definition:=replace(definition,bundle_gate,'p_profile NOT IN('||new_tail);
  definition:=replace(definition,sandbox_gate,$sql$
    EXISTS(SELECT 1 FROM sandbox.runs r WHERE r.organization_id=tenant
      AND (p_profile<>'ensemus.sandbox-history/13' OR r.status IN ('queued','running') OR r.finished_at IS NULL))
  $sql$);
  EXECUTE definition;

  definition:=pg_get_functiondef('sovereign.guard_export_inventory_pin()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_SANDBOX_PIN_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_export_viewer()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_SANDBOX_VIEW_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_business_page(text,uuid,integer)'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_SANDBOX_BUSINESS_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_skill_upload_cleanup_page(uuid,integer)'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_SANDBOX_CLEANUP_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.register_import_part(uuid,text,bytea)'::regprocedure);
  IF strpos(definition,import_bundle_gate)=0 THEN RAISE EXCEPTION 'PORTABLE_SANDBOX_IMPORT_CHANGED' USING ERRCODE='EN409'; END IF;
  EXECUTE replace(definition,import_bundle_gate,'header.manifest->>''schema_version''=''2'' AND header.manifest->>''inventory_version'' IN('||new_tail);
END $migration$;
--> statement-breakpoint
CREATE OR REPLACE VIEW sovereign.portable_residency_requirements WITH (security_barrier = true) AS
  SELECT r.organization_id,r.scope,r.region,r.version,r.set_by_membership_id,r.created_at,r.updated_at
  FROM tenancy.residency_requirements r
  WHERE r.organization_id=app.current_organization_id()
    AND session_user='ensemus_worker' AND knowledge.is_service_actor()
    AND sovereign.portable_export_viewer() IS NOT NULL
    AND EXISTS(SELECT 1 FROM sovereign.organization_exports e
      WHERE e.organization_id=r.organization_id AND e.id::text=current_setting('app.portability_export_id',true)
        AND e.inventory_version IN ('ensemus.residency/11','ensemus.skill-bundles/12','ensemus.sandbox-history/13')
        AND e.status='running');
--> statement-breakpoint
CREATE OR REPLACE VIEW sovereign.skill_bundle_export_scope WITH (security_barrier = true) AS
  SELECT e.organization_id,e.snapshot_at,e.inventory_version FROM sovereign.organization_exports e
  WHERE e.organization_id=app.current_organization_id() AND e.id::text=current_setting('app.portability_export_id',true)
    AND e.inventory_version IN ('ensemus.skill-bundles/12','ensemus.sandbox-history/13') AND e.status='running'
    AND session_user='ensemus_worker' AND knowledge.is_service_actor()
    AND sovereign.portable_export_viewer() IS NOT NULL;
--> statement-breakpoint
CREATE VIEW sovereign.portable_sandbox_run_receipts WITH (security_barrier = true) AS
  SELECT r.organization_id,r.id,r.skill_version_id,r.purpose,r.status,r.attempts,r.created_at,r.finished_at
  FROM sandbox.runs r JOIN sovereign.skill_bundle_export_scope s ON s.organization_id=r.organization_id
  WHERE s.inventory_version='ensemus.sandbox-history/13' AND r.finished_at<=s.snapshot_at
    AND r.status NOT IN ('queued','running')
    AND ((r.purpose='operator_test' AND r.requested_by_membership_id=sovereign.portable_export_viewer())
      OR (r.purpose='skill_test' AND r.fixture_signer_key_id IS NOT NULL));
REVOKE ALL ON sovereign.portable_sandbox_run_receipts FROM PUBLIC,ensemus_app;
GRANT SELECT ON sovereign.portable_sandbox_run_receipts TO ensemus_worker;
--> statement-breakpoint
-- A tenant-wide count reports omissions without carrying an operator identity, execution ID or payload.
CREATE FUNCTION sovereign.portable_sandbox_run_count() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT (SELECT count(*)::integer FROM sandbox.runs r
    WHERE r.organization_id=s.organization_id AND r.finished_at<=s.snapshot_at)
  FROM sovereign.skill_bundle_export_scope s WHERE s.inventory_version='ensemus.sandbox-history/13'
$function$;
REVOKE ALL ON FUNCTION sovereign.portable_sandbox_run_count() FROM PUBLIC,ensemus_app;
GRANT EXECUTE ON FUNCTION sovereign.portable_sandbox_run_count() TO ensemus_worker;
--> statement-breakpoint
DO $migration$
DECLARE
  kind_check text;
  definition text:=pg_get_functiondef('sovereign.guard_portable_definition()'::regprocedure);
  anchor constant text:='allowed:=string_to_array(CASE NEW.record_kind';
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT kind_check FROM pg_constraint
    WHERE conrelid='sovereign.imported_definitions'::regclass AND conname='imported_definitions_record_kind_check';
  ALTER TABLE sovereign.imported_definitions DROP CONSTRAINT imported_definitions_record_kind_check;
  EXECUTE 'ALTER TABLE sovereign.imported_definitions ADD CONSTRAINT imported_definitions_record_kind_check '
    ||'CHECK (('||kind_check||') OR (section=''skills'' AND record_kind=''sandbox_run_receipt''))';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_SANDBOX_QUARANTINE_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,anchor,anchor||$sql$
    WHEN 'sandbox_run_receipt' THEN 'kind,id,skill_version_id,purpose,status,attempts,created_at,finished_at'
  $sql$);
END $migration$;
--> statement-breakpoint
CREATE POLICY sandbox_run_receipt_review_custodian ON sovereign.imported_definitions
  AS RESTRICTIVE FOR SELECT TO ensemus_app USING (
    record_kind<>'sandbox_run_receipt' OR EXISTS(
      SELECT 1 FROM sovereign.organization_imports i WHERE i.organization_id=imported_definitions.organization_id
        AND i.id=imported_definitions.import_id AND i.fallback_membership_id=app.current_membership_id()
    )
  );
