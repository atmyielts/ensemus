-- FLAGGED FOR HUMAN SECURITY REVIEW
-- COMM-05 and EXP-02. Export abandoned tenant upload receipts after native deletion proof.
ALTER TABLE sovereign.organization_exports
  DROP CONSTRAINT organization_exports_inventory_version_check,
  ADD CONSTRAINT organization_exports_inventory_version_check CHECK (
    inventory_version IS NULL OR inventory_version IN (
      'ensemus.m3-m7/3','ensemus.m3-m7-federation/4','ensemus.skill-metadata/5',
      'ensemus.marketplace-publisher/6','ensemus.meeting-config/7','ensemus.meeting-history/8',
      'ensemus.business-records/9','ensemus.skill-upload-cleanup/10'
    )
  );
--> statement-breakpoint
CREATE VIEW sovereign.skill_upload_cleanup_proofs WITH (security_barrier = true) AS
  SELECT r.organization_id,r.id,r.package_id,r.membership_id,r.created_at,c.absent_at
  FROM skills.bundle_uploads r JOIN lifecycle.object_deletion_claims c
    ON c.organization_id=r.organization_id AND c.artifact_id=r.id AND c.kind='skill_upload'
  WHERE r.organization_id=app.current_organization_id() AND r.state='superseded'
    AND NOT r.marketplace_copy AND r.package_id IS NOT NULL AND lifecycle.skill_write_is_current(r)
    AND c.state='proven' AND c.skill_offboarding_id IS NULL
    AND c.object_key=r.organization_id::text||'/skills/'||r.id::text
    AND c.writer_token=r.id AND c.generation=1 AND c.sha256=r.bundle_sha256
    AND c.admitted_at>=r.put_finished_at AND c.terminal_at>=c.admitted_at AND c.absent_at>=c.terminal_at;
REVOKE ALL ON sovereign.skill_upload_cleanup_proofs FROM PUBLIC,ensemus_app,ensemus_worker;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.portable_profile_clear(text)'::regprocedure);
  old_tail constant text:='''ensemus.business-records/9'')';
  new_tail constant text:='''ensemus.business-records/9'',''ensemus.skill-upload-cleanup/10'')';
  business_gate constant text:='p_profile<>''ensemus.business-records/9''';
  upload_gate constant text:='EXISTS(SELECT 1 FROM skills.bundle_uploads WHERE organization_id=tenant)';
  business_page_gate constant text:='e.inventory_version=''ensemus.business-records/9''';
BEGIN
  IF strpos(definition,old_tail)=0 OR strpos(definition,business_gate)=0 OR strpos(definition,upload_gate)=0 THEN
    RAISE EXCEPTION 'PORTABLE_SKILL_CLEANUP_PROFILE_CHANGED' USING ERRCODE='EN301';
  END IF;
  definition:=replace(definition,old_tail,new_tail);
  definition:=replace(definition,business_gate,'p_profile NOT IN('||new_tail);
  definition:=replace(definition,upload_gate,$sql$
    EXISTS(SELECT 1 FROM skills.bundle_uploads r WHERE r.organization_id=tenant
      AND (p_profile<>'ensemus.skill-upload-cleanup/10' OR NOT EXISTS (
        SELECT 1 FROM sovereign.skill_upload_cleanup_proofs p
        WHERE p.organization_id=r.organization_id AND p.id=r.id)))
  $sql$);
  EXECUTE definition;

  definition:=pg_get_functiondef('sovereign.guard_export_inventory_pin()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_SKILL_CLEANUP_PIN_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_export_viewer()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_SKILL_CLEANUP_VIEW_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_business_page(text,uuid,integer)'::regprocedure);
  IF strpos(definition,business_page_gate)=0 THEN RAISE EXCEPTION 'PORTABLE_SKILL_CLEANUP_BUSINESS_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,business_page_gate,'e.inventory_version IN('||new_tail);
END $migration$;
--> statement-breakpoint
CREATE FUNCTION sovereign.portable_skill_upload_cleanup_page(p_after uuid,p_limit integer)
RETURNS TABLE (key uuid,record jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  tenant uuid:=app.current_organization_id();
  snapshot timestamptz;
BEGIN
  IF session_user<>'ensemus_worker' OR NOT knowledge.is_service_actor()
    OR tenant IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
    OR sovereign.portable_export_viewer() IS NULL THEN RETURN; END IF;
  SELECT e.snapshot_at INTO snapshot FROM sovereign.organization_exports e
    WHERE e.organization_id=tenant AND e.id::text=current_setting('app.portability_export_id',true)
      AND e.inventory_version='ensemus.skill-upload-cleanup/10' AND e.status='running';
  IF snapshot IS NULL THEN RETURN; END IF;

  RETURN QUERY SELECT p.id,jsonb_build_object('kind','skill_upload_cleanup_history',
    'id',p.id,'package_id',p.package_id,'membership_id',p.membership_id,
    'created_at',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'absent_at',to_char(p.absent_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  FROM sovereign.skill_upload_cleanup_proofs p
  WHERE p.organization_id=tenant AND p.absent_at<=snapshot AND (p_after IS NULL OR p.id>p_after)
  ORDER BY p.id LIMIT p_limit;
END $function$;
REVOKE ALL ON FUNCTION sovereign.portable_skill_upload_cleanup_page(uuid,integer) FROM PUBLIC,ensemus_app;
GRANT EXECUTE ON FUNCTION sovereign.portable_skill_upload_cleanup_page(uuid,integer) TO ensemus_worker;
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
    ||'CHECK (('||kind_check||') OR (section=''skills'' AND record_kind=''skill_upload_cleanup_history''))';
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_SKILL_CLEANUP_QUARANTINE_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,anchor,anchor||$sql$
    WHEN 'skill_upload_cleanup_history' THEN 'kind,id,package_id,membership_id,created_at,absent_at'
  $sql$);
END $migration$;
--> statement-breakpoint
CREATE POLICY skill_upload_cleanup_review_custodian ON sovereign.imported_definitions
  AS RESTRICTIVE FOR SELECT TO ensemus_app USING (
    record_kind<>'skill_upload_cleanup_history' OR EXISTS(
      SELECT 1 FROM sovereign.organization_imports i WHERE i.organization_id=imported_definitions.organization_id
        AND i.id=imported_definitions.import_id AND i.fallback_membership_id=app.current_membership_id()
    )
  );
