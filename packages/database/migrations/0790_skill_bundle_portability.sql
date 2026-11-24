-- FLAGGED FOR HUMAN SECURITY REVIEW
-- COMM-05 and EXP-02. Archive tenant-authored skill bundle originals and inert test receipts.
ALTER TABLE sovereign.organization_exports
  DROP CONSTRAINT organization_exports_inventory_version_check,
  ADD CONSTRAINT organization_exports_inventory_version_check CHECK (
    inventory_version IS NULL OR inventory_version IN (
      'ensemus.m3-m7/3','ensemus.m3-m7-federation/4','ensemus.skill-metadata/5',
      'ensemus.marketplace-publisher/6','ensemus.meeting-config/7','ensemus.meeting-history/8',
      'ensemus.business-records/9','ensemus.skill-upload-cleanup/10','ensemus.residency/11','ensemus.skill-bundles/12'
    )
  );
--> statement-breakpoint
CREATE VIEW sovereign.skill_bundle_export_proofs WITH (security_barrier = true) AS
  SELECT v.organization_id,v.id,v.package_id,v.uploaded_by_membership_id,v.state,v.semver,
    v.bundle_sha256,v.size_bytes,v.uploaded_at,v.updated_at
  FROM skills.package_versions v
  JOIN skills.packages p ON p.organization_id=v.organization_id AND p.id=v.package_id
  JOIN skills.bundle_uploads r ON r.organization_id=v.organization_id AND r.id=v.id
  WHERE v.organization_id=app.current_organization_id()
    AND p.origin='tenant' AND p.content_classification IN ('public','internal','confidential')
    AND v.state IN ('verified','published','yanked') AND v.semver IS NOT NULL
    AND v.uploaded_by_membership_id IS NOT NULL AND NOT r.marketplace_copy
    AND lifecycle.skill_write_is_current(r) AND lifecycle.skill_version_matches_upload(r,v)
    AND NOT EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c
      WHERE c.organization_id=r.organization_id AND c.kind='skill_upload' AND c.artifact_id=r.id);
REVOKE ALL ON sovereign.skill_bundle_export_proofs FROM PUBLIC,ensemus_app,ensemus_worker;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.portable_profile_clear(text)'::regprocedure);
  old_tail constant text:='''ensemus.residency/11'')';
  new_tail constant text:='''ensemus.residency/11'',''ensemus.skill-bundles/12'')';
  residency_gate constant text:='p_profile<>''ensemus.residency/11''';
  version_gate constant text:='EXISTS(SELECT 1 FROM skills.package_versions WHERE organization_id=tenant)';
  test_gate constant text:='EXISTS(SELECT 1 FROM skills.test_runs WHERE organization_id=tenant)';
  upload_proof constant text:='WHERE p.organization_id=r.organization_id AND p.id=r.id)))';
  residency_page_gate text:='e.inventory_version=''ensemus.residency/11''';
