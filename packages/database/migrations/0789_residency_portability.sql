-- FLAGGED FOR HUMAN SECURITY REVIEW
-- COMM-05 and EXP-09. Preserve source residency rules without installing them in a receiving tenant.
ALTER TABLE sovereign.organization_exports
  DROP CONSTRAINT organization_exports_inventory_version_check,
  ADD CONSTRAINT organization_exports_inventory_version_check CHECK (
    inventory_version IS NULL OR inventory_version IN (
      'ensemus.m3-m7/3','ensemus.m3-m7-federation/4','ensemus.skill-metadata/5',
      'ensemus.marketplace-publisher/6','ensemus.meeting-config/7','ensemus.meeting-history/8',
      'ensemus.business-records/9','ensemus.skill-upload-cleanup/10','ensemus.residency/11'
    )
  );
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.portable_profile_clear(text)'::regprocedure);
  old_tail constant text:='''ensemus.skill-upload-cleanup/10'')';
  new_tail constant text:='''ensemus.skill-upload-cleanup/10'',''ensemus.residency/11'')';
  upload_gate constant text:='p_profile<>''ensemus.skill-upload-cleanup/10''';
  residency_gate constant text:='EXISTS(SELECT 1 FROM tenancy.residency_requirements WHERE organization_id=tenant)';
  upload_page_gate constant text:='e.inventory_version=''ensemus.skill-upload-cleanup/10''';
BEGIN
  IF strpos(definition,old_tail)=0 OR strpos(definition,upload_gate)=0 OR strpos(definition,residency_gate)=0 THEN
    RAISE EXCEPTION 'PORTABLE_RESIDENCY_PROFILE_CHANGED' USING ERRCODE='EN301';
  END IF;
  definition:=replace(definition,old_tail,new_tail);
  definition:=replace(definition,upload_gate,'p_profile NOT IN('||new_tail);
  definition:=replace(definition,residency_gate,$sql$
    EXISTS(SELECT 1 FROM tenancy.residency_requirements r WHERE r.organization_id=tenant
      AND (p_profile<>'ensemus.residency/11' OR NOT EXISTS(
        SELECT 1 FROM tenancy.deployment_profile p WHERE p.singleton AND p.home_region=r.region)))
  $sql$);
  EXECUTE definition;

  definition:=pg_get_functiondef('sovereign.guard_export_inventory_pin()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_RESIDENCY_PIN_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_export_viewer()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_RESIDENCY_VIEW_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_business_page(text,uuid,integer)'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_RESIDENCY_BUSINESS_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_skill_upload_cleanup_page(uuid,integer)'::regprocedure);
  IF strpos(definition,upload_page_gate)=0 THEN RAISE EXCEPTION 'PORTABLE_RESIDENCY_UPLOAD_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,upload_page_gate,'e.inventory_version IN('||new_tail);
END $migration$;
--> statement-breakpoint
-- A whole-tenant archive may contain several classifications. Each requirement must match the
-- worker's declared archive storage region and the database's current deployment profile.
CREATE FUNCTION sovereign.portable_residency_storage_matches(p_region text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT session_user='ensemus_worker' AND knowledge.is_service_actor()
    AND app.current_organization_id() IS NOT NULL AND p_region IS NOT NULL
    AND EXISTS(SELECT 1 FROM tenancy.deployment_profile p WHERE p.singleton AND p.home_region=p_region)
    AND NOT EXISTS(SELECT 1 FROM tenancy.residency_requirements r
      WHERE r.organization_id=app.current_organization_id() AND r.region<>p_region)
$function$;
REVOKE ALL ON FUNCTION sovereign.portable_residency_storage_matches(text) FROM PUBLIC,ensemus_app;
GRANT EXECUTE ON FUNCTION sovereign.portable_residency_storage_matches(text) TO ensemus_worker;
--> statement-breakpoint
CREATE VIEW sovereign.portable_residency_requirements WITH (security_barrier = true) AS
  SELECT r.organization_id,r.scope,r.region,r.version,r.set_by_membership_id,r.created_at,r.updated_at
  FROM tenancy.residency_requirements r
  WHERE r.organization_id=app.current_organization_id()
    AND session_user='ensemus_worker' AND knowledge.is_service_actor()
    AND sovereign.portable_export_viewer() IS NOT NULL
    AND EXISTS(SELECT 1 FROM sovereign.organization_exports e
      WHERE e.organization_id=r.organization_id AND e.id::text=current_setting('app.portability_export_id',true)
        AND e.inventory_version='ensemus.residency/11' AND e.status='running');
REVOKE ALL ON sovereign.portable_residency_requirements FROM PUBLIC,ensemus_app;
GRANT SELECT ON sovereign.portable_residency_requirements TO ensemus_worker;
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
    ||'CHECK (('||kind_check||') OR (section=''policy'' AND record_kind=''residency_requirement''))';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_RESIDENCY_QUARANTINE_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,anchor,anchor||$sql$
    WHEN 'residency_requirement' THEN 'kind,id,scope,region,version,set_by_membership_id,created_at,updated_at'
  $sql$);
END $migration$;
--> statement-breakpoint
CREATE POLICY residency_requirement_review_custodian ON sovereign.imported_definitions
  AS RESTRICTIVE FOR SELECT TO ensemus_app USING (
    record_kind<>'residency_requirement' OR EXISTS(
      SELECT 1 FROM sovereign.organization_imports i WHERE i.organization_id=imported_definitions.organization_id
        AND i.id=imported_definitions.import_id AND i.fallback_membership_id=app.current_membership_id()
    )
  );