BEGIN
  IF strpos(definition,old_tail)=0 OR strpos(definition,residency_gate)=0
    OR strpos(definition,version_gate)=0 OR strpos(definition,test_gate)=0 OR strpos(definition,upload_proof)=0 THEN
    RAISE EXCEPTION 'PORTABLE_SKILL_BUNDLE_PROFILE_CHANGED' USING ERRCODE='EN301';
  END IF;
  definition:=replace(definition,old_tail,new_tail);
  definition:=replace(definition,residency_gate,'p_profile NOT IN('||new_tail);
  definition:=replace(definition,version_gate,$sql$
    EXISTS(SELECT 1 FROM skills.package_versions v WHERE v.organization_id=tenant
      AND (p_profile<>'ensemus.skill-bundles/12' OR NOT EXISTS(
        SELECT 1 FROM sovereign.skill_bundle_export_proofs p WHERE p.organization_id=v.organization_id AND p.id=v.id)))
  $sql$);
  definition:=replace(definition,test_gate,$sql$
    EXISTS(SELECT 1 FROM skills.test_runs t WHERE t.organization_id=tenant
      AND (p_profile<>'ensemus.skill-bundles/12' OR NOT EXISTS(
        SELECT 1 FROM sovereign.skill_bundle_export_proofs p WHERE p.organization_id=t.organization_id AND p.id=t.skill_version_id)))
  $sql$);
  definition:=replace(definition,upload_proof,$sql$
        WHERE p.organization_id=r.organization_id AND p.id=r.id)
        AND (p_profile<>'ensemus.skill-bundles/12' OR NOT EXISTS(
          SELECT 1 FROM sovereign.skill_bundle_export_proofs p WHERE p.organization_id=r.organization_id AND p.id=r.id))))
  $sql$);
  EXECUTE definition;

  definition:=pg_get_functiondef('sovereign.guard_export_inventory_pin()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_SKILL_BUNDLE_PIN_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_export_viewer()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_SKILL_BUNDLE_VIEW_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_business_page(text,uuid,integer)'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_SKILL_BUNDLE_BUSINESS_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_skill_upload_cleanup_page(uuid,integer)'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_SKILL_BUNDLE_CLEANUP_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_viewdef('sovereign.portable_residency_requirements'::regclass);
  IF strpos(definition,residency_page_gate)=0 THEN
    -- PostgreSQL emits casts and whitespace when it deparses a view.
    residency_page_gate:='e.inventory_version = ''ensemus.residency/11''::text';
  END IF;
  IF strpos(definition,residency_page_gate)=0 THEN RAISE EXCEPTION 'PORTABLE_SKILL_BUNDLE_RESIDENCY_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW sovereign.portable_residency_requirements WITH (security_barrier=true) AS '
    ||replace(definition,residency_page_gate,'e.inventory_version IN('||new_tail);
END $migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sovereign.portable_residency_storage_matches(p_region text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT session_user='ensemus_worker' AND knowledge.is_service_actor()
    AND app.current_organization_id() IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM tenancy.residency_requirements r
      WHERE r.organization_id=app.current_organization_id()
        AND (r.region IS DISTINCT FROM p_region OR NOT EXISTS(
          SELECT 1 FROM tenancy.deployment_profile p WHERE p.singleton AND p.home_region=p_region)))
$function$;
--> statement-breakpoint
CREATE VIEW sovereign.skill_bundle_export_scope WITH (security_barrier = true) AS
  SELECT e.organization_id,e.snapshot_at FROM sovereign.organization_exports e
  WHERE e.organization_id=app.current_organization_id() AND e.id::text=current_setting('app.portability_export_id',true)
    AND e.inventory_version='ensemus.skill-bundles/12' AND e.status='running'
    AND session_user='ensemus_worker' AND knowledge.is_service_actor()
    AND sovereign.portable_export_viewer() IS NOT NULL;
REVOKE ALL ON sovereign.skill_bundle_export_scope FROM PUBLIC,ensemus_app,ensemus_worker;
--> statement-breakpoint
CREATE FUNCTION sovereign.portable_skill_bundle_page(p_kind text,p_after uuid,p_limit integer)
RETURNS TABLE (key uuid,record jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  tenant uuid:=app.current_organization_id();
  snapshot timestamptz;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('bundle','test')
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RETURN; END IF;
  SELECT s.snapshot_at INTO snapshot FROM sovereign.skill_bundle_export_scope s WHERE s.organization_id=tenant;
  IF snapshot IS NULL THEN RETURN; END IF;
  IF p_kind='bundle' THEN
    RETURN QUERY SELECT p.id,jsonb_build_object('kind','skill_bundle_version',
      'id',p.id,'package_id',p.package_id,'uploaded_by_membership_id',p.uploaded_by_membership_id,
      'state',p.state,'semver',p.semver,'bundle_sha256',p.bundle_sha256,'size_bytes',p.size_bytes,
      'uploaded_at',to_char(p.uploaded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'updated_at',to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    FROM sovereign.skill_bundle_export_proofs p
    WHERE p.organization_id=tenant AND p.uploaded_at<=snapshot AND (p_after IS NULL OR p.id>p_after)
    ORDER BY p.id LIMIT p_limit;
  ELSE
    RETURN QUERY SELECT t.id,jsonb_build_object('kind','skill_test_history',
      'id',t.id,'skill_version_id',t.skill_version_id,'mode',t.mode,'outcome',t.outcome,
      'fixtures_total',t.fixtures_total,'fixtures_passed',t.fixtures_passed,'first_failed_fixture',t.first_failed_fixture,
      'started_at',to_char(t.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'finished_at',to_char(t.finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    FROM skills.test_runs t JOIN sovereign.skill_bundle_export_proofs p
      ON p.organization_id=t.organization_id AND p.id=t.skill_version_id
    WHERE t.organization_id=tenant AND t.finished_at<=snapshot AND (p_after IS NULL OR t.id>p_after)
    ORDER BY t.id LIMIT p_limit;
  END IF;
END $function$;
REVOKE ALL ON FUNCTION sovereign.portable_skill_bundle_page(text,uuid,integer) FROM PUBLIC,ensemus_app;
GRANT EXECUTE ON FUNCTION sovereign.portable_skill_bundle_page(text,uuid,integer) TO ensemus_worker;
--> statement-breakpoint
CREATE FUNCTION sovereign.portable_skill_bundles_confirm(p_ids uuid[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT cardinality(p_ids)=1 AND EXISTS(
    SELECT 1 FROM sovereign.skill_bundle_export_scope s JOIN sovereign.skill_bundle_export_proofs p
      ON p.organization_id=s.organization_id AND p.uploaded_at<=s.snapshot_at
    WHERE p.id=p_ids[1])
$function$;
REVOKE ALL ON FUNCTION sovereign.portable_skill_bundles_confirm(uuid[]) FROM PUBLIC,ensemus_app;
GRANT EXECUTE ON FUNCTION sovereign.portable_skill_bundles_confirm(uuid[]) TO ensemus_worker;
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
    ||'CHECK (('||kind_check||') OR (section=''skills'' AND record_kind IN (''skill_bundle_version'',''skill_test_history'')))';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_SKILL_BUNDLE_QUARANTINE_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,anchor,anchor||$sql$
    WHEN 'skill_bundle_version' THEN 'kind,id,package_id,uploaded_by_membership_id,state,semver,bundle_sha256,size_bytes,uploaded_at,updated_at'
    WHEN 'skill_test_history' THEN 'kind,id,skill_version_id,mode,outcome,fixtures_total,fixtures_passed,first_failed_fixture,started_at,finished_at'
  $sql$);
END $migration$;
--> statement-breakpoint
CREATE POLICY skill_bundle_review_custodian ON sovereign.imported_definitions
  AS RESTRICTIVE FOR SELECT TO ensemus_app USING (
    record_kind NOT IN ('skill_bundle_version','skill_test_history') OR EXISTS(
      SELECT 1 FROM sovereign.organization_imports i WHERE i.organization_id=imported_definitions.organization_id
        AND i.id=imported_definitions.import_id AND i.fallback_membership_id=app.current_membership_id()
    )
  );
